'use strict';
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const { Client, utils } = require('ssh2');
const { SharedTerminal } = require('./shared-terminal.cjs');
const { Store } = require('./store.cjs');
const { LIMITS, fail, validateProfile, validateCredentials, inspectCommand } = require('./policy.cjs');
const FINAL = new Set(['completed', 'failed', 'cancelled', 'invalidated', 'unknown', 'interrupted', 'blocked']);
// Strip terminal control sequences across packet boundaries. The core emits text
// only, so remote OSC clipboard/link/title commands never reach application APIs.
class OutputFilter {
  constructor() { this.decoder = new StringDecoder('utf8'); this.state = 'text'; this.sequence = ''; }
  push(data) {
    let out = '';
    for (const ch of this.decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
      const n = ch.charCodeAt(0);
      if (this.state === 'string') { if (ch === '\x07' || ch === '\x9c') this.state = 'text'; else if (ch === '\x1b') this.state = 'string-escape'; continue; }
      if (this.state === 'string-escape') { this.state = ch === '\\' ? 'text' : 'string'; continue; }
      if (this.state === 'csi') {
        this.sequence += ch;
        if (this.sequence.length > 128) { this.sequence = ''; this.state = 'discard-csi'; continue; }
        if (n >= 0x40 && n <= 0x7e) {
          if (/^\x1b\[[0-9;]*[mABCDEFGHJKSTfhsul]$/.test(this.sequence) || /^\x1b\[\?(?:25|1049|2004)[hl]$/.test(this.sequence)) out += this.sequence;
          this.state = 'text'; this.sequence = '';
        }
        continue;
      }
      if (this.state === 'discard-csi') { if (n >= 0x40 && n <= 0x7e) this.state = 'text'; continue; }
      if (this.state === 'escape') {
        if (ch === '[') this.sequence = '\x1b[';
        if (['7', '8', 'D', 'E', 'M'].includes(ch)) out += '\x1b' + ch;
        this.state = ch === '[' ? 'csi' : [']', 'P', '^', '_', 'X'].includes(ch) ? 'string' : n >= 0x20 && n <= 0x2f ? 'escape' : 'text'; continue;
      }
      if (ch === '\x1b') { this.state = 'escape'; continue; }
      if (ch === '\x9b') { this.state = 'csi'; this.sequence = '\x1b['; continue; }
      if (['\x90', '\x9d', '\x9e', '\x9f'].includes(ch)) { this.state = 'string'; continue; }
      if ((n < 32 && !['\n', '\r', '\t', '\b'].includes(ch)) || (n >= 127 && n <= 159)) continue;
      out += ch;
    }
    return out;
  }
}
function errorCode(e) {
  if (e?.code?.startsWith('E-')) return e.code;
  if (e?.level === 'client-authentication') return 'E-SSH-AUTH';
  return ({ ECONNREFUSED: 'E-SSH-REFUSED', ENOTFOUND: 'E-SSH-DNS', ETIMEDOUT: 'E-SSH-TIMEOUT' })[e?.code] || (e?.level === 'client-timeout' ? 'E-SSH-TIMEOUT' : 'E-SSH-NETWORK');
}
class SSHService extends EventEmitter {
  constructor({ userDataPath, store, sharedTerminal = false, clientFactory = () => new Client(), readyTimeout = 120000, shellTimeout = 15000, execOpenTimeout = 15000, keepaliveInterval = 15000, keepaliveCountMax = 3, maxActiveSessions = 16, maxSessionHistory = 64, maxActiveExecutions = 32, maxExecutionHistory = 128 } = {}) {
    super(); this.sharedTerminal = sharedTerminal; this.store = store || new Store(userDataPath); this.clientFactory = clientFactory; this.readyTimeout = readyTimeout;
    for (const [name, value] of Object.entries({ shellTimeout, execOpenTimeout, keepaliveInterval, keepaliveCountMax, maxActiveSessions, maxSessionHistory, maxActiveExecutions, maxExecutionHistory })) {
      if (!Number.isSafeInteger(value) || value < 1) fail('E-SERVICE-OPTIONS'); this[name] = value;
    }
    this.sessions = new Map(); this.challenges = new Map(); this.tokens = new Map(); this.executions = new Map(); this.disposed = false; this.execTimers = new Map(); this.outputSources = new Set(); this.outputFlights = new Map(); this.outputBytes = 0; this.outputLimit = 65536; this.outputMessageLimit = 128; this.outputAcknowledged = false;
  }
  _view(s) { return { sessionId: s.id, generation: s.generation, ...s.profile, status: s.status, executionBlocked: !!s.execBlocked, sharedTerminal: this.sharedTerminal, terminalReady: !!s.shared?.ready, terminalInputLocked: !!s.shared?.owner, terminalIntegration: s.shared?.unsupported ? 'unsupported' : s.shared?.initializing ? 'initializing' : s.shared?.owner ? 'ai' : s.shared?.ready ? 'ready' : 'manual', fingerprint: s.fingerprint || null, keyType: s.keyType || null, remoteAddress: s.client?._sock?.remoteAddress || s.remoteAddress || null, remotePort: s.client?._sock?.remotePort || s.remotePort || null, error: s.error || null }; }
  _state(s, status, error) { s.status = status; s.error = error; this.emit('session', this._view(s)); }
  async connect(input, supplied) {
    if (this.disposed) fail('E-SERVICE-DISPOSED');
    if ([...this.sessions.values()].filter(s => !s.ended).length >= this.maxActiveSessions) fail('E-SSH-ACTIVE-LIMIT');
    const profile = validateProfile(input), credentials = validateCredentials(supplied);
    let auth;
    if (credentials.type === 'privateKey') {
      let key;
      try {
        const fd = fs.openSync(credentials.privateKeyPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
        try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > LIMITS.privateKey) fail('E-SSH-KEY-FILE'); key = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
      } catch { fail('E-SSH-KEY-FILE'); }
      const parsed = utils.parseKey(key, credentials.passphrase);
      if (parsed instanceof Error || (Array.isArray(parsed) && (parsed.length !== 1 || !parsed[0]?.getPrivatePEM?.())) || (!Array.isArray(parsed) && !parsed?.getPrivatePEM?.())) { key.fill(0); fail('E-SSH-KEY-FORMAT'); }
      auth = { privateKey: key, passphrase: credentials.passphrase };
    } else auth = { password: credentials.password };
    const s = { id: randomUUID(), generation: randomUUID(), profile, status: 'connecting', client: this.clientFactory(), shell: null, ended: false };
    const client = s.client;
    this.sessions.set(s.id, s);
    return new Promise((resolve, reject) => {
      let settled = false, shellTimer;
      const clearAuth = () => {
        for (const values of [auth, credentials, client.config]) if (values) {
          if (Buffer.isBuffer(values.privateKey)) values.privateKey.fill(0);
          delete values.privateKey; delete values.password; delete values.passphrase;
        }
      };
      const rejectOnce = code => { if (!settled) { settled = true; clearAuth(); const e = new Error(code); e.code = code; e.sessionId = s.id; reject(e); } };
      s.finish = (status, code) => {
        if (s.ended) return; s.ended = true; s.shared?.dispose(); clearTimeout(shellTimer); clearAuth();
        s.remoteAddress = client._sock?.remoteAddress || null; s.remotePort = client._sock?.remotePort || null;
        for (const [id, c] of this.challenges) if (c.session === s) { this.challenges.delete(id); c.verify(false); }
        this._invalidate(s);
        this._state(s, status, code); rejectOnce(code || 'E-SSH-DISCONNECTED');
        s.client = null; s.shell = null; s.finish = null; client.destroy(); this._prune();
      };
      client.on('error', e => { s.finish?.('failed', errorCode(e)); client.destroy(); });
      client.on('close', () => s.finish?.('disconnected'));
      client.on('end', () => s.finish?.('disconnected'));
      client.on('ready', () => {
        clearAuth();
        if (s.ended) return;
        shellTimer = setTimeout(() => s.finish?.('failed', 'E-SSH-SHELL-TIMEOUT'), this.shellTimeout);
        client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
          clearTimeout(shellTimer);
          if (s.ended) { stream?.close(); return; }
          if (err) { s.finish?.('failed', 'E-SSH-SHELL'); client.destroy(); return; }
          s.shell = stream;
          if (this.sharedTerminal) s.shared = new SharedTerminal({ write: data => stream.write(data), changed: () => { if (!s.ended) this._state(s, s.status, s.error); }, output: (data, id, synthetic) => s.sharedOutput?.(data, id, synthetic), finished: (id, status, extra) => { const e = this.executions.get(id); if (e && !FINAL.has(e.status)) this._change(e, status, extra); } });
          this._output(s, stream, 'terminal');
          stream.on('close', () => { s.finish?.('disconnected'); client.end(); });
          stream.on('error', () => { s.finish?.('failed', 'E-SSH-SHELL'); client.destroy(); });
          this._state(s, 'connected'); s.shared?.initialize(); if (!settled) { settled = true; resolve(this._view(s)); }
        });
      });
      const hostVerifier = (key, verify) => {
        if (s.ended) return verify(false);
        try {
          const size = key.readUInt32BE(0);
          if (size > 128 || key.length < size + 4) fail('E-SSH-HOSTKEY');
          s.keyType = key.subarray(4, 4 + size).toString('ascii');
          s.fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          const host = { host: profile.host, port: profile.port, keyType: s.keyType, fingerprint: s.fingerprint };
          const known = this.store.getKnownHost(profile.host, profile.port);
          if (known) {
            if (known.fingerprint !== host.fingerprint || known.keyType !== host.keyType) { s.finish?.('failed', 'E-SSH-HOSTKEY-CHANGED'); verify(false); return; }
            this._state(s, 'authenticating'); verify(true); return;
          }
          const challengeId = randomUUID(); this.challenges.set(challengeId, { session: s, host, verify });
          this._state(s, 'host-key-required');
          this.emit('host-key', { challengeId, ...this._view(s), instruction: 'Verify this fingerprint through a separate trusted channel.' });
        } catch (e) { s.finish?.('failed', errorCode(e)); verify(false); }
      };
      this._state(s, 'connecting');
      try { client.connect({ host: profile.host, port: profile.port, username: profile.username, ...auth, readyTimeout: this.readyTimeout, keepaliveInterval: this.keepaliveInterval, keepaliveCountMax: this.keepaliveCountMax, tryKeyboard: false, hostVerifier }); }
      catch (e) { s.finish?.('failed', errorCode(e)); client.destroy(); }
    });
  }
  answerHostKey(challengeId, trust) {
    if (typeof trust !== 'boolean') fail('E-SSH-HOSTKEY-ANSWER');
    const c = this.challenges.get(challengeId); if (!c || c.session.ended) fail('E-SSH-HOSTKEY-STALE');
    this.challenges.delete(challengeId);
    if (!trust) { c.session.finish?.('disconnected', 'E-SSH-HOSTKEY-CANCELLED'); c.verify(false); return false; }
    try { this.store.trustHost(c.host); }
    catch (e) { c.session.finish?.('failed', errorCode(e)); c.verify(false); throw e; }
    this._state(c.session, 'authenticating'); c.verify(true); return true;
  }
  _connected(id) { const s = this.sessions.get(id); if (!s || s.ended || s.status !== 'connected') fail('E-SSH-NOT-CONNECTED'); return s; }
  disconnect(id) { const s = this.sessions.get(id); if (!s) fail('E-SSH-SESSION'); if (!s.ended) { s.finish?.('disconnected'); } }
  write(id, data) { const s = this._connected(id); if (typeof data !== 'string' || Buffer.byteLength(data) > LIMITS.input || data.includes('\0')) fail('E-TERM-INPUT'); if (s.shared?.owner) fail('E-TERM-AI-BUSY'); s.shared?.manual(data); return { accepted: s.shell.write(data), multiline: /[\r\n]/.test(data), controlCharacters: /[\x00-\x08\x0b-\x1f\x7f]/.test(data) }; }
  takeControl(id) { const s = this._connected(id); s.shared?.takeControl(); return { requested: true }; }
  resize(id, cols, rows) { const s = this._connected(id); if (![cols, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000)) fail('E-TERM-SIZE'); s.shell.setWindow(rows, cols, 0, 0); }
  // Production requires consumption ACKs. Core consumers can keep synchronous delivery.
  setOutputConsumer(enabled) { this.outputAcknowledged = enabled; }
  outputStats() { return { inFlightBytes: this.outputBytes, limit: this.outputLimit, inFlightMessages: this.outputFlights.size, messageLimit: this.outputMessageLimit, pendingBytes: [...this.outputSources].reduce((n, x) => n + Buffer.byteLength(x.pending), 0), pausedSources: [...this.outputSources].filter(x => x.source.isPaused()).length }; }
  ackOutput(id) { const flight = this.outputFlights.get(id); if (!flight) return; this.outputFlights.delete(id); this.outputBytes -= flight.bytes; this._drainOutput(); }
  _drainOutput() {
    if (this.drainingOutput) return; this.drainingOutput = true;
    try {
      for (const item of this.outputSources) {
        while (item.pending) {
          const length = item.pending.length > 4096 && /[\uD800-\uDBFF]/.test(item.pending[4095]) ? 4095 : 4096;
          const data = item.pending.slice(0, length), bytes = Buffer.byteLength(data);
          if (this.outputAcknowledged && (this.outputBytes + bytes > this.outputLimit || this.outputFlights.size >= this.outputMessageLimit)) break;
          item.pending = item.pending.slice(data.length);
          const ackId = this.outputAcknowledged ? randomUUID() : null;
          if (ackId) { this.outputFlights.set(ackId, { bytes, sessionId: item.s.id }); this.outputBytes += bytes; }
          this.emit('output', { sessionId: item.s.id, generation: item.s.generation, channel: item.channel, executionId: item.executionId || null, stream: item.kind, data, untrusted: true, ackId });
        }
        if (item.closed && !item.pending) this.outputSources.delete(item);
      }
      const blocked = [...this.outputSources].some(x => x.pending) || (this.outputAcknowledged && (this.outputBytes >= this.outputLimit - 16384 || this.outputFlights.size >= this.outputMessageLimit));
      for (const item of this.outputSources) if (!item.closed) blocked ? item.source.pause() : item.source.resume();
    } finally { this.drainingOutput = false; }
  }
  _output(s, stream, channel, executionId) {
    const attach = (source, kind) => {
      if (!source) return;
      const filter = new OutputFilter(), item = { source, s, channel, executionId, kind, pending: '', closed: false };
      this.outputSources.add(item);
      const output = (chunk, ownerId = executionId, synthetic = false) => { const data = filter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); if (!synthetic) this.emit('observed-output', { sessionId: s.id, generation: s.generation, channel: ownerId ? 'execution' : channel, executionId: ownerId || null, stream: kind, data, untrusted: true }); item.pending += data; this._drainOutput(); };
      if (s.shared && channel === 'terminal' && kind === 'stdout') s.sharedOutput = output;
      source.on('data', chunk => { source.pause(); if (s.shared && channel === 'terminal' && kind === 'stdout') { s.shared.push(chunk); this._drainOutput(); } else output(chunk); });
      source.on('end', () => { item.closed = true; this._drainOutput(); });
      source.on('close', () => { item.closed = true; this._drainOutput(); });
    };
    attach(stream, 'stdout'); attach(stream.stderr, 'stderr');
  }
  discardOutput(sessionId) {
    let discarded = 0;
    for (const [id, flight] of this.outputFlights) if (flight.sessionId === sessionId) { discarded += flight.bytes; this.outputBytes -= flight.bytes; this.outputFlights.delete(id); }
    for (const item of this.outputSources) if (item.s.id === sessionId) { discarded += Buffer.byteLength(item.pending); item.pending = ''; item.closed = true; this.outputSources.delete(item); }
    this._drainOutput(); return discarded;
  }
  clearOutput() {
    const discardedBytes = this.outputBytes + [...this.outputSources].reduce((n, x) => n + Buffer.byteLength(x.pending), 0);
    this.outputSources.clear(); this.outputFlights.clear(); this.outputBytes = 0;
    return discardedBytes;
  }
  prepareExecution(id, command, { shared = this.sharedTerminal } = {}) {
    const s = this._connected(id), policy = inspectCommand(command);
    if (shared && (!s.shared?.ready || s.shared.owner)) fail('E-TERM-NOT-READY');
    if (shared) policy.limitations = ['Uses the current interactive terminal directory and environment.', 'PTY output combines stdout and stderr.', 'Execution waits for a confirmed shell prompt.']; if (s.execBlocked) fail('E-EXEC-RECONNECT-REQUIRED');
    // Editing/replacing a proposal invalidates the previous pending confirmation.
    for (const e of this.executions.values()) if (e.sessionId === id && e.status === 'pending') this._change(e, 'invalidated');
    if ([...this.executions.values()].filter(e => !FINAL.has(e.status)).length >= this.maxActiveExecutions) fail('E-EXEC-ACTIVE-LIMIT');
    const execution = { id: randomUUID(), token: policy.allowed ? randomUUID() : null, sessionId: id, generation: s.generation, command, target: this._view(s), context: { channel: shared ? 'shared-terminal' : 'ssh-exec', environment: shared ? 'current-interactive-shell' : 'server-default-login', inheritsTerminal: shared, cwd: null, shell: null, effectivePrivileges: null }, policy, status: policy.allowed ? 'pending' : 'blocked' };
    if (typeof command !== 'string' || Buffer.byteLength(command) > LIMITS.command) fail('E-EXEC-SIZE');
    if (execution.token) this.tokens.set(execution.token, execution.id);
    this.executions.set(execution.id, execution); this._prune(); this.emit('execution', structuredClone(execution)); return structuredClone(execution);
  }
  _change(e, status, extra = {}) { if (FINAL.has(status)) { clearTimeout(this.execTimers.get(e.id)); this.execTimers.delete(e.id); } e.status = status; Object.assign(e, extra); if (e.token) this.tokens.delete(e.token); if (FINAL.has(status)) delete e.stream; this._prune(); this.emit('execution', structuredClone(this._executionView(e))); }
  _executionView(e) { const { stream, ...view } = e; return view; }
  approveExecution(token) {
    const id = this.tokens.get(token), e = this.executions.get(id);
    if (!e || e.status !== 'pending') fail('E-EXEC-STALE');
    const s = this._connected(e.sessionId); if (s.execBlocked) fail('E-EXEC-RECONNECT-REQUIRED');
    if (s.generation !== e.generation || !inspectCommand(e.command).allowed) { this._change(e, 'invalidated'); fail('E-EXEC-STALE'); }
    if (e.context.channel === 'shared-terminal') {
      if (!s.shared?.ready || s.shared.owner) { this._change(e, 'invalidated'); fail('E-TERM-NOT-READY'); }
      this._change(e, 'running');
      try { if (!s.shared.start(e.id, e.command)) { this._change(e, 'invalidated'); fail('E-TERM-NOT-READY'); } } catch (error) { if (!FINAL.has(e.status)) this._change(e, 'unknown', { error: 'E-EXEC-UNKNOWN' }); throw error; }
      return { executionId: e.id, status: e.status };
    }
    this._change(e, 'running'); // consume synchronously before opening the channel
    this.execTimers.set(e.id, setTimeout(() => { s.execBlocked = true; this._change(e, 'unknown', { error: 'E-EXEC-OPEN-TIMEOUT', remoteTerminationConfirmed: false }); for (const pending of this.executions.values()) if (pending.sessionId === s.id && pending.status === 'pending') this._change(pending, 'invalidated'); this._state(s, s.status, s.error); }, this.execOpenTimeout));
    try {
      s.client.exec(e.command, { pty: false }, (err, stream) => {
        clearTimeout(this.execTimers.get(e.id)); this.execTimers.delete(e.id);
        if (err) { if (!FINAL.has(e.status)) this._change(e, 'unknown', { error: 'E-EXEC-UNKNOWN' }); return; }
        if (FINAL.has(e.status)) { stream.close(); return; }
        e.stream = stream; this._output(s, stream, 'execution', e.id);
        stream.on('exit', (code, signal) => { e.exitCode = Number.isInteger(code) ? code : null; e.signal = signal || null; });
        stream.on('error', () => { if (!FINAL.has(e.status)) this._change(e, 'unknown', { error: 'E-EXEC-UNKNOWN' }); });
        stream.on('close', () => { if (FINAL.has(e.status)) return; this._change(e, Number.isInteger(e.exitCode) ? (e.exitCode === 0 ? 'completed' : 'failed') : (e.status === 'cancel-requested' && e.signal ? 'interrupted' : 'unknown')); });
        // Keep writable open for SSH signal requests; never write exec stdin.
        if (e.status === 'cancel-requested') { stream.signal('TERM'); }
      });
    } catch { this._change(e, 'unknown', { error: 'E-EXEC-UNKNOWN' }); }
    return { executionId: e.id, status: e.status };
  }
  cancelExecution(id) {
    const e = this.executions.get(id); if (!e) fail('E-EXEC-ID');
    if (e.status === 'pending') this._change(e, 'cancelled');
    else if (e.status === 'running') { this._change(e, 'cancel-requested', { remoteTerminationConfirmed: false }); try { if (e.context.channel === 'shared-terminal') this.sessions.get(e.sessionId)?.shared?.interrupt(); else e.stream?.signal('TERM'); } catch { this._change(e, 'unknown'); } }
    return structuredClone(this._executionView(e));
  }
  _invalidate(s) { for (const e of this.executions.values()) if (e.sessionId === s.id) { if (e.status === 'pending') this._change(e, 'invalidated'); else if (['running', 'cancel-requested'].includes(e.status)) this._change(e, 'unknown', { error: 'E-EXEC-UNKNOWN' }); } }
  _prune() {
    for (const [map, done, max] of [[this.sessions, s => s.ended, this.maxSessionHistory], [this.executions, e => FINAL.has(e.status), this.maxExecutionHistory]]) {
      let count = [...map.values()].filter(done).length;
      for (const [id, value] of map) if (count > max && done(value)) { map.delete(id); count--; }
    }
  }
  listSessions() { return [...this.sessions.values()].map(s => this._view(s)); }
  dispose() { if (this.disposed) return; this.disposed = true; for (const s of this.sessions.values()) this.disconnect(s.id); this.tokens.clear(); this.challenges.clear(); this.executions.clear(); this.sessions.clear(); for (const timer of this.execTimers.values()) clearTimeout(timer); this.execTimers.clear(); this.clearOutput(); }
}
module.exports = { SSHService, OutputFilter };

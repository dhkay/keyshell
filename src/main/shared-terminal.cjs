'use strict';
const { randomBytes } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
// Protocol frames are removed before terminal rendering. A fresh shell prompt is
// required after both manual input and AI commands; inactivity is never readiness.
class SharedTerminal {
  constructor({ write, output, changed, finished, initTimeoutMs = 8000 }) {
    Object.assign(this, { write, output, changed, finished }); this.secret = randomBytes(24).toString('hex'); this.decoder = new StringDecoder('utf8');
    this.ready = false; this.initializing = true; this.owner = null; this.frame = null; this.initial = '';
    this.timer = setTimeout(() => { this.initializing = false; this.unsupported = true; this.flushInitial(); this.changed(); }, initTimeoutMs); this.timer.unref?.();
  }
  initialize() {
    const prompt = `KS:${this.secret}:P`, initialized = `KS:${this.secret}:I`;
    // Preserve visible PS1 and existing prompt hooks. Integration lives only in
    // this shell process and never edits remote startup files.
    const hook = `__ks_prompt_${this.secret}`, finish = `__ks_finish_${this.secret}`;
    const definitions = `${hook}() { local __ks_rc=$?; builtin printf '\\036${prompt}\\037'; return "$__ks_rc"; }; ${finish}() { builtin printf '\\036KS:${this.secret}:D:%s:%s\\037' "$2" "$1"; return "$1"; }`;
    this.write(` : '__KS_INIT_${this.secret}'; if [ -n "\${BASH_VERSION-}" ]; then builtin eval ${quote(definitions)}; builtin eval ${quote(`PROMPT_COMMAND+=(${hook})`)}; builtin printf '\\036${initialized}\\037'; elif [ -n "\${ZSH_VERSION-}" ]; then builtin eval ${quote(definitions)}; builtin eval ${quote(`precmd_functions+=(${hook})`)}; builtin printf '\\036${initialized}\\037'; fi\r`);
  }
  flushInitial() {
    if (this.initial) { const text = this.initial.split(/\r?\n/).filter(line => !line.includes(`__KS_INIT_${this.secret}`)).join('\r\n'); this.initial = ''; if (text) this.output(text, null); }
  }
  text(data) {
    if (this.initializing) { this.initial = (this.initial + data).slice(-65536); return; }
    if (this.owner?.phase === 'starting') return; // hide protocol wrapper echo
    this.output(data, this.owner?.phase === 'output' ? this.owner.id : null);
  }
  push(chunk) {
    let text = '';
    const flush = () => { if (text) { this.text(text); text = ''; } };
    for (const ch of this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
      if (this.frame !== null) {
        if (ch === '\x1f') { flush(); const frame = this.frame; this.frame = null; this.handle(frame); }
        else if (ch === '\x1e') this.frame = '';
        else { this.frame += ch; if (this.frame.length > 256) { text += this.frame; this.frame = null; } }
      } else if (ch === '\x1e') { flush(); this.frame = ''; }
      else text += ch;
    }
    flush();
  }
  handle(frame) {
    const prefix = `KS:${this.secret}:`;
    if (!frame.startsWith(prefix)) { this.text(frame); return; }
    const value = frame.slice(prefix.length);
    if (value === 'I') { clearTimeout(this.timer); this.initializing = false; this.unsupported = false; this.flushInitial(); this.changed(); return; }
    if (value === 'P') {
      if (this.initializing || this.unsupported) return;
      const owner = this.owner;
      // A prompt without a matching completion cannot prove an exit code.
      this.owner = null; this.ready = true; this.changed();
      if (owner) this.output(`\r\n[AI ${Number.isInteger(owner.code) ? `exit ${owner.code}` : owner.cancelled ? 'interrupted' : 'result unknown'}]\r\n`, null, true);
      if (owner) this.finished(owner.id, Number.isInteger(owner.code) ? (owner.code === 0 ? 'completed' : 'failed') : owner.cancelled ? 'interrupted' : 'unknown', { exitCode: owner.code ?? null, remoteTerminationConfirmed: Number.isInteger(owner.code) || !!owner.cancelled });
      return;
    }
    const owner = this.owner; if (!owner) return;
    if (value === `S:${owner.nonce}` && owner.phase === 'starting') { owner.phase = 'output'; return; }
    const done = new RegExp(`^D:${owner.nonce}:([0-9]{1,3})$`).exec(value);
    if (done && owner.phase === 'output' && Number(done[1]) <= 255) { owner.code = Number(done[1]); owner.phase = 'finishing'; }
  }
  start(id, command) {
    if (!this.ready || this.initializing || this.unsupported || this.owner) return false;
    const nonce = randomBytes(24).toString('hex'); this.ready = false; this.owner = { id, nonce, phase: 'starting', command }; this.changed();
    this.output(`\r\n\x1b[36m[AI] ${command}\x1b[0m\r\n`, null, true);
    const start = `KS:${this.secret}:S:${nonce}`;
    this.write(` builtin printf '\\036${start}\\037'; builtin eval ${quote(command)}; __ks_finish_${this.secret} "$?" '${nonce}'\r`); return true;
  }
  manual() { if (this.ready) { this.ready = false; this.changed(); } }
  interrupt() { if (this.owner) this.owner.cancelled = true; this.write('\x03'); }
  takeControl() { const owner = this.owner; this.owner = null; this.ready = false; if (owner) this.output('\r\n[AI control returned; execution result unknown]\r\n', null, true); this.write('\x03'); this.changed(); if (owner) this.finished(owner.id, 'unknown', { exitCode: null, remoteTerminationConfirmed: false, error: 'E-TERM-TAKEN-OVER' }); }
  dispose() { clearTimeout(this.timer); this.owner = null; this.initial = ''; }
}
module.exports = { SharedTerminal, quote };

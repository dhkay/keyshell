'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateProfile, fail } = require('./policy.cjs');
class Store {
  constructor(userDataPath) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) fail('E-STORE-PATH');
    this.directory = path.join(userDataPath, 'ssh');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) fail('E-STORE-PATH');
    fs.chmodSync(this.directory, 0o700);
    this.file = path.join(this.directory, 'state.json');
    this.lock = path.join(this.directory, '.write-lock');
  }
  _read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('E-STORE-CORRUPT');
      fs.chmodSync(this.file, 0o600);
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.profiles) || !Array.isArray(data.knownHosts) || Object.keys(data).some(k => !['version', 'profiles', 'knownHosts'].includes(k))) fail('E-STORE-CORRUPT');
      data.profiles = data.profiles.map(validateProfile);
      data.knownHosts.forEach(validateHost);
      const keys = data.knownHosts.map(h => `${h.host}:${h.port}`);
      if (new Set(keys).size !== keys.length) fail('E-STORE-CORRUPT');
      return data;
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, profiles: [], knownHosts: [] }; fail('E-STORE-READ'); }
  }
  _acquire() {
    // Publish a complete immutable owner record atomically. Abandoned owners
    // lead to a deterministic successor lock, never unlinking another writer's
    // newly acquired lock during competing recovery attempts (no unlink CAS).
    const token = randomUUID(), candidate = path.join(this.directory, `${token}.owner`);
    const fd = fs.openSync(candidate, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    let lock = this.lock;
    try {
      for (let generation = 0; generation < 128; generation++) {
        try { fs.linkSync(candidate, lock); return lock; }
        catch (e) { if (e.code !== 'EEXIST') fail('E-STORE-BUSY'); }
        let owner;
        try {
          const stat = fs.lstatSync(lock);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) fail('E-STORE-BUSY');
          owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9-]{36}$/.test(owner.token)) fail('E-STORE-BUSY');
        } catch { fail('E-STORE-BUSY'); }
        try { process.kill(owner.pid, 0); fail('E-STORE-BUSY'); }
        catch (e) { if (e.code !== 'ESRCH') fail('E-STORE-BUSY'); }
        lock = `${this.lock}.${owner.token}`;
      }
      fail('E-STORE-BUSY');
    } finally { fs.unlinkSync(candidate); }
  }
  _update(fn) {
    const lock = this._acquire();
    let temp;
    try {
      const state = this._read(); const result = fn(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) fail('E-STORE-SIZE');
      temp = path.join(this.directory, `${randomUUID()}.tmp`);
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
      return result;
    } catch (e) { if (e.code?.startsWith('E-')) throw e; fail('E-STORE-WRITE'); }
    finally { if (temp) fs.rmSync(temp, { force: true }); fs.unlinkSync(lock); }
  }
  listProfiles() { return this._read().profiles; }
  saveProfile(input) {
    const profile = validateProfile(input);
    if (!profile.id) profile.id = randomUUID();
    return this._update(s => { s.profiles = s.profiles.filter(p => p.id !== profile.id); s.profiles.push(profile); return { ...profile }; });
  }
  deleteProfile(id) { return this._update(s => { s.profiles = s.profiles.filter(p => p.id !== id); }); }
  getKnownHost(host, port) { return this._read().knownHosts.find(h => h.host === host && h.port === port) || null; }
  rotateHost(expected, replacement) {
    const old = validateHost(expected), next = validateHost(replacement);
    if (old.host !== next.host || old.port !== next.port) fail('E-STORE-HOST');
    return this._update(state => {
      const index = state.knownHosts.findIndex(h => h.host === old.host && h.port === old.port);
      if (index < 0 || state.knownHosts[index].fingerprint !== old.fingerprint || state.knownHosts[index].keyType !== old.keyType) fail('E-SSH-HOSTKEY-STALE');
      state.knownHosts[index] = next; return { ...next };
    });
  }
  trustHost(input) {
    const host = validateHost(input);
    return this._update(s => {
      const old = s.knownHosts.find(h => h.host === host.host && h.port === host.port);
      if (old && (old.fingerprint !== host.fingerprint || old.keyType !== host.keyType)) fail('E-SSH-HOSTKEY-CHANGED');
      if (!old) s.knownHosts.push(host);
      return { ...host };
    });
  }
}
function validateHost(h) {
  if (!h || Object.keys(h).some(k => !['host', 'port', 'keyType', 'fingerprint'].includes(k))) fail('E-STORE-HOST');
  const p = validateProfile({ host: h.host, port: h.port, username: 'validation' });
  if (typeof h.keyType !== 'string' || !/^[\w@.-]{1,128}$/.test(h.keyType) || typeof h.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(h.fingerprint)) fail('E-STORE-HOST');
  return { host: p.host, port: p.port, keyType: h.keyType, fingerprint: h.fingerprint };
}
module.exports = { Store };

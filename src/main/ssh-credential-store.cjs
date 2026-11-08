'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail, validateProfile, validateCredentials } = require('./policy.cjs');

// This file contains only OS-encrypted password blobs. No password is returned
// through IPC; decryption happens in the main process for one SSH connection.
class SSHCredentialStore {
  constructor(userDataPath, safeStorage) {
    if (!path.isAbsolute(userDataPath || '')) fail('E-SSH-CREDENTIAL-STORE');
    this.directory = path.join(userDataPath, 'ssh');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) fail('E-SSH-CREDENTIAL-STORE');
    fs.chmodSync(this.directory, 0o700);
    this.file = path.join(this.directory, 'credentials.json');
    this.safeStorage = safeStorage;
  }
  get available() {
    try { return !!this.safeStorage?.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  }
  _read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('E-SSH-CREDENTIAL-STORE');
      fs.chmodSync(this.file, 0o600);
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries) || Object.keys(data).sort().join(',') !== 'entries,version') fail('E-SSH-CREDENTIAL-STORE');
      for (const entry of data.entries) {
        if (!entry || Object.keys(entry).sort().join(',') !== 'encrypted,host,id,port,username' || !/^[a-f0-9-]{36}$/.test(entry.id) || typeof entry.encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.encrypted) || entry.encrypted.length > 32768) fail('E-SSH-CREDENTIAL-STORE');
        validateProfile({ id: entry.id, host: entry.host, port: entry.port, username: entry.username });
      }
      if (new Set(data.entries.map(entry => entry.id)).size !== data.entries.length) fail('E-SSH-CREDENTIAL-STORE');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: [] }; fail('E-SSH-CREDENTIAL-STORE'); }
  }
  _save(data) {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) fail('E-SSH-CREDENTIAL-STORE');
    const temp = path.join(this.directory, `${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, this.file); } finally { fs.rmSync(temp, { force: true }); }
  }
  has(profile) {
    if (!this.available || !profile?.id) return false;
    const p = validateProfile(profile);
    return this._read().entries.some(e => e.id === p.id && e.host === p.host && e.port === p.port && e.username === p.username);
  }
  get(profile) {
    if (!this.available || !this.has(profile)) fail('E-SSH-CREDENTIAL-UNAVAILABLE');
    const p = validateProfile(profile), entry = this._read().entries.find(e => e.id === p.id);
    try { return validateCredentials({ type: 'password', password: this.safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64')) }); }
    catch { fail('E-SSH-CREDENTIAL-READ'); }
  }
  put(profile, password) {
    const p = validateProfile(profile);
    if (!p.id || !this.available) fail('E-SSH-CREDENTIAL-UNAVAILABLE');
    validateCredentials({ type: 'password', password });
    let encrypted;
    try { encrypted = this.safeStorage.encryptString(password).toString('base64'); }
    catch { fail('E-SSH-CREDENTIAL-STORE'); }
    const data = this._read();
    data.entries = data.entries.filter(e => e.id !== p.id);
    data.entries.push({ id: p.id, host: p.host, port: p.port, username: p.username, encrypted });
    this._save(data);
  }
  delete(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('E-SSH-CREDENTIAL-STORE');
    const data = this._read(), entries = data.entries.filter(e => e.id !== id);
    if (entries.length !== data.entries.length) this._save({ version: 1, entries });
  }
}
module.exports = { SSHCredentialStore };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('./policy.cjs');
// Main-process only. Registration metadata survives logout; credentials never
// fall back to plaintext, including Electron's Linux basic_text backend.
class CredentialStore {
  constructor(userDataPath, safeStorage) {
    if (!path.isAbsolute(userDataPath || '')) fail('E-AUTH-STORE');
    this.directory = path.join(userDataPath, 'ai');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) fail('E-AUTH-STORE');
    fs.chmodSync(this.directory, 0o700);
    this.file = path.join(this.directory, 'registrations.json');
    this.safeStorage = safeStorage;
    this.memory = new Map(); this.cleared = new Set();
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail('E-AUTH-STORE');
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.state.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/.test(this.state.hostId) || !Array.isArray(this.state.accounts) || Object.keys(this.state).some(k => !['version', 'hostId', 'accounts'].includes(k))) fail('E-AUTH-STORE');
      for (const a of this.state.accounts) {
        if (!a || Object.keys(a).some(k => !['id', 'clientId', 'subject', 'issuer', 'email', 'label', 'encrypted'].includes(k)) || !['id', 'clientId', 'subject', 'issuer', 'email', 'label'].every(k => typeof a[k] === 'string' && a[k].length <= 4096) || a.clientId === 'dynamic_agent_client' || !a.id || !a.clientId || !a.subject || a.issuer !== 'https://auth.openai.com' || (a.encrypted !== undefined && typeof a.encrypted !== 'string')) fail('E-AUTH-STORE');
      }
      if (new Set(this.state.accounts.map(a => a.id)).size !== this.state.accounts.length || new Set(this.state.accounts.map(a => a.clientId)).size !== this.state.accounts.length) fail('E-AUTH-STORE');
      fs.chmodSync(this.file, 0o600);
    } catch (e) {
      if (e.code !== 'ENOENT') fail('E-AUTH-STORE');
      this.state = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
      this._save();
    }
  }
  get persistent() {
    try { return !!this.safeStorage?.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  }
  get hostId() { return this.state.hostId; }
  _save(state = this.state) {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) fail('E-AUTH-STORE-SIZE');
    const temp = path.join(this.directory, `${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, this.file); } finally { fs.rmSync(temp, { force: true }); }
  }
  list() { return this.state.accounts.map(({ encrypted, ...a }) => { const tokens = this.getTokens(a.id); return { ...a, authenticated: !!tokens, planUsageAllowed: !!tokens?.scopes?.includes('chatgpt.tokens.use.direct'), remembered: !!encrypted, persistent: this.persistent }; }); }
  registration(id) { const a = this.state.accounts.find(a => a.id === id); if (!a) return null; const { encrypted, ...metadata } = a; return { ...metadata }; }
  getTokens(id) {
    if (this.cleared.has(id)) return null;
    if (this.memory.has(id)) return structuredClone(this.memory.get(id));
    const a = this.state.accounts.find(a => a.id === id);
    if (!a?.encrypted || !this.persistent) return null;
    try { return JSON.parse(this.safeStorage.decryptString(Buffer.from(a.encrypted, 'base64'))); } catch { return null; }
  }
  put(metadata, tokens, { remember = false } = {}) {
    if (!metadata.clientId || metadata.clientId === 'dynamic_agent_client' || !metadata.subject || !metadata.issuer) fail('E-AUTH-IDENTITY');
    const existing = this.state.accounts.find(a => a.id === metadata.id || a.clientId === metadata.clientId);
    if (existing && (existing.clientId !== metadata.clientId || existing.subject !== metadata.subject || existing.issuer !== metadata.issuer)) fail('E-AUTH-IDENTITY');
    const account = { id: existing?.id || randomUUID(), clientId: metadata.clientId, subject: metadata.subject, issuer: metadata.issuer, email: metadata.email || '', label: existing?.label || `${metadata.email || 'ChatGPT'} (${metadata.clientId})` };
    if (remember && this.persistent) account.encrypted = this.safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
    const next = { ...this.state, accounts: [...this.state.accounts.filter(a => a.id !== account.id), account] };
    this._save(next); this.state = next; this.cleared.delete(account.id); this.memory.set(account.id, structuredClone(tokens));
    return account.id;
  }
  clearTokens(id) {
    this.cleared.add(id); this.memory.delete(id);
    const next = structuredClone(this.state); const a = next.accounts.find(a => a.id === id);
    if (a) { delete a.encrypted; this._save(next); this.state = next; }
  }
  remembers(id) { return !!this.state.accounts.find(a => a.id === id)?.encrypted; }
}
module.exports = { CredentialStore };

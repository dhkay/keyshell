'use strict';
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { randomBytes, createHash } = require('node:crypto');
const { fail } = require('./policy.cjs');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const ENDPOINTS = Object.freeze({ authorize: `${ISSUER}/api/accounts/authorize`, token: `${ISSUER}/api/accounts/oauth/token`, discovery: `${ISSUER}/.well-known/openid-configuration` });
const random = () => randomBytes(32).toString('base64url');
class AuthService extends EventEmitter {
  constructor({ store, openBrowser, fetch: fetchImpl = globalThis.fetch, verifyIdToken, timeoutMs = 180000, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    super(); this.store = store; this.openBrowser = openBrowser; this.fetch = fetchImpl; this.verifyIdToken = verifyIdToken; this.timeoutMs = timeoutMs; this.now = now; this.sleep = sleep;
    this.activeId = null; this.epoch = 0; this.refreshes = new Map(); this.pending = null; this.controllers = new Set(); this.requestTimeoutMs = 30000;
  }
  state() { return { activeAccountId: this.activeId, accounts: this.store.list(), persistence: this.store.persistent ? 'encrypted' : 'memory' }; }
  _invalidate() { this.epoch++; for (const c of this.controllers) c.abort(); this.emit('change', this.state()); }
  dispose() { this.cancelLogin(); this.activeId = null; this._invalidate(); this.removeAllListeners(); }
  selectAccount(id) { if (!this.store.registration(id)) fail('E-AUTH-ACCOUNT'); this.cancelLogin(); this.activeId = id; this._invalidate(); return this.state(); }
  async _json(url, options) {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let res; try { res = await this.fetch(url, { ...options, signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, redirect: 'error' }); } catch { fail('E-AUTH-NETWORK'); }
      if (!res.ok) fail('E-AUTH-REQUEST');
      try { return await res.json(); } catch { fail('E-AUTH-RESPONSE'); }
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async _verify(jwt, clientId, nonce) {
    if (typeof jwt !== 'string') fail('E-AUTH-ID-TOKEN');
    try {
      let payload;
      if (this.verifyIdToken) payload = await this.verifyIdToken(jwt, { issuer: ISSUER, audience: clientId, nonce });
      else {
        const jose = await import('jose');
        this.jwks ||= jose.createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
        ({ payload } = await jose.jwtVerify(jwt, this.jwks, { issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'] }));
      }
      if (payload.iss !== ISSUER || !(Array.isArray(payload.aud) ? payload.aud.includes(clientId) : payload.aud === clientId) || !payload.sub || !Number.isFinite(payload.exp) || payload.exp * 1000 <= this.now() || (nonce !== undefined && payload.nonce !== nonce)) fail('E-AUTH-ID-TOKEN');
      return payload;
    } catch { fail('E-AUTH-ID-TOKEN'); }
  }
  _tokens(body, old = {}) {
    if (typeof body.access_token !== 'string' || !body.access_token || (body.token_type || '').toLowerCase() !== 'bearer' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) fail('E-AUTH-TOKEN');
    const scopes = body.scope === undefined ? old.scopes : typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : null;
    if (!Array.isArray(scopes)) fail('E-AUTH-SCOPE');
    if (body.refresh_token !== undefined && (typeof body.refresh_token !== 'string' || !body.refresh_token)) fail('E-AUTH-TOKEN');
    return { access_token: body.access_token, refresh_token: body.refresh_token || old.refresh_token, id_token: body.id_token || old.id_token, scopes, expiresAt: this.now() + body.expires_in * 1000 };
  }
  async beginLogin({ accountId, remember = false } = {}) {
    this.cancelLogin();
    if (typeof remember !== 'boolean') fail('E-AUTH-INPUT');
    const account = accountId ? this.store.registration(accountId) : null;
    if (accountId && !account) fail('E-AUTH-ACCOUNT');
    const epoch = this.epoch, state = random(), nonce = random(), verifier = random();
    let resolve, reject;
    const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A UI may subscribe after opening the browser; prevent unhandled rejection.
    completion.catch(() => {});
    const server = http.createServer();
    const pending = { server, resolve, reject, completion, epoch, consumed: false, timer: null, controller: new AbortController() };
    this.pending = pending;
    const finish = (error, value) => {
      if (this.pending !== pending) return;
      clearTimeout(pending.timer); pending.controller.abort(); server.close(); server.closeIdleConnections(); this.pending = null;
      if (error) reject(error); else resolve(value);
    };
    server.on('request', (req, res) => {
      const address = server.address();
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${address?.port}`) { res.writeHead(400).end('Invalid callback'); return; }
      let url; try { url = new URL(req.url, `http://127.0.0.1:${address.port}`); } catch { res.writeHead(400).end(); return; }
      if (url.pathname !== '/auth/callback' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state || pending.consumed) { res.writeHead(400).end('Invalid callback'); return; }
      pending.consumed = true;
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('You can return to KeyShell.');
      server.close();
      (async () => {
        if (url.searchParams.has('error')) fail('E-AUTH-DENIED');
        const issued = url.searchParams.get('client_id');
        const clientId = account?.clientId || issued;
        if (!clientId || clientId === 'dynamic_agent_client' || (account && issued && issued !== account.clientId) || !url.searchParams.get('code')) fail('E-AUTH-CLIENT');
        const body = await this._json(ENDPOINTS.token, { signal: pending.controller.signal, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: url.searchParams.get('code'), code_verifier: verifier, redirect_uri: pending.redirectUri, resource: RESOURCE }) });
        const identity = await this._verify(body.id_token, clientId, nonce);
        if (account && (identity.sub !== account.subject || identity.iss !== account.issuer)) fail('E-AUTH-IDENTITY');
        const tokens = this._tokens(body);
        if (this.pending !== pending || this.epoch !== epoch) fail('E-AUTH-STALE');
        const id = this.store.put({ id: accountId, clientId, subject: identity.sub, issuer: identity.iss, email: identity.email }, tokens, { remember });
        this.activeId = id; this._invalidate(); finish(null, this.state());
      })().catch(() => finish(Object.assign(new Error('E-AUTH-LOGIN'), { code: 'E-AUTH-LOGIN' })));
    });
    try {
      await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
      if (this.pending !== pending) fail('E-AUTH-CANCELLED');
      pending.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const params = new URLSearchParams({ client_id: account?.clientId || 'dynamic_agent_client', ext_agent_host_id: this.store.hostId, response_type: 'code', redirect_uri: pending.redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      if (!account) params.set('agent_name_hint', 'KeyShell');
      else { const tokens = this.store.getTokens(accountId); if (tokens?.id_token) params.set('id_token_hint', tokens.id_token); if (account.email) params.set('login_hint', account.email); }
      pending.timer = setTimeout(() => finish(Object.assign(new Error('E-AUTH-TIMEOUT'), { code: 'E-AUTH-TIMEOUT' })), this.timeoutMs);
      await this.openBrowser(`${ENDPOINTS.authorize}?${params}`);
    } catch { finish(Object.assign(new Error('E-AUTH-LOGIN'), { code: 'E-AUTH-LOGIN' })); }
    return { completion };
  }
  cancelLogin() {
    const p = this.pending; if (!p) return;
    this.pending = null; clearTimeout(p.timer); p.controller.abort(); p.server.close(); p.server.closeAllConnections(); for (const c of this.controllers) c.abort(); p.reject(Object.assign(new Error('E-AUTH-CANCELLED'), { code: 'E-AUTH-CANCELLED' }));
  }
  async accessToken() {
    const id = this.activeId, epoch = this.epoch;
    const account = this.store.registration(id), tokens = this.store.getTokens(id);
    if (!account || !tokens) fail('E-AUTH-REQUIRED');
    if (!tokens.scopes.includes('chatgpt.tokens.use.direct')) fail('E-AUTH-PLAN-PERMISSION');
    if (tokens.expiresAt > this.now() + 60000) return tokens.access_token;
    let refresh = this.refreshes.get(id);
    if (!refresh) {
      refresh = (async () => {
        if (!tokens.refresh_token) fail('E-AUTH-REQUIRED');
        const body = await this._json(ENDPOINTS.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: tokens.refresh_token, resource: RESOURCE }) });
        if (body.id_token) { const identity = await this._verify(body.id_token, account.clientId); if (identity.sub !== account.subject) fail('E-AUTH-IDENTITY'); }
        const replacement = this._tokens(body, tokens);
        if (this.epoch !== epoch || this.activeId !== id) fail('E-AUTH-STALE');
        this.store.put(account, replacement, { remember: this.store.remembers(id) });
        if (!replacement.scopes.includes('chatgpt.tokens.use.direct')) fail('E-AUTH-PLAN-PERMISSION');
        return replacement.access_token;
      })();
      this.refreshes.set(id, refresh);
      refresh.catch(() => { if (this.epoch === epoch && this.activeId === id) this.emit('auth-error', { code: 'E-AUTH-REFRESH', accountId: id }); });
      refresh.finally(() => { if (this.refreshes.get(id) === refresh) this.refreshes.delete(id); }).catch(() => {});
    }
    const token = await refresh;
    if (this.epoch !== epoch || this.activeId !== id) fail('E-AUTH-STALE');
    return token;
  }
  async logout() {
    const id = this.activeId, account = this.store.registration(id), tokens = this.store.getTokens(id);
    this.cancelLogin(); this.activeId = null; this._invalidate();
    let remoteRevocationConfirmed = !tokens?.refresh_token;
    // Stop local use immediately, while retaining a private copy for revocation.
    let localCredentialsCleared = true;
    try { if (id) this.store.clearTokens(id); } catch { localCredentialsCleared = false; }
    if (tokens?.refresh_token && account) {
      try {
        const discovery = await this._json(ENDPOINTS.discovery);
        const endpoint = new URL(discovery.revocation_endpoint);
        if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash) fail('E-AUTH-REVOCATION');
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await this.fetch(endpoint.href, { method: 'POST', signal: AbortSignal.timeout(this.requestTimeoutMs), redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: 'refresh_token', client_id: account.clientId }) });
            if (res.status === 200) { remoteRevocationConfirmed = true; break; }
            if (res.status < 500) break;
          } catch {}
          if (attempt < 2) await this.sleep(100 * 2 ** attempt);
        }
      } catch {}
    }
    return { ...this.state(), localCredentialsCleared, remoteRevocationConfirmed };
  }
}
module.exports = { AuthService, ISSUER, RESOURCE };

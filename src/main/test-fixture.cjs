'use strict';
// Loaded only in unpackaged source with explicit test opt-in; never shipped.
function install({ auth, ai }) {
  const accounts = [{ id: 'development-fixture', email: 'fixture@example.invalid' }, { id: 'development-second', email: 'second@example.invalid' }];
  auth.activeId = accounts[0].id; let lastLogin, loginRevision = 0, loginFailures = process.env.KEYSHELL_TEST_LOGIN_FAIL_ONCE === '1' ? 1 : 0;
  const cancelLogin = auth.cancelLogin.bind(auth); auth.cancelLogin = () => { loginRevision++; cancelLogin(); };
  auth.state = () => ({ activeAccountId: auth.activeId, accounts: accounts.map(a => ({ ...a, label: 'Development fixture', authenticated: !!auth.activeId })), persistence: 'memory', developmentFixture: true, lastLogin });
  auth.store.registration = id => accounts.find(a => a.id === id) || null;
  auth.store.getTokens = () => auth.activeId ? { access_token: 'fixture-only' } : null;
  auth.accessToken = async () => 'fixture-only';
  auth.beginLogin = async options => { auth.cancelLogin(); lastLogin = options; const epoch = auth.epoch, revision = loginRevision; const completion = (async () => { const delay = Number(process.env.KEYSHELL_TEST_LOGIN_DELAY_MS) || 0; if (delay) await new Promise(resolve => setTimeout(resolve, delay)); if (auth.epoch !== epoch || loginRevision !== revision) throw Object.assign(new Error('E-AUTH-CANCELLED'), { code: 'E-AUTH-CANCELLED' }); if (loginFailures > 0) { loginFailures--; throw Object.assign(new Error('E-AUTH-LOGIN'), { code: 'E-AUTH-LOGIN' }); } auth.activeId = options.accountId || accounts[0].id; auth._invalidate(); return auth.state(); })(); return { completion }; };
  ai.fetch = async url => url.endsWith('/models') ? { ok: true, json: async () => ({ models: [{ slug: 'fixture-model', display_name: 'Development fixture model', visibility: 'list' }, { slug: 'fixture-alternate', display_name: 'Development alternate model', visibility: 'list' }] }) } : { ok: true, body: (async function* () { yield Buffer.from('data: {"type":"response.output_text.delta","delta":"<img src=x onerror=alert(1)>\\n```sh\\npwd\\n```"}\n\ndata: {"type":"response.completed"}\n\n'); })() };
}
module.exports = { install };

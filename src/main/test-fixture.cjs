'use strict';
// Loaded only in unpackaged source with explicit test opt-in; never shipped.
function install({ auth, ai }) {
  const accounts = [{ id: 'development-fixture', email: 'fixture@example.invalid' }, { id: 'development-second', email: 'second@example.invalid' }];
  auth.activeId = accounts[0].id; let lastLogin;
  auth.state = () => ({ activeAccountId: auth.activeId, accounts: accounts.map(a => ({ ...a, label: 'Development fixture', authenticated: !!auth.activeId })), persistence: 'memory', developmentFixture: true, lastLogin });
  auth.store.registration = id => accounts.find(a => a.id === id) || null;
  auth.store.getTokens = () => auth.activeId ? { access_token: 'fixture-only' } : null;
  auth.accessToken = async () => 'fixture-only';
  auth.beginLogin = async options => { lastLogin = options; auth.activeId = options.accountId || accounts[0].id; auth._invalidate(); return { completion: Promise.resolve(auth.state()) }; };
  ai.fetch = async url => url.endsWith('/models') ? { ok: true, json: async () => ({ models: [{ slug: 'fixture-model', display_name: 'Development fixture model', visibility: 'list' }, { slug: 'fixture-alternate', display_name: 'Development alternate model', visibility: 'list' }] }) } : { ok: true, body: (async function* () { yield Buffer.from('data: {"type":"response.output_text.delta","delta":"<img src=x onerror=alert(1)>\\n```sh\\npwd\\n```"}\n\ndata: {"type":"response.completed"}\n\n'); })() };
}
module.exports = { install };

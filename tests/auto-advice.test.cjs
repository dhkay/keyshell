'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AutoAdvice, AUTO_LIMITS } = require('../src/main/auto-advice.cjs');
const { AIService } = require('../src/main/ai-service.cjs');
const { installIPC } = require('../src/main/ipc.cjs');
function fixture(t, fetchImpl) {
  let now = 1000, active = 'first';
  const target = { sessionId: 'first', generation: 'generation-one', status: 'connected', host: 'localhost', port: 22, username: 'tester' };
  const ssh = new EventEmitter(); ssh.listSessions = () => [target]; ssh.executions = new Map();
  const auth = new EventEmitter(); auth.activeId = 'account'; auth.store = { getTokens: () => ({ access_token: 'test-only' }) }; auth.accessToken = async () => 'test-only'; auth.state = () => ({ accounts: [{ id: 'account', email: 'test@example.invalid' }] });
  const calls = [];
  const ai = new AIService({ auth, now: () => now, fetch: async (url, options) => { calls.push(JSON.parse(options.body)); return fetchImpl ? fetchImpl(url, options) : new Response('data: {"type":"response.output_text.delta","delta":"Review output.\\n```sh\\npwd\\n```"}\n\ndata: {"type":"response.completed"}\n\n'); } });
  ai.catalog = [{ slug: 'model' }];
  const advice = new AutoAdvice({ ssh, ai, auth, getActive: () => active, now: () => now });
  t.after(() => { advice.dispose(); ai.dispose(); });
  const enable = () => advice.enable(advice.prepare({ sessionId: active, model: 'model' }).token);
  const output = (text, extra = {}) => ssh.emit('observed-output', { sessionId: 'first', generation: target.generation, channel: 'terminal', data: text, ...extra });
  return { advice, ai, auth, ssh, target, calls, enable, output, advance: ms => { now += ms; }, activate: id => { active = id; } };
}
test('automatic advice requires a fresh consent binding and excludes output before consent and other sessions', async t => {
  const f = fixture(t); f.output('before consent'); assert.equal(f.advice.grant, null);
  const p = f.advice.prepare({ sessionId: 'first', model: 'model' });
  f.output('while consent dialog is open'); f.advance(120001);
  assert.throws(() => f.advice.enable(p.token), { code: 'E-ADVICE-STALE' });
  f.enable(); f.output('other session secret', { sessionId: 'second' }); f.output('old generation secret', { generation: 'old' });
  f.output('ERROR password=private-secret'); await f.advice.flush();
  assert.equal(f.calls.length, 1); const payload = JSON.stringify(f.calls[0]);
  for (const forbidden of ['before consent', 'consent dialog', 'other session', 'old generation', 'private-secret']) assert.ok(!payload.includes(forbidden), forbidden);
  assert.match(payload, /password=\[REDACTED\]/); assert.equal(f.calls[0].tools, undefined);
  assert.equal(f.ssh.executions.size, 0);
});
test('automatic advice bounds UTF8 output, rate and turn count, and never repeats old output', async t => {
  const f = fixture(t); f.enable();
  f.output('가'.repeat(10000)); assert.ok(Buffer.byteLength(f.advice.grant.buffer) <= AUTO_LIMITS.bytes);
  await f.advice.flush(); assert.equal(f.calls.length, 1);
  await f.advice.flush(); assert.equal(f.calls.length, 1);
  f.output('new-only'); await f.advice.flush(); assert.equal(f.calls.length, 1);
  for (let i = 1; i < AUTO_LIMITS.requests; i++) {
    f.advance(AUTO_LIMITS.intervalMs); f.output('new turn ' + i); await f.advice.flush();
  }
  assert.equal(f.calls.length, AUTO_LIMITS.requests); assert.equal(f.advice.state().enabled, false); assert.equal(f.advice.state().reason, 'limit-reached');
  f.output('after limit'); await f.advice.flush(); assert.equal(f.calls.length, AUTO_LIMITS.requests);
});
test('automatic sharing stops on generation, account, model and active-tab changes', async t => {
  for (const change of ['generation', 'account', 'model', 'tab']) {
    const f = fixture(t); f.enable(); f.output('pending private output');
    if (change === 'generation') f.target.generation = 'replacement';
    if (change === 'account') { f.auth.activeId = 'other'; f.auth.emit('change', {}); }
    if (change === 'model') f.ai.sessions.get('first').model = 'different';
    if (change === 'tab') f.activate('second');
    await f.advice.flush(); assert.equal(f.calls.length, 0, change); assert.equal(f.advice.state().enabled, false, change);
  }
});
test('stopping advice cancels only its own request and does not cancel a manual request', async t => {
  let signal;
  const f = fixture(t, (_url, options) => new Promise((_resolve, reject) => { signal = options.signal; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
  f.enable(); f.output('automatic in flight'); const running = f.advice.flush();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(signal.aborted, false);
  f.advice.stop(); await running; assert.equal(signal.aborted, true); assert.equal(f.ai.requests.size, 0);
  f.enable();
  const p = f.ai.preview({ sessionId: 'first', model: 'model', question: 'manual request' }); const manual = f.ai.send(p.token);
  await new Promise(resolve => setImmediate(resolve)); const manualSignal = signal;
  f.output('output during manual request'); await f.advice.flush(); f.advice.stop();
  assert.equal(manualSignal.aborted, false); assert.equal(f.ai.requests.size, 1);
  f.ai.cancel('first'); await manual;
});
test('automatic advice waits for a manual preview and stops without retry after a provider error', async t => {
  const f = fixture(t, () => new Response('', { status: 429 })); f.enable();
  const p = f.ai.preview({ sessionId: 'first', model: 'model', question: 'review me' });
  f.output('new output'); await f.advice.flush(); assert.equal(f.calls.length, 0);
  f.ai.invalidatePreviews('first'); await f.advice.flush(); assert.equal(f.calls.length, 1); assert.equal(f.advice.state().reason, 'request-failed');
  await f.advice.flush(); assert.equal(f.calls.length, 1); assert.ok(p.token);
});
test('direct-send IPC enforces mode, active session, masking and one in-flight request', async t => {
  const f = fixture(t); let handler; const events = [];
  const wc = { mainFrame: { url: 'keyshell://app/index.html' }, send: (type, detail) => events.push({ type, detail }) };
  const remove = installIPC({ ipcMain: { handle: (_n, fn) => { handler = fn; }, removeHandler() {} }, window: { webContents: wc, isDestroyed: () => false }, ssh: f.ssh, ai: f.ai, auth: f.auth, store: {}, updates: new EventEmitter(), dialog: {}, app: {}, clipboard: {} }); t.after(remove);
  const event = { sender: wc, senderFrame: wc.mainFrame }, input = { sessionId: 'general', model: 'model', question: 'password=direct-secret' };
  assert.equal((await handler(event, 'directSend', { ...input, sessionId: 'inactive' })).error, 'E-IPC-SESSION');
  assert.equal((await handler(event, 'previewMode', 'off')).error, 'E-IPC-INPUT');
  await handler(event, 'previewMode', true); assert.equal((await handler(event, 'directSend', input)).error, 'E-AI-REVIEW-REQUIRED'); assert.equal(f.calls.length, 0);
  await handler(event, 'previewMode', false); const first = handler(event, 'directSend', input), duplicate = handler(event, 'directSend', input);
  assert.equal((await duplicate).error, 'E-AI-BUSY'); assert.equal((await first).value.completed, true); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.calls).includes('direct-secret')); assert.ok(!JSON.stringify(events).includes('direct-secret'));
  assert.equal(f.ssh.executions.size, 0);
});

test('expired manual previews do not block advice, and queued requests can be cancelled before token acquisition', async t => {
  const f = fixture(t); f.enable();
  f.ai.preview({ sessionId: 'first', model: 'model', question: 'stale preview' }); f.advance(120001);
  f.output('new after preview expired'); await f.advice.flush(); assert.equal(f.calls.length, 1);
  let resolveToken; f.auth.accessToken = () => new Promise(resolve => { resolveToken = resolve; });
  f.advance(AUTO_LIMITS.intervalMs); f.output('next request'); const events = []; f.ai.on('state', d => events.push(d));
  const running = f.advice.flush(); assert.equal(events.at(-1).type, 'queued');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof resolveToken, 'function');
  f.advice.stop(); assert.equal(events.at(-1).type, 'cancelled');
  await Promise.race([running, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Cancellation waited for token refresh')), 200); timer.unref(); })]);
  assert.equal(f.calls.length, 1); assert.equal(f.ai.requests.size, 0);
  f.auth.accessToken = async () => 'fresh-token';
  const next = f.ai.preview({ sessionId: 'first', model: 'model', question: 'manual after cancellation' });
  assert.equal((await f.ai.send(next.token)).completed, true); assert.equal(f.calls.length, 2);
  resolveToken('late-old-token'); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 2);
});
test('real scheduler sends during continuous output within maximum wait and respects stop', async t => {
  const f = fixture(t); f.advice.dispose();
  const advice = new AutoAdvice({ ssh: f.ssh, ai: f.ai, auth: f.auth, getActive: () => 'first', limits: { ...AUTO_LIMITS, idleMs: 40, maxWaitMs: 90, intervalMs: 250 } });
  t.after(() => advice.dispose()); advice.enable(advice.prepare({ sessionId: 'first', model: 'model' }).token);
  const delivered = new Promise(resolve => { const listener = d => { if (d.type === 'completed') { f.ai.off('state', listener); resolve(); } }; f.ai.on('state', listener); });
  const producing = setInterval(() => f.output('continuous update\n'), 10); t.after(() => clearInterval(producing));
  let timeout; await Promise.race([delivered, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Continuous output never triggered advice')), 3000); })]).finally(() => clearTimeout(timeout));
  assert.equal(f.calls.length, 1); advice.stop();
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(f.calls.length, 1);
});
test('output queued for renderer before consent never becomes automatically shared after consent', async t => {
  const { PassThrough } = require('node:stream'), { SSHService } = require('../src/main/ssh-service.cjs');
  const f = fixture(t); f.advice.dispose();
  const ssh = new SSHService({ store: {} }); t.after(() => ssh.dispose()); ssh.setOutputConsumer(true);
  const s = { id: 'first', generation: 'generation-one', profile: { host: 'localhost', port: 22, username: 'tester' }, status: 'connected', ended: false };
  ssh.sessions.set(s.id, s); const source = new PassThrough(); t.after(() => source.destroy());
  ssh._output(s, source, 'terminal');
  source.write('BEFORE_CONSENT_BACKLOG '.repeat(20000)); assert.ok(ssh.outputStats().pendingBytes > 0);
  const advice = new AutoAdvice({ ssh, ai: f.ai, auth: f.auth, getActive: () => 'first', now: () => 1000 }); t.after(() => advice.dispose());
  advice.enable(advice.prepare({ sessionId: 'first', model: 'model' }).token);
  while (ssh.outputFlights.size) for (const id of [...ssh.outputFlights.keys()]) ssh.ackOutput(id);
  await advice.flush(); assert.equal(f.calls.length, 0); assert.equal(advice.grant.buffer, '');
  source.write('AFTER_CONSENT fresh status\n'); await advice.flush(); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.calls).includes('BEFORE_CONSENT_BACKLOG'));
});

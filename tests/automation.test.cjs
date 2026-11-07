'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Automation, action } = require('../src/main/automation.cjs');
const { AIService } = require('../src/main/ai-service.cjs');
function fixture(t, responses, options = {}) {
  let active = 'first';
  const target = { sessionId: 'first', generation: 'one', status: 'connected', username: 'tester', host: 'localhost', port: 22 };
  const auth = new EventEmitter(); auth.activeId = 'account'; auth.store = { getTokens: () => ({}) }; auth.accessToken = async () => 'fixture';
  const calls = [], commands = [], signals = [];
  const ai = new AIService({ auth, fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const response = responses.shift(); if (typeof response === 'function') return response(options);
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: {"type":"response.completed"}\n\n`);
  } }); ai.catalog = [{ slug: 'model' }]; ai.setModel('first', 'model');
  const ssh = new EventEmitter(); ssh.executions = new Map(); ssh.tokens = new Map(); ssh.listSessions = () => [target];
  ssh.prepareExecution = (sessionId, command) => { const id = String(ssh.executions.size + 1), e = { id, sessionId, generation: target.generation, command, token: 'token-' + id, status: 'pending' }; ssh.tokens.set(e.token, id); ssh.executions.set(id, e); return e; };
  ssh.approveExecution = token => { const e = ssh.executions.get(ssh.tokens.get(token)); assert.equal(e.status, 'pending'); ssh.tokens.delete(token); e.status = 'running'; commands.push(e.command); ssh.emit('execution', { ...e }); return { executionId: e.id }; };
  ssh.cancelExecution = id => { signals.push(id); const e = ssh.executions.get(id); e.status = 'cancel-requested'; ssh.emit('execution', { ...e }); };
  const automation = new Automation({ ssh, ai, auth, getActive: () => active, ...options });
  t.after(() => { automation.dispose(); ai.dispose(); });
  const finish = (output, exitCode = 0) => { const e = [...ssh.executions.values()].at(-1); ssh.emit('observed-output', { sessionId: 'first', generation: target.generation, channel: 'execution', executionId: e.id, stream: 'stdout', data: output }); e.status = exitCode ? 'failed' : 'completed'; e.exitCode = exitCode; ssh.emit('execution', { ...e }); };
  const start = () => automation.start(automation.prepare({ sessionId: 'first', model: 'model', goal: 'Install nginx, PHP 8.5 and MariaDB; verify the services.' }).token);
  return { ai, ssh, auth, target, calls, commands, signals, automation, start, finish, activate: id => { active = id; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('delegation requires explicit goal consent, runs sequentially, reads final failure and verifies before completion', async t => {
  const f = fixture(t, [{ action: 'run', summary: '서버 상태 확인', command: 'cat /etc/os-release' }, { action: 'run', summary: '설치 상태 확인', command: 'nginx -v' }, { action: 'done', summary: '버전을 확인했습니다', command: '' }]);
  f.ai.sessions.get('first').history = [{ role: 'user', content: 'UNRELATED_OLD_GOAL' }];
  const p = f.automation.prepare({ sessionId: 'first', model: 'model', goal: 'Install nginx' }); assert.deepEqual(f.commands, []);
  assert.throws(() => f.automation.start('invalid'), { code: 'E-DELEGATION-STALE' }); assert.deepEqual(f.commands, []);
  f.start(); await tick(); assert.deepEqual(f.commands, ['cat /etc/os-release']);
  assert.equal(f.calls.length, 1); f.finish('package unavailable password=private', 1); await tick();
  assert.deepEqual(f.commands, ['cat /etc/os-release', 'nginx -v']); const payload = JSON.stringify(f.calls[1]);
  assert.match(payload, /failed/); assert.match(payload, /exitCode/); assert.ok(!payload.includes('private')); assert.ok(!payload.includes('UNRELATED_OLD_GOAL'));
  f.finish('nginx/1.28'); await f.automation.running; assert.equal(f.automation.state().reason, 'completed'); assert.equal(f.automation.state().enabled, false); assert.equal(f.calls.length, 3);
  assert.match(JSON.stringify(f.calls[2]), /nginx\/1.28/); assert.equal(f.ai.sessions.get('first').history[0].content, 'UNRELATED_OLD_GOAL');
});
test('stop aborts in-flight planning and cannot execute a late response', async t => {
  let release;
  const f = fixture(t, [options => new Promise(resolve => { release = () => resolve(new Response('data: {"type":"response.output_text.delta","delta":"{\\"action\\":\\"run\\",\\"summary\\":\\"late\\",\\"command\\":\\"whoami\\"}"}\n\ndata: {"type":"response.completed"}\n\n')); assert.equal(options.signal.aborted, false); })]);
  f.start(); await tick(); f.automation.stop(); release(); await f.automation.running; assert.deepEqual(f.commands, []); assert.equal(f.automation.state().enabled, false);
});
test('stop during execution requests TERM, releases wait and never starts another command', async t => {
  const f = fixture(t, [{ action: 'run', summary: 'Install', command: 'apt-get install -y nginx' }]); f.start(); await tick();
  assert.equal(f.commands.length, 1); f.automation.stop(); await f.automation.running; assert.deepEqual(f.signals, ['1']); f.finish('late result'); await tick(); assert.equal(f.calls.length, 1);
});
test('generation, account and tab changes revoke delegation and result sharing', async t => {
  for (const change of ['generation', 'account', 'tab']) {
    const f = fixture(t, [{ action: 'run', summary: 'Check', command: 'whoami' }]); f.start(); await tick();
    if (change === 'generation') { f.target.generation = 'two'; f.ssh.emit('session', f.target); }
    if (change === 'account') f.auth.emit('change', {});
    if (change === 'tab') { f.activate('second'); f.finish('late'); }
    await f.automation.running; assert.equal(f.automation.state().enabled, false); assert.equal(f.calls.length, 1);
  }
});
test('manual approval shares only its own final result once and never executes suggested next command', async t => {
  const f = fixture(t, ['다음 작업을 검토하세요.\n```sh\nnginx -t\n```']); const e = f.ssh.prepareExecution('first', 'php -v'); f.automation.approve(e.token, true);
  f.ssh.emit('observed-output', { sessionId: 'second', generation: 'one', executionId: e.id, data: 'OTHER_SECRET' });
  await tick(); assert.equal(f.calls.length, 0); f.finish('PHP 8.5 stdout'); await tick();
  assert.equal(f.calls.length, 1); const payload = JSON.stringify(f.calls[0]); assert.match(payload, /PHP 8.5 stdout/); assert.ok(!payload.includes('OTHER_SECRET')); assert.match(payload, /completed/); assert.deepEqual(f.commands, ['php -v']);
  f.ssh.emit('execution', { ...e }); await tick(); assert.equal(f.calls.length, 1);
});
test('long-running commands remain active beyond the former command and task time limits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, [{ action: 'run', summary: 'Install and verify', command: 'apt-get install -y nginx' }, { action: 'done', summary: 'Verified', command: '' }]);
  f.start(); await tick(); t.mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(f.automation.state().enabled, true); assert.deepEqual(f.signals, []); assert.equal(f.commands.length, 1);
  f.finish('Installed nginx'); await f.automation.running; assert.equal(f.automation.state().reason, 'completed');
});
test('delegation continues beyond thirty steps and retains its goal and progress checkpoint', async t => {
  const steps = Array.from({ length: 35 }, (_, i) => ({ action: 'run', summary: `Completed subgoals checkpoint ${i}; next verification`, command: 'nginx -t' }));
  const f = fixture(t, [...steps, { action: 'done', summary: 'All subgoals verified', command: '' }]); f.start();
  for (let i = 0; i < 35; i++) { await tick(); assert.equal(f.commands.length, i + 1); f.finish(`Verified step ${i}`); }
  await f.automation.running; assert.equal(f.automation.state().steps, 35); assert.equal(f.automation.state().reason, 'completed');
  assert.match(f.calls[34].input.at(-1).content, /checkpoint 33/); assert.match(f.calls[34].input.at(-1).content, /Install nginx, PHP 8.5 and MariaDB/);
});
test('delegation refuses malformed action, hidden control and additional confirmation operations', async t => {
  for (const text of ['```json\n{}\n```', '{"action":"run","command":"whoami","summary":"ok","extra":true}', JSON.stringify({ action: 'run', command: 'whoami\r', summary: 'x' })]) assert.throws(() => action(text), { code: 'E-DELEGATION-RESPONSE' });
  const f = fixture(t, [{ action: 'run', summary: 'Delete', command: 'rm -rf /srv/database' }]); f.start(); await f.automation.running; assert.equal(f.automation.state().reason, 'needs-input'); assert.deepEqual(f.commands, []);
});
test('delegation cannot report completion without an observed successful execution', async t => {
  const f = fixture(t, [{ action: 'done', summary: '완료 주장', command: '' }]); f.start(); await f.automation.running; assert.equal(f.automation.state().reason, 'needs-input'); assert.deepEqual(f.commands, []);
});
test('manual approval opt-out and cancelled follow-up never transmit results', async t => {
  const f = fixture(t, []); let e = f.ssh.prepareExecution('first', 'php -v'); f.automation.approve(e.token, false); f.finish('DO_NOT_SHARE'); await tick(); assert.equal(f.calls.length, 0);
  e = f.ssh.prepareExecution('first', 'php -v'); f.automation.approve(e.token, true); f.automation.stop('cancelled'); f.finish('AFTER_CANCEL_DO_NOT_SHARE'); await tick(); assert.equal(f.calls.length, 0);
});

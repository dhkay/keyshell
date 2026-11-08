'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Automation, action } = require('../src/main/automation.cjs');
const { AIService } = require('../src/main/ai-service.cjs');
function fixture(t, responses, options = {}) {
  let active = 'first';
  const target = { sessionId: 'first', generation: 'one', status: 'connected', username: 'tester', host: '192.0.2.44', port: 22 };
  const auth = new EventEmitter(); auth.activeId = 'account'; auth.store = { getTokens: () => ({}) }; auth.accessToken = async () => 'fixture';
  const calls = [], commands = [], signals = [];
  const ai = new AIService({ auth, fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const response = responses.shift(); if (typeof response === 'function') return response(options);
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: {"type":"response.completed"}\n\n`);
  } }); ai.catalog = [{ slug: 'model' }]; ai.setModel('first', 'model'); ai.protectHost('first', target.host);
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
  assert.equal(f.calls.length, 1); f.finish('package unavailable password=private host=192.0.2.44 peer=198.51.100.8 API_KEY=DELEGATED_KEY_VALUE', 1); await tick();
  assert.deepEqual(f.commands, ['cat /etc/os-release', 'nginx -v']); const payload = JSON.stringify(f.calls[1]);
  assert.match(payload, /failed/); assert.match(payload, /exitCode/); assert.ok(!payload.includes('private')); assert.ok(!payload.includes('192.0.2.44')); assert.match(payload, /198\.51\.100\.8/); assert.ok(!payload.includes('DELEGATED_KEY_VALUE')); assert.ok(!payload.includes('UNRELATED_OLD_GOAL'));
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
test('agent rejects malformed tool actions and hidden controls', () => {
  for (const text of ['```json\n{}\n```', '{"action":"run","command":"whoami","summary":"ok","extra":true}', JSON.stringify({ action: 'run', command: 'whoami\r', summary: 'x' })]) assert.throws(() => action(text), { code: 'E-DELEGATION-RESPONSE' });
});
test('reboot-required status checks are not mistaken for reboot commands', async t => {
  const check = "printf '\\n=== Reboot requirement ===\\n'; if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required; else printf 'No reboot-required marker\\n'; fi";
  const f = fixture(t, [
    { action: 'plan', summary: '상태 점검', command: '', tasks: ['재부팅 필요 여부 확인', '결과 확인'] },
    { action: 'run', task: 1, summary: '상태 파일 확인', command: check },
    { action: 'run', task: 2, summary: 'OS 확인', command: 'cat /etc/os-release' },
    { action: 'done', task: 2, summary: '상태 점검 완료', command: '' }
  ]);
  f.automation.arm({ sessionId: 'first', model: 'model' });
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '서버 상태를 순서대로 점검해줘' });
  await tick(); assert.deepEqual(f.commands, [check]);
  f.finish('No reboot-required marker'); await tick();
  assert.deepEqual(f.commands, [check, 'cat /etc/os-release']);
  assert.match(JSON.stringify(f.calls[2]), /No reboot-required marker/);
  f.finish('Ubuntu 24.04 LTS'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
});
test('AI authority uses Responses function tools and returns observed SSH output before the next decision', async t => {
  const call = (name, args, id) => () => {
    const item = { type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, status: 'completed' };
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [item] } })}\n\n`);
  };
  const f = fixture(t, [
    call('set_plan', { summary: 'OS 점검 계획', tasks: ['OS 확인', '상태 검증'] }, 'call_plan1'),
    call('ssh_command', { summary: 'OS 확인', command: 'cat /etc/os-release', task: 1 }, 'call_exec1'),
    call('ssh_command', { summary: '상태 검증', command: 'uname -r', task: 2 }, 'call_exec2'),
    call('finish_task', { summary: 'OS와 커널 확인 완료', task: 2 }, 'call_done1')
  ]);
  f.automation.arm({ sessionId: 'first', model: 'model' });
  f.automation.submit({ sessionId: 'first', model: 'model', goal: 'OS와 커널 점검' });
  await tick(); assert.deepEqual(f.commands, ['cat /etc/os-release']);
  assert.equal(f.calls[0].tools?.[0]?.name, 'set_plan');
  assert.equal(f.calls[0].parallel_tool_calls, false);
  assert.match(JSON.stringify(f.calls[1].input), /call_plan1/);
  f.finish('Ubuntu 24.04 password=private 192.0.2.44'); await tick();
  assert.deepEqual(f.commands, ['cat /etc/os-release', 'uname -r']);
  const followUp = JSON.stringify(f.calls[2].input);
  assert.match(followUp, /call_exec1/);
  assert.match(followUp, /Ubuntu 24.04/);
  assert.doesNotMatch(followUp, /private|192\.0\.2\.44/);
  f.finish('6.8.0-generic'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
});
test('AI authority executes requested server maintenance without a second command review', async t => {
  const f = fixture(t, [{ action: 'plan', summary: '패키지 유지관리', command: '', tasks: ['패키지 업데이트'] }, { action: 'run', summary: '패키지 업데이트', task: 1, command: 'sudo apt-get update && sudo apt-get upgrade -y' }, { action: 'done', summary: '패키지 확인 완료', task: 1, command: '' }]);
  f.automation.arm({ sessionId: 'first', model: 'model' });
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '패키지를 업데이트해줘' });
  await tick(); assert.deepEqual(f.commands, ['sudo apt-get update && sudo apt-get upgrade -y']);
  f.finish('0 upgraded'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
});
test('a progress reply keeps the server task active until execution and verification finish', async t => {
  const f = fixture(t, [
    { action: 'plan', summary: '점검 순서', command: '', tasks: ['OS 확인'] },
    { action: 'reply', summary: 'OS 정보를 확인하고 있습니다.', command: '' },
    { action: 'run', summary: 'OS 확인', task: 1, command: 'cat /etc/os-release' },
    { action: 'done', summary: 'OS 확인 완료', task: 1, command: '' }
  ]);
  f.automation.submit({ sessionId: 'first', model: 'model', goal: 'OS를 점검해줘' });
  await tick(); assert.deepEqual(f.commands, ['cat /etc/os-release']);
  f.finish('Ubuntu 24.04'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
});
test('delegation cannot report completion without an observed successful execution', async t => {
  const f = fixture(t, [{ action: 'done', summary: '완료 주장', command: '' }]); f.start(); await f.automation.running; assert.equal(f.automation.state().reason, 'needs-input'); assert.deepEqual(f.commands, []);
});
test('manual approval opt-out and cancelled follow-up never transmit results', async t => {
  const f = fixture(t, []); let e = f.ssh.prepareExecution('first', 'php -v'); f.automation.approve(e.token, false); f.finish('DO_NOT_SHARE'); await tick(); assert.equal(f.calls.length, 0);
  e = f.ssh.prepareExecution('first', 'php -v'); f.automation.approve(e.token, true); f.automation.stop('cancelled'); f.finish('AFTER_CANCEL_DO_NOT_SHARE'); await tick(); assert.equal(f.calls.length, 0);
});

test('ordinary SSH chat automatically starts server AI and keeps context for later messages', async t => {
  const f = fixture(t, [{ action: 'plan', summary: '작업 순서', command: '', tasks: ['버전 확인'] }, { action: 'ask', summary: '필요한 버전을 알려주세요', command: '' }, { action: 'plan', summary: '작업 순서', command: '', tasks: ['다음 확인'] }, { action: 'ask', summary: '다음 작업 확인', command: '' }]);
  const notices = []; f.automation.on('notice', n => notices.push(n.text));
  const input = { sessionId: 'first', model: 'model', goal: 'Install nginx' };
  f.automation.submit(input); await f.automation.running; assert.equal(f.automation.state().armed, true);
  f.automation.submit({ ...input, goal: 'Version 1.28' }); await f.automation.running; assert.equal(f.calls.length, 4);
  assert.equal(notices.filter(n => n.startsWith('서버 AI가')).length, 1);
  f.automation.stop(); assert.equal(f.automation.state().armed, false);
});
test('idle delegation mode is revoked on account and connection changes', t => {
  const f = fixture(t, []); const input = { sessionId: 'first', model: 'model' };
  f.automation.arm(input); f.auth.emit('change'); assert.equal(f.automation.state().armed, false);
  f.ai.catalog = [{ slug: 'model' }]; f.automation.arm(input); f.target.generation = 'two'; f.ssh.emit('session', f.target); assert.equal(f.automation.state().armed, false);
});
test('masked command pauses delegation and never reaches the SSH shell', async t => {
  const f = fixture(t, [{ action: 'plan', summary: '연결 순서', command: '', tasks: ['연결'] }, { action: 'run', summary: '연결', command: 'curl http://****/' }]); f.start(); await f.automation.running;
  assert.deepEqual(f.commands, []); assert.equal(f.automation.state().reason, 'needs-input');
});

test('delegated plan displays ordered tasks, runs sequentially and reports concise completion', async t => {
  const f = fixture(t, [
    { action: 'plan', summary: '작업 순서', command: '', tasks: ['OS 확인', '서비스 버전 확인'] },
    { action: 'run', task: 1, summary: 'OS를 확인합니다', command: 'cat /etc/os-release' },
    { action: 'run', task: 2, summary: '버전을 확인합니다', command: 'nginx -v' },
    { action: 'done', task: 2, summary: '두 항목을 확인했습니다', command: '' }
  ]);
  const notices = []; f.automation.on('notice', d => notices.push(d.text));
  f.automation.arm({ sessionId: 'first', model: 'model' });
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '서버 점검' });
  await tick(); assert.equal(f.commands.length, 1); assert.match(notices.join('\n'), /작업 목록\n1\. OS 확인\n2\. 서비스 버전 확인/);
  assert.equal(f.automation.state().tasks[0].status, 'running');
  f.finish('Ubuntu'); await tick(); assert.deepEqual(f.commands, ['cat /etc/os-release', 'nginx -v']);
  assert.equal(f.automation.state().tasks[0].status, 'completed');
  f.finish('nginx/1.28'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
  assert.match(notices.at(-1), /^완료: 2개 작업 확인/);
});
test('AI authority may start a requested task with a command even before a separate plan', async t => {
  const f = fixture(t, [{ action: 'run', summary: '바로 실행', command: 'whoami' }]);
  f.automation.arm({ sessionId: 'first', model: 'model' });
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '점검' });
  await tick(); assert.deepEqual(f.commands, ['whoami']);
  f.automation.stop(); await f.automation.running;
});
test('delegation polls local execution state every three seconds without sending another SSH command', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, [{ action: 'plan', summary: '순서', command: '', tasks: ['점검'] }, { action: 'run', task: 1, summary: '기다리는 점검', command: 'sleep 99' }, { action: 'done', task: 1, summary: '확인 완료', command: '' }]);
  f.automation.arm({ sessionId: 'first', model: 'model' }); f.automation.submit({ sessionId: 'first', model: 'model', goal: '점검' }); await tick();
  t.mock.timers.tick(3000); await tick(); assert.match(f.automation.state().phase, /3초 간격/); assert.deepEqual(f.commands, ['sleep 99']);
  f.finish('finished'); await f.automation.running; assert.equal(f.automation.state().reason, 'completed');
});

test('a repeated plan after task-list creation is corrected and delegation continues on the same server', async t => {
  const plan = { action: 'plan', summary: '작업 순서', command: '', tasks: ['읽기 전용 보안 점검', '결과 확인'] };
  const f = fixture(t, [plan, plan, { action: 'run', task: 1, summary: 'OS 확인', command: 'cat /etc/os-release' }, { action: 'run', task: 2, summary: '포트 확인', command: 'ss -lnt' }, { action: 'done', task: 2, summary: '결과 확인 완료', command: '' }]);
  f.automation.arm({ sessionId: 'first', model: 'model' }); f.automation.submit({ sessionId: 'first', model: 'model', goal: '서버 취약점 분석' });
  await tick(); assert.deepEqual(f.commands, ['cat /etc/os-release']); assert.equal(f.automation.state().armed, true);
  assert.match(f.calls[2].input.at(-1).content, /다시 plan을 만들지 말고/);
  f.finish('Ubuntu'); await tick(); assert.deepEqual(f.commands, ['cat /etc/os-release', 'ss -lnt']);
  f.finish('LISTEN'); await f.automation.running; assert.equal(f.automation.state().reason, 'completed'); assert.equal(f.automation.state().armed, true);
});
test('repeated invalid planning pauses the current task while leaving the same session delegation ON', async t => {
  const plan = { action: 'plan', summary: '작업 순서', command: '', tasks: ['OS 확인'] };
  const f = fixture(t, [plan, plan, plan, plan]);
  f.automation.arm({ sessionId: 'first', model: 'model' }); f.automation.submit({ sessionId: 'first', model: 'model', goal: '서버 점검' });
  await f.automation.running; assert.deepEqual(f.commands, []); assert.equal(f.automation.state().reason, 'needs-input'); assert.equal(f.automation.state().armed, true);
});

test('AI authority answers a normal chat message, remembers it, then executes a requested server task', async t => {
  const f = fixture(t, [
    { action: 'reply', summary: '현재 세션에서 작업을 도와드릴게요.', command: '' },
    { action: 'plan', summary: '점검 순서', command: '', tasks: ['OS 확인'] },
    { action: 'run', task: 1, summary: 'OS 확인', command: 'cat /etc/os-release' },
    { action: 'done', task: 1, summary: '점검 완료', command: '' }
  ]);
  f.automation.arm({ sessionId: 'first', model: 'model' });
  const notices = []; f.automation.on('notice', n => notices.push(n.text));
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '무엇을 할 수 있어?' }); await f.automation.running;
  assert.deepEqual(f.commands, []); assert.match(notices.join('\n'), /도와드릴게요/); assert.equal(f.automation.state().armed, true);
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '서버 OS를 확인해줘' }); await tick();
  assert.deepEqual(f.commands, ['cat /etc/os-release']); assert.match(f.calls[1].input.at(-1).content, /무엇을 할 수 있어/);
  f.finish('Ubuntu'); await f.automation.running; assert.equal(f.automation.state().reason, 'completed');
});

test('AI authority accepts a user follow-up during a running command and reads it before the next decision', async t => {
  const f = fixture(t, [
    { action: 'plan', summary: '점검', command: '', tasks: ['OS 확인'] },
    { action: 'run', task: 1, summary: 'OS 확인', command: 'cat /etc/os-release' },
    { action: 'done', task: 1, summary: '추가 질문까지 확인했습니다', command: '' }
  ]);
  f.automation.arm({ sessionId: 'first', model: 'model' }); f.automation.submit({ sessionId: 'first', model: 'model', goal: '서버를 점검해줘' }); await tick();
  f.automation.submit({ sessionId: 'first', model: 'model', goal: 'Ubuntu 지원 기간도 함께 알려줘' });
  assert.deepEqual(f.commands, ['cat /etc/os-release']); f.finish('Ubuntu'); await f.automation.running;
  assert.match(f.calls[2].input.at(-1).content, /Ubuntu 지원 기간도 함께 알려줘/); assert.deepEqual(f.commands, ['cat /etc/os-release']);
});

test('premature finish is rejected and the original task list advances through the remaining commands', async t => {
  const f = fixture(t, [
    { action: 'plan', summary: '업그레이드 순서', command: '', tasks: ['현재 상태', '백업', '업그레이드 후 검증'] },
    { action: 'run', task: 1, summary: 'OS 확인', command: 'cat /etc/os-release' },
    { action: 'done', task: 3, summary: '업그레이드 완료', command: '' },
    { action: 'run', task: 2, summary: '백업 확인', command: 'ls /var/backups' },
    { action: 'run', task: 3, summary: '최종 버전 확인', command: 'cat /etc/os-release' },
    { action: 'done', task: 3, summary: '확인 완료', command: '' }
  ]);
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '서버 업그레이드' });
  await tick(); f.finish('Ubuntu 24.04'); await tick();
  assert.deepEqual(f.commands, ['cat /etc/os-release', 'ls /var/backups']);
  assert.match(f.calls[3].input.at(-1).content, /실행 증거가 부족/);
  f.finish('backup.tar'); await tick(); f.finish('Ubuntu 26.04'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
  assert.equal(f.automation.state().tasks.length, 0);
});

test('tool request for interactive sudo pauses and a chat follow-up resumes the same task list', async t => {
  const call = (name, args, id) => () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, status: 'completed' }] } })}\n\n`);
  const f = fixture(t, [
    call('set_plan', { summary: '패키지 점검', tasks: ['sudo 인증', '업데이트 검증'] }, 'call_plan'),
    call('request_user_action', { prompt: '권한이 필요합니다. 터미널에서 sudo apt update를 실행해 주세요.', command: 'sudo apt update', task: 1 }, 'call_action'),
    call('ssh_command', { summary: '현재 패키지 상태 재확인', command: 'apt list --upgradable', task: 1 }, 'call_check'),
    call('ssh_command', { summary: '결과 검증', command: 'cat /etc/os-release', task: 2 }, 'call_verify'),
    call('finish_task', { summary: '검증 완료', task: 2 }, 'call_done')
  ]);
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '패키지 업데이트' }); await f.automation.running;
  assert.equal(f.automation.state().paused, true);
  assert.equal(f.automation.state().armed, true);
  assert.equal(f.automation.state().tasks.length, 2);
  assert.equal(f.automation.state().userAction.command, 'sudo apt update');
  assert.deepEqual(f.commands, []);
  f.automation.stop('manual-takeover');
  assert.equal(f.automation.state().paused, true);
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '터미널에서 실행했어. 상태를 확인해줘' });
  await tick(); assert.deepEqual(f.commands, ['apt list --upgradable']);
  assert.match(JSON.stringify(f.calls[2]), /기존 작업 목록을 이어서/);
  f.finish('Listing...'); await tick(); f.finish('Ubuntu 24.04'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
});

test('an interactive sudo prompt interrupts the blocked AI command and offers sudo -v without rerunning it', async t => {
  const f = fixture(t, [
    { action: 'plan', summary: '업데이트 순서', command: '', tasks: ['업데이트', '검증'] },
    { action: 'run', task: 1, summary: '패키지 갱신', command: 'sudo apt update' },
    { action: 'run', task: 1, summary: '상태 재확인', command: 'id -u' },
    { action: 'run', task: 2, summary: '최종 검증', command: 'cat /etc/os-release' },
    { action: 'done', task: 2, summary: '검증 완료', command: '' }
  ]);
  const requests = []; f.automation.on('user-action', value => requests.push(value));
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '패키지 업데이트' }); await tick();
  assert.deepEqual(f.commands, ['sudo apt update']);
  const e = [...f.ssh.executions.values()].at(-1);
  f.ssh.emit('observed-output', { sessionId: 'first', generation: 'one', executionId: e.id, stream: 'stdout', data: '[sudo] password for tester:' });
  await f.automation.running;
  assert.deepEqual(f.signals, [e.id]);
  assert.equal(f.automation.state().paused, true);
  assert.equal(requests[0].command, 'sudo -v');
  assert.equal(f.automation.state().tasks.length, 2);
  f.automation.submit({ sessionId: 'first', model: 'model', goal: 'sudo 인증을 마쳤어. 상태를 다시 확인해줘' });
  await tick(); assert.deepEqual(f.commands, ['sudo apt update', 'id -u']);
  f.finish('0'); await tick(); f.finish('Ubuntu 24.04'); await f.automation.running;
  assert.equal(f.automation.state().reason, 'completed');
});

test('a chat message arriving while a plain reply is emitted becomes the next task', async t => {
  const f = fixture(t, [
    { action: 'reply', summary: '첫 질문에 답했습니다.', command: '' },
    { action: 'plan', summary: '서버 점검', command: '', tasks: ['OS 확인'] },
    { action: 'run', task: 1, summary: 'OS 확인', command: 'cat /etc/os-release' },
    { action: 'done', task: 1, summary: 'OS 점검 완료', command: '' }
  ]);
  f.automation.on('notice', value => { if (value.text === '첫 질문에 답했습니다.') f.automation.submit({ sessionId: 'first', model: 'model', goal: '이어서 서버 OS를 확인해줘' }); });
  f.automation.submit({ sessionId: 'first', model: 'model', goal: '안녕' });
  await tick();
  assert.deepEqual(f.commands, ['cat /etc/os-release']);
  f.finish('Ubuntu'); await tick();
  assert.equal(f.automation.state().reason, 'completed');
  assert.equal(f.calls.length, 4);
});

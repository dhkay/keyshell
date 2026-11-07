'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SharedTerminal } = require('../src/main/shared-terminal.cjs');
const { SSHService } = require('../src/main/ssh-service.cjs');
const { Store } = require('../src/main/store.cjs');
const { Server } = require('ssh2');
const { spawn } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const wait = async predicate => { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 7000) throw new Error('condition timeout'); await new Promise(r => setTimeout(r, 10)); } };
function protocol(t) {
  const writes = [], output = [], results = []; const terminal = new SharedTerminal({ write: d => writes.push(d), output: (data, id) => output.push({ data, id }), changed() {}, finished: (...r) => results.push(r) });
  t.after(() => terminal.dispose()); const frame = text => `\x1eKS:${terminal.secret}:${text}\x1f`;
  terminal.initialize(); terminal.push('WELCOME\r\n' + writes[0].replace(/\r$/, '\r\n')); terminal.push(frame('I')); terminal.push(frame('P'));
  return { terminal, writes, output, results, frame };
}
test('shared protocol strips split markers and wrapper echo; completion waits for the real prompt', t => {
  const f = protocol(t); assert.equal(f.terminal.ready, true); assert.match(f.output.map(o => o.data).join(''), /WELCOME/); assert.ok(!f.output.some(o => o.data.includes('__KS_INIT_')));
  assert.equal(f.terminal.start('execution', 'printf "한글"; false'), true); const nonce = f.terminal.owner.nonce;
  assert.equal(f.terminal.start('other', 'whoami'), false); f.terminal.push('WRAPPER_ECHO_MUST_BE_HIDDEN\r\n');
  const bytes = Buffer.from(f.frame('S:' + nonce) + '한글 result\r\n' + f.frame('D:' + nonce + ':1'));
  for (let i = 0; i < bytes.length; i++) f.terminal.push(bytes.subarray(i, i + 1));
  assert.equal(f.results.length, 0); assert.equal(f.terminal.ready, false); f.terminal.push(f.frame('P'));
  assert.equal(f.results[0][1], 'failed'); assert.equal(f.results[0][2].exitCode, 1); assert.equal(f.terminal.ready, true);
  const visible = f.output.map(o => o.data).join(''); assert.ok(!visible.includes('WRAPPER_ECHO')); assert.ok(!visible.includes(f.terminal.secret)); assert.match(f.output.filter(o => o.id === 'execution').map(o => o.data).join(''), /한글 result/);
});
test('manual input revokes readiness; takeover unlocks with unknown result and requires a fresh prompt', t => {
  const f = protocol(t); f.terminal.manual(); assert.equal(f.terminal.start('one', 'whoami'), false); f.terminal.push(f.frame('P')); assert.equal(f.terminal.start('one', 'sleep 10'), true);
  f.terminal.takeControl(); assert.equal(f.results[0][1], 'unknown'); assert.equal(f.results[0][2].remoteTerminationConfirmed, false); assert.equal(f.terminal.owner, null); assert.equal(f.terminal.ready, false); assert.equal(f.writes.at(-1), '\x03');
  f.terminal.push('\x1eKS:wrong-secret:P\x1f'); assert.equal(f.terminal.ready, false); f.terminal.push(f.frame('P')); assert.equal(f.terminal.ready, true);
});
test('prompt after interruption has no invented zero exit code', t => {
  const f = protocol(t); f.terminal.start('one', 'sleep 10'); f.terminal.interrupt(); f.terminal.push(f.frame('P')); assert.equal(f.results[0][1], 'interrupted'); assert.equal(f.results[0][2].exitCode, null);
});
test('real shared SSH PTY preserves manual and AI context, blocks overlapping input and never opens exec', { skip: process.platform !== 'linux', timeout: 25000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyshell-shared-pty-')), clients = new Set(), children = new Set(); let execCount = 0, shellCount = 0;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client)); client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.()); session.on('exec', (_a, reject) => { execCount++; reject(); });
      session.on('shell', accept => {
        shellCount++; const stream = accept(), child = spawn('script', ['-qefc', 'bash --noprofile --norc -i', '/dev/null'], { cwd: directory, env: { ...process.env, TERM: 'xterm-256color' } }); children.add(child);
        child.stdout.on('data', d => stream.write(d)); child.stderr.on('data', d => stream.write(d)); child.stdin.on('error', () => {}); stream.on('data', d => child.stdin.write(d)); stream.on('error', () => {}); stream.on('close', () => { child.stdin.end(); child.kill(); }); child.on('exit', code => { children.delete(child); stream.exit(code || 0); stream.end(); });
      });
    }));
  }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const service = new SSHService({ store: new Store(directory), sharedTerminal: true });
  t.after(async () => { service.dispose(); for (const c of clients) { c.end(); c._sock?.destroy(); } for (const c of children) { c.stdin.end(); c.kill(); } await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  const observed = [], visible = []; service.on('observed-output', d => observed.push(d)); service.on('output', d => visible.push(d));
  const host = once(service, 'host-key'), connecting = service.connect({ host: '127.0.0.1', port: server.address().port, username: 'tester' }, { type: 'password', password: 'fixture' }); const [h] = await host; service.answerHostKey(h.challengeId, true); const meta = await connecting;
  const ready = () => service.listSessions()[0].terminalReady; await wait(ready);
  service.write(meta.sessionId, "cd /tmp; export KEYSHELL_SHARED_CONTEXT='kept from human'\r"); await wait(ready);
  const run = async command => { const e = service.prepareExecution(meta.sessionId, command); assert.equal(e.context.channel, 'shared-terminal'); service.approveExecution(e.token); assert.equal(service.listSessions()[0].terminalInputLocked, true); assert.throws(() => service.write(meta.sessionId, 'unexpected'), { code: 'E-TERM-AI-BUSY' }); await wait(() => ['completed','failed','unknown','interrupted'].includes(service.executions.get(e.id).status)); return service.executions.get(e.id); };
  const first = await run('pwd; printf "%s\\n" "$KEYSHELL_SHARED_CONTEXT"; false'); assert.equal(first.exitCode, 1); assert.equal(first.status, 'failed'); assert.match(observed.filter(d => d.executionId === first.id).map(d => d.data).join(''), /\/tmp[\s\S]*kept from human/);
  await run(`cd '${directory}'; export KEYSHELL_SHARED_CONTEXT='kept from AI'`);
  const second = await run('pwd; printf "%s\\n" "$KEYSHELL_SHARED_CONTEXT"'); assert.match(observed.filter(d => d.executionId === second.id).map(d => d.data).join(''), /keyshell-shared-pty-[\s\S]*kept from AI/);
  const pending = service.prepareExecution(meta.sessionId, 'whoami'); service.write(meta.sessionId, 'echo human draft'); assert.throws(() => service.approveExecution(pending.token), { code: 'E-TERM-NOT-READY' }); service.write(meta.sessionId, '\x03'); await wait(ready);
  const held = service.prepareExecution(meta.sessionId, 'sleep 10'); service.approveExecution(held.token); await new Promise(r => setTimeout(r, 100)); service.takeControl(meta.sessionId); assert.equal(service.executions.get(held.id).status, 'unknown'); assert.equal(service.listSessions()[0].terminalInputLocked, false); await wait(ready);
  assert.equal(shellCount, 1); assert.equal(execCount, 0); assert.ok(visible.every(d => d.channel === 'terminal')); assert.ok(!visible.some(d => d.data.includes('__KS_INIT_'))); assert.match(visible.map(d => d.data).join(''), /\[AI\]/);
  assert.ok(!observed.some(d => /\[AI(?: |\])/.test(d.data)), 'local execution labels are not remote output');
  const disconnecting = service.prepareExecution(meta.sessionId, 'sleep 10'); service.approveExecution(disconnecting.token); service.disconnect(meta.sessionId); assert.equal(service.executions.get(disconnecting.id).status, 'unknown'); assert.equal(service.listSessions()[0].terminalInputLocked, false);
});

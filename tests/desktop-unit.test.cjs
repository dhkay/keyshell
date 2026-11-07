'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedFrame } = require('../src/main/ipc.cjs');
test('IPC rejects subframes, unexpected origins and other WebContents', () => {
  const frame = { url: 'keyshell://app/index.html' }, wc = { mainFrame: frame }, window = { webContents: wc };
  assert.equal(trustedFrame({ senderFrame: frame, sender: wc }, window), true);
  assert.equal(trustedFrame({ senderFrame: { url: frame.url }, sender: wc }, window), false);
  assert.equal(trustedFrame({ senderFrame: frame, sender: {} }, window), false);
  frame.url = 'https://attacker.invalid'; assert.equal(trustedFrame({ senderFrame: frame, sender: wc }, window), false);
});
const { EventEmitter } = require('node:events');
const { installIPC } = require('../src/main/ipc.cjs');
const { validateProfile } = require('../src/main/policy.cjs');
const { UpdateService, repository } = require('../src/main/update-service.cjs');
test('profile groups validate and preserve an explicit group', () => {
  const p = { host: 'localhost', port: 22, username: 'tester', group: 'Production' };
  assert.equal(validateProfile(p).group, 'Production');
  assert.throws(() => validateProfile({ ...p, group: 'Invented' }));
});
test('IPC tab/account invalidation cancels only pending execution approvals and stale paste tokens', async () => {
  const frame = { url: 'keyshell://app/index.html' }, wc = { mainFrame: frame, send() {} }, window = { webContents: wc, isDestroyed: () => false };
  const ssh = new EventEmitter(); ssh.executions = new Map([['pending', { id: 'pending', status: 'pending' }], ['running', { id: 'running', status: 'running' }]]);
  ssh.listSessions = () => [{ sessionId: 'first', status: 'connected', generation: 'one' }, { sessionId: 'second', status: 'connected', generation: 'two' }]; ssh.cancelExecution = id => { ssh.executions.get(id).status = 'cancelled'; };
  const ai = new EventEmitter(); let invalidations = 0; ai.invalidatePreviews = () => invalidations++;
  const auth = new EventEmitter(), updates = new EventEmitter(); let handler;
  const ipcMain = { handle(_name, fn) { handler = fn; }, removeHandler() {} };
  const dispose = installIPC({ ipcMain, window, ssh, ai, auth, updates, store: {}, dialog: {}, app: {}, clipboard: {} });
  const event = { sender: wc, senderFrame: frame };
  assert.equal((await handler(event, 'activate', 'first')).ok, true);
  const preview = await handler(event, 'pastePreview', { id: 'first', data: 'one\ntwo' }); assert.equal(preview.ok, true);
  assert.equal((await handler(event, 'activate', 'second')).ok, true);
  assert.equal((await handler(event, 'paste', preview.value.token)).error, 'E-TERM-STALE');
  assert.equal(ssh.executions.get('pending').status, 'cancelled'); assert.equal(ssh.executions.get('running').status, 'running');
  auth.emit('change', {}); assert.ok(invalidations >= 3);
  assert.equal((await handler(event, 'constructor')).error, 'E-IPC-METHOD');
  dispose();
});
test('updates never download automatically, preserve work on deferral and reject development installation', async () => {
  const updater = new EventEmitter(); updater.autoDownload = true; updater.autoInstallOnAppQuit = true; let downloads = 0, installs = 0;
  updater.downloadUpdate = async () => downloads++; updater.quitAndInstall = () => installs++;
  const service = new UpdateService({ app: { isPackaged: false, getVersion: () => '0.1.0' }, updater, confirmClose: async () => false });
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  await assert.rejects(service.check(), { code: 'E-UPDATE-DEVELOPMENT-BUILD' });
  service.change({ status: 'downloaded' }); await assert.rejects(service.install(), { code: 'E-UPDATE-DEVELOPMENT-BUILD' });
  assert.equal(downloads, 0); assert.equal(installs, 0);
  updater.emit('error', new Error('must not expose URL or raw errors')); assert.equal(service.state.status, 'failed'); assert.equal(service.state.error, 'E-UPDATE-VERIFY-OR-NETWORK');
  assert.deepEqual(repository('owner/repo'), ['owner', 'repo']); for (const bad of [undefined, '../repo', 'https://github.com/owner/repo', 'a/b/c']) assert.throws(() => repository(bad));
});
test('review: verified signed update deferral reaches confirmation and preserves downloaded work', async () => {
  const updater = new EventEmitter(); let confirms = 0, installs = 0, checks = 0;
  updater.quitAndInstall = () => installs++; updater.checkForUpdates = async () => checks++;
  const service = new UpdateService({ app: { isPackaged: true, getVersion: () => '1.0.0' }, updater, platform: 'win32', releaseInfo: { keyshellSignedRelease: true, keyshellReleaseRepository: 'owner/repo' }, confirmClose: async () => { confirms++; return false; } });
  updater.emit('error', new Error('failure')); updater.emit('update-available', { version: '1.1.0', releaseNotes: 'notes' }); assert.equal(service.state.error, undefined);
  updater.emit('download-progress', { percent: 50 }); updater.emit('update-downloaded', { version: '1.1.0' }); assert.equal(service.state.percent, undefined);
  const before = structuredClone(service.state); assert.deepEqual(await service.install(), { cancelled: true }); assert.equal(confirms, 1); assert.equal(installs, 0); assert.deepEqual(service.state, before);
  await service.check(); assert.equal(checks, 0); assert.deepEqual(service.state, before); updater.emit('update-not-available'); assert.equal(service.state.notes, undefined); assert.equal(service.state.version, undefined);
});
test('review: reserved connect cancellation prevents start; closeTab resets AI; missing ended tabs remain removable', async () => {
  const frame = { url: 'keyshell://app/index.html' }, wc = { mainFrame: frame, send() {} }, window = { webContents: wc, isDestroyed: () => false };
  const ssh = new EventEmitter(); ssh.executions = new Map(); ssh.listSessions = () => []; let connects = 0; ssh.connect = async () => { connects++; }; const ai = new EventEmitter(); ai.sessions = new Map([['ended', { history: ['private'], model: 'a' }]]); ai.invalidatePreviews = () => {}; ai.resetSession = id => ai.sessions.delete(id);
  let handler; const ipcMain = { handle(_name, fn) { handler = fn; }, removeHandler() {} };
  const remove = installIPC({ ipcMain, window, ssh, ai, auth: new EventEmitter(), updates: new EventEmitter(), store: { saveProfile: p => p }, dialog: {}, app: {}, clipboard: {} });
  const event = { sender: wc, senderFrame: frame }, id = require('node:crypto').randomUUID();
  assert.equal((await handler(event, 'connect', { attemptId: id, profile: { host: 'localhost', port: 22, username: 'tester' }, credentials: { type: 'password', password: 'test' }, save: false })).ok, true);
  await handler(event, 'cancelConnect', id); assert.equal((await handler(event, 'startConnect', id)).error, 'E-SSH-CONNECT-CANCELLED'); assert.equal(connects, 0);
  assert.equal((await handler(event, 'activate', 'ended')).ok, true); assert.equal((await handler(event, 'closeTab', 'ended')).ok, true); assert.equal(ai.sessions.has('ended'), false);
  remove();
});
test('review: closing an SSH tab aborts its actual AI request and deletes private history', async () => {
  const { AIService } = require('../src/main/ai-service.cjs'), auth = new EventEmitter(); auth.activeId = 'a';
  const ai = new AIService({ auth }), controller = new AbortController(); ai.sessions.set('closed-tab', { history: [{ role: 'user', content: 'private' }], model: 'one' }); ai.requests.set('closed-tab', { controller, cancelled: false });
  const wc = { mainFrame: { url: 'keyshell://app/index.html' }, send() {} }, ssh = new EventEmitter(); ssh.executions = new Map(); ssh.listSessions = () => []; let handler;
  const remove = installIPC({ ipcMain: { handle(_name, fn) { handler = fn; }, removeHandler() {} }, window: { webContents: wc, isDestroyed: () => false }, ssh, ai, auth, updates: new EventEmitter(), store: {}, app: {}, clipboard: {}, dialog: {} });
  assert.equal((await handler({ sender: wc, senderFrame: wc.mainFrame }, 'closeTab', 'closed-tab')).ok, true); assert.equal(controller.signal.aborted, true); assert.equal(ai.sessions.has('closed-tab'), false);
  remove(); ai.dispose();
});
test('review: trust rotation IPC requires observed mismatch and explicit independent-verification confirmation', async () => {
  const old = { host: 'localhost', port: 22, keyType: 'ssh-rsa', fingerprint: 'SHA256:' + 'a'.repeat(43) }, next = { ...old, fingerprint: 'SHA256:' + 'b'.repeat(43) };
  const ssh = new EventEmitter(); ssh.executions = new Map(); ssh.listSessions = () => [{ sessionId: 'changed', ...next, error: 'E-SSH-HOSTKEY-CHANGED' }];
  const ai = new EventEmitter(); ai.invalidatePreviews = () => {}; let rotations = 0, handler;
  const wc = { mainFrame: { url: 'keyshell://app/index.html' }, send() {} }, event = { sender: wc, senderFrame: wc.mainFrame };
  const remove = installIPC({ ipcMain: { handle(_name, fn) { handler = fn; }, removeHandler() {} }, window: { webContents: wc, isDestroyed: () => false }, ssh, ai, auth: new EventEmitter(), updates: new EventEmitter(), store: { getKnownHost: () => old, rotateHost: (a, b) => { assert.deepEqual(a, old); assert.deepEqual(b, next); rotations++; } }, app: {}, clipboard: {}, dialog: {} });
  let p = await handler(event, 'rotatePreview', 'changed'); assert.deepEqual(p.value.old, old); assert.deepEqual(p.value.next, next);
  assert.equal((await handler(event, 'rotateConfirm', { token: p.value.token, verified: false })).error, 'E-SSH-HOSTKEY-ANSWER'); assert.equal(rotations, 0);
  p = await handler(event, 'rotatePreview', 'changed'); assert.equal((await handler(event, 'rotateConfirm', { token: p.value.token, verified: true })).ok, true); assert.equal(rotations, 1); assert.equal((await handler(event, 'rotateConfirm', { token: p.value.token, verified: true })).ok, false); remove();
});

test('clipboard paste is explicit, generation-bound and one-shot; context menu never reads clipboard before paste is chosen', async () => {
  let handler, menu; const events = [], writes = []; let reads = 0, generation = 'one';
  const ssh = new EventEmitter(); ssh.executions = new Map(); ssh.listSessions = () => [{ sessionId: 'first', status: 'connected', generation }]; ssh.write = (id, data) => { writes.push({ id, data }); return { accepted: true }; };
  const ai = new EventEmitter(); ai.invalidatePreviews = () => {}; const auth = new EventEmitter(), updates = new EventEmitter();
  const wc = { mainFrame: { url: 'keyshell://app/index.html' }, send: (_channel, event) => events.push(event) };
  const remove = installIPC({ ipcMain: { handle: (_name, fn) => { handler = fn; }, removeHandler() {} }, window: { webContents: wc, isDestroyed: () => false }, ssh, ai, auth, updates, store: {}, app: {}, dialog: {}, clipboard: { readText: async () => { reads++; return 'php -v'; }, async writeText() {} }, Menu: { buildFromTemplate: items => { menu = items; return { popup() {} }; } } });
  const event = { sender: wc, senderFrame: wc.mainFrame };
  try {
    await handler(event, 'activate', 'first');
    const stale = await handler(event, 'clipboardPastePreview', 'first'); assert.equal(reads, 1); assert.equal(writes.length, 0);
    generation = 'two'; assert.equal((await handler(event, 'paste', stale.value.token)).error, 'E-TERM-STALE');
    await handler(event, 'terminalContextMenu', { id: 'first', selection: 'selected' }); assert.equal(reads, 1); assert.equal(menu[1].label, '붙여넣기');
    await menu[1].click(); assert.equal(reads, 2); const paste = events.find(e => e.type === 'terminal-paste').detail.preview;
    assert.equal(writes.length, 0); assert.equal((await handler(event, 'paste', paste.token)).ok, true); assert.deepEqual(writes, [{ id: 'first', data: 'php -v' }]);
    assert.equal((await handler(event, 'paste', paste.token)).error, 'E-TERM-STALE');
    const multiple = await handler(event, 'pastePreview', { id: 'first', data: 'echo first\necho second\n' }); assert.equal(multiple.value.confirmationRequired, true); assert.equal(writes.length, 1);
    await handler(event, 'activate', 'general'); await menu[1].click(); assert.equal(reads, 2); assert.equal(events.at(-1).type, 'clipboard-error'); assert.equal(writes.length, 1);
  } finally { remove(); }
});

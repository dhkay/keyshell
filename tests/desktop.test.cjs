'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { Server } = require('ssh2');
const { _electron: electron } = require('playwright');
const { trustedFrame } = require('../src/main/ipc.cjs');
test('desktop UI: actual SSH, trust, selection, masked sharing, exec, paste and tab boundaries', { timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyshell-desktop-'));
  const evidence = path.resolve('docs/verification/desktop'); fs.mkdirSync(evidence, { recursive: true });
  const errors = [], commands = [], inputs = [], clients = new Set(); let authCount = 0, shellStream, heldExec, signals = 0;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => { if (ctx.method === 'password') authCount++; if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'test-secret') ctx.accept(); else ctx.reject(); });
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.()); session.on('signal', accept => { signals++; accept?.(); heldExec?.exit(0); heldExec?.end(); });
      session.on('shell', accept => { const stream = accept(); shellStream = stream; stream.write('한국어 terminal\r\nnginx error one\r\nnginx error two token=secret-value\r\n<img src=x onerror=alert(1)>\r\n\x1b]52;c;ZXZpbA==\x07$ '); stream.on('data', data => { inputs.push(data.toString()); stream.write(data); }); });
      session.on('exec', (accept, _reject, info) => { commands.push(info.command); const stream = accept(); if (info.command === 'uptime') { heldExec = stream; return; } if (info.command === 'cat /large') stream.write(Buffer.alloc(1100000, 'y')); else stream.write('/home/tester\n'); stream.exit(0); stream.end(); });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'], env: { ...process.env, KEYSHELL_TEST_USER_DATA: directory, KEYSHELL_TEST_AI: '1' } });
    const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.locator('#auth-state').filter({ hasText: 'DEVELOPMENT FIXTURE' }).waitFor();
    assert.equal(await page.locator('.profile-row').count(), 0);
    async function connection(name, cancelImmediately = false) {
      await page.locator('[data-new]').first().click();
      await page.getByLabel('Connection name', { exact: true }).fill(name); await page.getByLabel('Host', { exact: true }).fill('127.0.0.1'); await page.getByLabel('Port', { exact: true }).fill(String(server.address().port)); await page.getByLabel('Username', { exact: true }).fill('tester'); await page.getByLabel('Password', { exact: true }).fill('test-secret'); await page.screenshot({ path: path.join(evidence, 'connection.png') }); if (cancelImmediately) { await page.evaluate(() => { document.querySelector('#modal form').requestSubmit(); [...document.querySelectorAll('#modal button')].find(b => b.textContent === 'Cancel').click(); document.getElementById('settings').click(); }); return; } await page.getByRole('button', { name: 'Connect', exact: true }).click();
    }
    await connection('Cancelled'); await page.getByRole('heading', { name: 'Verify SSH host key' }).waitFor(); assert.equal(authCount, 0);
    await page.screenshot({ path: path.join(evidence, 'host-key.png') }); const fingerprint = await page.locator('.fingerprint').textContent(); assert.match(fingerprint, /^SHA256:/);
    await page.getByRole('button', { name: 'Cancel connection' }).click(); await page.waitForTimeout(200); assert.equal(authCount, 0);
    await connection('Local SSH'); await page.getByRole('heading', { name: 'Verify SSH host key' }).waitFor(); await page.getByRole('button', { name: 'Trust & connect' }).click();
    await page.locator('#connection-state').filter({ hasText: /^connected$/ }).waitFor();
    await page.waitForTimeout(300); assert.equal(authCount, 1);
    await connection('Rapid cancelled', true); await page.waitForTimeout(200); assert.equal(authCount, 1); assert.equal((await page.evaluate(() => window.keyshell.call('state'))).sessions.filter(s => s.status === 'connected').length, 1); await page.getByRole('heading', { name: 'Settings & privacy' }).waitFor(); await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.terminal-pane:not([hidden]) textarea').focus(); await page.keyboard.type('whoami'); await page.keyboard.press('Enter');
    await page.waitForTimeout(100); assert.ok(inputs.join('').includes('whoami'));
    await page.keyboard.press('Control+c'); await page.keyboard.press('Control+r'); await page.keyboard.press('Control+w'); await page.waitForTimeout(100); assert.ok(inputs.join('').includes('\x03')); assert.ok(inputs.join('').includes('\x12')); assert.ok(inputs.join('').includes('\x17')); assert.equal(page.isClosed(), false); assert.equal((await page.evaluate(() => window.keyshell.call('state'))).sessions.filter(s => s.status === 'connected').length, 1);
    // Select only the two real server output rows through xterm's public buffer API boundary.
    const box = await page.locator('.terminal-pane:not([hidden]) .xterm-screen').boundingBox();
    await page.mouse.move(box.x + 2, box.y + 24); await page.mouse.down(); await page.mouse.move(box.x + Math.min(480, box.width - 8), box.y + 44); await page.mouse.up();
    await page.locator('#selection-tools:not([hidden])').waitFor(); await page.getByRole('button', { name: 'Send to AI', exact: true }).click();
    await page.getByLabel('Ask about this session').fill('OS form clipboard'); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+c'); assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'OS form clipboard'); await app.evaluate(({ clipboard }) => clipboard.writeText('pasted form')); await page.keyboard.press('ControlOrMeta+v'); assert.equal(await page.getByLabel('Ask about this session').inputValue(), 'pasted form');
    await page.getByLabel('Ask about this session').fill('Why did nginx fail? password=private'); await page.getByRole('button', { name: 'Preview message' }).click();
    await page.getByRole('button', { name: 'Send confirmed request' }).waitFor();
    const request = await page.getByLabel('Complete AI request').textContent(); assert.match(request, /REDACTED/); assert.doesNotMatch(request, /password=private/);
    await page.screenshot({ path: path.join(evidence, 'share-preview.png') }); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await page.locator('#messages .question').count(), 0); assert.equal(commands.length, 0); await page.getByRole('button', { name: 'Preview message' }).click(); await page.getByRole('button', { name: 'Send confirmed request' }).click(); await page.getByRole('button', { name: 'Review & run' }).waitFor();
    await page.locator('#messages').getByRole('button', { name: 'Copy', exact: true }).click(); assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'pwd');
    assert.equal(await page.locator('#messages img[onerror], #messages img[src=x], #messages img[src^=http]').count(), 0); assert.match(await page.locator('#messages .answer').textContent(), /<img src=x onerror=alert\(1\)>/); const icons = await page.locator('img.design-icon').evaluateAll(nodes => nodes.map(n => ({ src: n.getAttribute('src'), loaded: n.complete && n.naturalWidth > 0 }))); assert.equal(new Set(icons.map(n => n.src)).size, 9); assert.ok(icons.every(n => n.loaded)); assert.equal(commands.length, 0);
    await page.getByRole('button', { name: 'Review & run' }).click(); await page.getByRole('heading', { name: 'Review command execution' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'execution.png') }); assert.match(await page.locator('#modal-body').textContent(), /Does not inherit/); await page.getByRole('button', { name: 'Approve & run once' }).click(); await page.waitForTimeout(200); assert.deepEqual(commands, ['pwd']); await page.waitForFunction(() => /completed.*exit 0/.test(document.getElementById('executions').textContent) && /stdout[\s\S]*\/home\/tester/.test(document.getElementById('executions').textContent));
    // Paste dispatch supplies the actual clipboard payload and must never enter xterm before confirmation.
    const before = inputs.join('');
    await page.locator('.terminal-pane:not([hidden])').evaluate(node => { const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'echo one\necho two\n'); node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })); });
    await page.getByRole('heading', { name: 'Confirm terminal paste' }).waitFor(); assert.equal(inputs.join(''), before); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(inputs.join(''), before);
    await page.locator('.terminal-pane:not([hidden])').evaluate(node => { const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'echo one\necho two\n'); node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })); });
    await page.getByRole('button', { name: 'Paste into SSH' }).click(); await page.waitForTimeout(100); assert.equal(inputs.join('').slice(before.length), 'echo one\necho two\n');
    await page.screenshot({ path: path.join(evidence, 'terminal.png') });
    await connection('Second SSH'); await page.waitForTimeout(300);
    const tabs = page.locator('#tabs .tab'); assert.ok(await tabs.count() >= 2);
    await page.getByRole('button', { name: 'Local SSH', exact: true }).last().click();
    assert.match(await page.locator('#executions').textContent(), /completed.*exit 0/); assert.match(await page.locator('#executions').textContent(), /\/home\/tester/);
    await page.getByLabel('AI model', { exact: true }).selectOption('fixture-alternate'); await page.getByRole('button', { name: 'General conversation', exact: true }).click(); assert.equal(await page.getByLabel('AI model', { exact: true }).inputValue(), 'fixture-model'); await page.getByRole('button', { name: 'Local SSH', exact: true }).last().click(); assert.equal(await page.getByLabel('AI model', { exact: true }).inputValue(), 'fixture-alternate');
    const stale = await page.evaluate(async () => { const state = await window.keyshell.call('state'); const session = state.sessions.find(s => s.name === 'Local SSH' && s.status === 'connected'); return window.keyshell.call('execution', { id: session.sessionId, command: 'pwd' }); });
    await page.getByRole('button', { name: 'Second SSH', exact: true }).last().click();
    const rejected = await page.evaluate(async token => { try { await window.keyshell.call('approve', token); return false; } catch { return true; } }, stale.token);
    assert.equal(rejected, true); assert.deepEqual(commands, ['pwd']);

    await page.getByRole('button', { name: 'Local SSH', exact: true }).last().click();
    const origin = await page.evaluate(async () => (await window.keyshell.call('state')).sessions.find(s => s.name === 'Local SSH' && s.status === 'connected').sessionId);
    await page.evaluate(async id => { const p = await window.keyshell.call('execution', { id, command: 'cat /large' }); await window.keyshell.call('approve', p.token); }, origin);
    await page.waitForFunction(() => [...document.querySelectorAll('#executions [data-omitted-bytes]')].some(n => +n.dataset.omittedBytes > 0)); assert.match(await page.locator('#executions').textContent(), /Output truncated:.*limit 1048576 bytes/);
    await page.evaluate(async id => { const p = await window.keyshell.call('execution', { id, command: 'uptime' }); await window.keyshell.call('approve', p.token); }, origin);
    await page.getByRole('button', { name: 'Request remote TERM', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await page.getByRole('button', { name: 'Request remote TERM', exact: true }).waitFor();
    await page.getByLabel('ChatGPT account', { exact: true }).selectOption('development-second'); await page.getByRole('button', { name: 'Request remote TERM', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.getByRole('button', { name: 'Request remote TERM', exact: true }).waitFor(); await page.locator('#notice').filter({ hasText: 'Remote revocation confirmed' }).waitFor();
    await page.getByRole('button', { name: 'Request remote TERM', exact: true }).click(); await page.waitForTimeout(100); assert.equal(signals, 1);
    await page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click(); assert.equal((await page.evaluate(() => window.keyshell.call('state'))).auth.lastLogin.accountId, 'development-second');
    await page.getByRole('button', { name: 'Add new account', exact: true }).click(); assert.equal((await page.evaluate(() => window.keyshell.call('state'))).auth.lastLogin.accountId, undefined);
    await page.setViewportSize({ width: 800, height: 600 }); await page.getByRole('button', { name: 'Settings', exact: false }).click(); await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(evidence, 'narrow.png') });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.body.scrollHeight <= innerHeight), true);
    await page.setViewportSize({ width: 760, height: 560 }); await page.getByRole('button', { name: 'Settings', exact: false }).click(); await page.getByRole('button', { name: 'Done', exact: true }).click(); await page.setViewportSize({ width: 1280, height: 900 });
    await app.evaluate((_electron, updaterPath) => process.mainModule.require(updaterPath).autoUpdater.emit('update-downloaded', { version: '9.9.9' }), require.resolve('electron-updater')); await page.locator('#update').click(); await page.getByRole('button', { name: 'Install & restart', exact: true }).waitFor(); await page.getByRole('button', { name: 'Later', exact: true }).click(); await page.locator('#update').click(); await page.getByRole('button', { name: 'Install & restart', exact: true }).waitFor(); await page.getByRole('button', { name: 'Later', exact: true }).click();
    // Verify native close cancellation keeps the live transport, then close explicitly.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.getByRole('button', { name: 'Close KeyShell' }).click(); await page.waitForTimeout(100); assert.equal(page.isClosed(), false); assert.ok(shellStream.writable);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const exited = new Promise(resolve => app.process().once('exit', resolve)); await page.getByRole('button', { name: 'Close KeyShell' }).click(); await exited;
  } catch (error) { if (app) { const pages = app.windows(); if (pages[0]) { await pages[0].screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); console.error('FAILURE UI', await pages[0].locator('#modal-title, #notice, #connection-state, #auth-state').allTextContents().catch(() => ['unavailable'])); } } throw error;
  } finally {
    fs.writeFileSync(path.join(evidence, 'errors.json'), JSON.stringify(errors, null, 2));
    for (const client of clients) { client.end(); client._sock?.destroy(); }
    if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {}); await app.close().catch(() => {}); } await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('default source launch is empty and real SSH works without AI sign-in', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyshell-default-'));
  const clients = new Set(), key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => { const session = accept(); session.on('pty', accept => accept()); session.on('shell', accept => accept().write('Real SSH without AI\r\n')); }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let app;
  try {
    const env = { ...process.env, KEYSHELL_TEST_USER_DATA: directory }; delete env.KEYSHELL_TEST_AI;
    app = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'], env }); const page = await app.firstWindow();
    await page.locator('#auth-state').filter({ hasText: 'Not signed in' }).waitFor(); assert.equal(await page.locator('.profile-row').count(), 0); assert.equal(await page.locator('#tabs .tab').count(), 0);
    await page.screenshot({ path: path.resolve('docs/verification/desktop/empty.png') });
    await page.locator('[data-new]').first().click(); await page.getByLabel('Host', { exact: true }).fill('127.0.0.1'); await page.getByLabel('Port', { exact: true }).fill(String(server.address().port)); await page.getByLabel('Username', { exact: true }).fill('tester'); await page.getByLabel('Password', { exact: true }).fill('test-only');
    await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.getByRole('button', { name: 'Trust & connect' }).click(); await page.locator('#connection-state').filter({ hasText: /^connected$/ }).waitFor();
    assert.match(await page.locator('#auth-state').textContent(), /Not signed in/);
    await page.reload(); await page.locator('#recovery:not([hidden])').waitFor(); assert.match(await page.locator('#recovery').textContent(), /output is not recovered/); assert.equal((await page.evaluate(() => window.keyshell.call('state'))).sessions.filter(s => s.status === 'connected').length, 0); assert.equal(await page.locator('#session-count').textContent(), '0 active sessions');
    await page.locator('#tabs .tab button').first().click(); await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await page.getByLabel('Password', { exact: true }).fill('test-only'); await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.locator('#connection-state').filter({ hasText: /^connected$/ }).waitFor();
    const pending = await page.evaluate(async () => { const s = (await window.keyshell.call('state')).sessions.find(s => s.status === 'connected'); return window.keyshell.call('execution', { id: s.sessionId, command: 'pwd' }); });
    const crashed = page.waitForEvent('crash'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()); await crashed;
    const recovered = await app.evaluate(async ({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].webContents; await new Promise(resolve => { wc.once('did-finish-load', resolve); wc.reload(); }); return wc.executeJavaScript('window.keyshell.call("state")'); }); assert.equal(recovered.sessions.filter(s => s.status === 'connected').length, 0); assert.ok(recovered.executions.every(e => e.status !== 'pending'));
    assert.equal(await app.evaluate(async ({ BrowserWindow }, token) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`window.keyshell.call('approve', ${JSON.stringify(token)}).then(() => false, () => true)`), pending.token), true);

  } finally { for (const client of clients) { client.end(); client._sock?.destroy(); } if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {}); await app.close().catch(() => {}); } await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('execution result selection shares only explicit active output through masked confirmation', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyshell-result-share-')), clients = new Set(), commands = [];
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }); let liveStream;
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const channel = accept(); channel.on('pty', accept => accept()); channel.on('window-change', accept => accept?.());
      channel.on('shell', accept => accept().write('terminal original only\r\nterminal second row\r\n'));
      channel.on('exec', (accept, _reject, info) => { commands.push(info.command); const stream = accept(); stream.on('error', () => {}); if (info.command === 'uptime') { liveStream = stream; stream.write('running password=old-secret\n'); return; } stream.write(info.command === 'pwd' ? 'unselected before\npassword=result-secret\nunselected after\n' : 'neighbor execution sentinel\n'); stream.stderr.write('excluded stderr sentinel\n'); stream.exit(0); stream.end(); });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let app;
  try {
    app = await electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '.'], env: { ...process.env, KEYSHELL_TEST_USER_DATA: directory, KEYSHELL_TEST_AI: '1' } });
    const page = await app.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.locator('#auth-state').filter({ hasText: 'DEVELOPMENT FIXTURE' }).waitFor();
    // Spy at the existing development fixture's inference fetch boundary, never production IPC.
    await app.evaluate(({ app }, modulePath) => { const { AIService } = process.mainModule.require(modulePath), original = AIService.prototype.preview; app.__resultShareRequests = 0; AIService.prototype.preview = function(input) { if (!this.__shareSpy) { this.__shareSpy = true; const fetch = this.fetch; this.fetch = async (url, ...rest) => { if (url.endsWith('/responses')) app.__resultShareRequests++; return fetch(url, ...rest); }; } return original.call(this, input); }; }, require.resolve('../src/main/ai-service.cjs'));
    const count = () => app.evaluate(({ app }) => app.__resultShareRequests);
    await page.locator('[data-new]').first().click(); await page.getByLabel('Connection name', { exact: true }).fill('Result SSH'); await page.getByLabel('Host', { exact: true }).fill('127.0.0.1'); await page.getByLabel('Port', { exact: true }).fill(String(server.address().port)); await page.getByLabel('Username', { exact: true }).fill('tester'); await page.getByLabel('Password', { exact: true }).fill('test-only'); await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.getByRole('button', { name: 'Trust & connect' }).click(); await page.locator('#connection-state').filter({ hasText: /^connected$/ }).waitFor();
    const session = (await page.evaluate(() => window.keyshell.call('state'))).sessions.find(s => s.status === 'connected');
    const run = command => page.evaluate(async ({ id, command }) => { const p = await window.keyshell.call('execution', { id, command }); await window.keyshell.call('approve', p.token); return p.id; }, { id: session.sessionId, command });
    const first = await run('pwd'), second = await run('whoami');
    const stdout = `[data-execution-output][data-execution-id="${first}"][data-stream="stdout"]`, stderr = `[data-execution-output][data-execution-id="${first}"][data-stream="stderr"]`;
    await page.locator(stdout).filter({ hasText: 'result-secret' }).waitFor(); await page.locator(stderr).waitFor(); await page.locator(`[data-execution-output][data-execution-id="${second}"]`).first().waitFor();
    // Preserve the original xterm selection path; the new DOM selection must replace its source.
    const box = await page.locator('.terminal-pane:not([hidden]) .xterm-screen').boundingBox(); await page.mouse.move(box.x + 1, box.y + 5); await page.mouse.down(); await page.mouse.move(box.x + 170, box.y + 5); await page.mouse.up(); await page.locator('#selection-tools:not([hidden])').waitFor(); assert.doesNotMatch(await page.locator('#selection-info').textContent(), /exec/);
    const select = async (selector, text) => {
      await page.locator(selector).evaluate((node, text) => { document.activeElement?.blur(); const range = document.createRange(); if (text) { const offset = node.textContent.indexOf(text); if (offset < 0) throw new Error('Missing selection text'); range.setStart(node.firstChild, offset); range.setEnd(node.firstChild, offset + text.length); } else range.selectNodeContents(node); const selected = document.getSelection(); selected.removeAllRanges(); selected.addRange(range); }, text);
    };
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); assert.match(await page.locator('#selection-info').textContent(), new RegExp(`exec ${first.slice(0, 8)}.*stdout`)); await page.locator('#copy-selection').click(); assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'password=result-secret'); assert.equal(await count(), 0);
    const nextBox = await page.locator('.terminal-pane:not([hidden]) .xterm-screen').boundingBox(); await page.mouse.move(nextBox.x + 1, nextBox.y + 5); await page.mouse.down(); await page.mouse.move(nextBox.x + 170, nextBox.y + 5); await page.mouse.up(); await page.locator('#selection-tools:not([hidden])').waitFor(); await select('#executions .execution-status:first-child'); await page.locator('#selection-tools').waitFor({ state: 'hidden' });
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor();
    await page.evaluate(({ stdout, stderr }) => { const a = document.querySelector(stdout), b = document.querySelector(stderr), r = document.createRange(); r.setStart(a.firstChild, 0); r.setEnd(b.firstChild, b.textContent.length); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); }, { stdout, stderr }); await page.locator('#selection-tools').waitFor({ state: 'hidden' });
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await page.evaluate(({ stdout, second }) => { const a = document.querySelector(stdout), b = document.querySelector(`[data-execution-output][data-execution-id="${second}"][data-stream="stdout"]`), r = document.createRange(); r.setStart(a.firstChild, 0); r.setEnd(b.firstChild, b.textContent.length); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); }, { stdout, second }); await page.locator('#selection-tools').waitFor({ state: 'hidden' });
    // Detached output and cleared selections cannot fall back to the previous terminal selection.
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await page.locator(stdout).evaluate(node => { const parent = node.parentNode; node.remove(); document.getElementById('share-selection').click(); parent.append(node); }); assert.equal(await page.locator('#attachment').textContent(), 'No output attached'); await page.locator('#selection-tools').waitFor({ state: 'hidden' });
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await page.evaluate(() => document.getSelection().removeAllRanges()); await page.locator('#selection-tools').waitFor({ state: 'hidden' });
    const running = await run('uptime'), runningOutput = `[data-execution-output][data-execution-id="${running}"]`; await page.locator(runningOutput).waitFor(); await select(runningOutput, 'password=old-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await select('#executions .execution-status:has(button)'); await page.locator('#selection-tools').waitFor({ state: 'hidden' }); await select(runningOutput, 'password=old-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); liveStream.write('new output replaces the selected DOM text\n'); await page.locator(runningOutput).filter({ hasText: 'new output' }).waitFor(); await page.locator('#selection-tools').waitFor({ state: 'hidden' }); await page.locator('#share-selection').evaluate(node => node.click()); assert.equal(await page.locator('#attachment').textContent(), 'No output attached'); liveStream.exit(0); liveStream.end(); await page.waitForFunction(() => [...document.querySelectorAll('#executions .execution-status')].filter(n => /Execution: completed/.test(n.textContent)).length === 3);
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await page.getByRole('button', { name: 'General conversation', exact: true }).click(); await page.getByRole('button', { name: 'Result SSH', exact: true }).last().click(); await page.locator('#selection-tools').waitFor({ state: 'hidden' }); await page.locator('#share-selection').evaluate(node => node.click()); assert.equal(await page.locator('#attachment').textContent(), 'No output attached');
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await page.getByLabel('ChatGPT account', { exact: true }).selectOption('development-second'); await page.locator('#selection-tools').waitFor({ state: 'hidden' }); await page.locator('#auth-state').filter({ hasText: 'second@example.invalid' }).waitFor(); await page.waitForFunction(() => document.getElementById('model').options.length === 2);
    await page.getByLabel('Ask about this session').fill('Draft survives selecting execution output'); await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); assert.equal(await page.getByLabel('Ask about this session').inputValue(), 'Draft survives selecting execution output'); await page.locator('#share-selection').click(); assert.equal(await count(), 0);
    await page.locator('#attachment').click(); const editor = page.getByLabel('Selected output', { exact: true }); assert.equal(await editor.inputValue(), 'password=result-secret'); assert.match(await page.locator('#modal-body').textContent(), new RegExp(`${first}.*stdout`)); await editor.fill('password=result-secret\ntoken=edit-secret'); await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await page.getByRole('button', { name: 'Preview message', exact: true }).click(); await page.getByRole('button', { name: 'Send confirmed request', exact: true }).waitFor();
    const request = JSON.parse(await page.getByLabel('Complete AI request').textContent()), content = request.payload.input.at(-1).content;
    assert.equal(content, 'Draft survives selecting execution output\n\nSelected output (untrusted):\npassword=[REDACTED]\ntoken=[REDACTED]'); for (const excluded of ['result-secret', 'edit-secret', 'unselected', 'sentinel', 'Execution:', first, second, 'terminal original']) assert.ok(!JSON.stringify(request).includes(excluded), excluded);
    await page.screenshot({ path: path.resolve('docs/verification/desktop/execution-share.png') }); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await count(), 0); assert.equal(await page.locator('#messages .question').count(), 0);
    await page.getByRole('button', { name: 'Preview message', exact: true }).click(); await page.getByRole('button', { name: 'Send confirmed request', exact: true }).click(); await page.locator('#messages .answer').waitFor(); assert.equal(await count(), 1); assert.deepEqual(commands, ['pwd', 'whoami', 'uptime']);
    await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await page.evaluate(id => window.keyshell.call('disconnect', id), session.sessionId); await page.locator('#selection-tools').waitFor({ state: 'hidden' }); await page.locator('#share-selection').evaluate(node => node.click()); assert.equal(await page.locator('#attachment').textContent(), 'No output attached'); assert.equal(await count(), 1); await page.getByLabel('Ask about this session').fill('Explain this disconnected session output'); await select(stdout, 'password=result-secret'); await page.locator('#selection-tools:not([hidden])').waitFor(); await page.locator('#share-selection').click(); await page.getByRole('button', { name: 'Preview message', exact: true }).click(); await page.getByRole('button', { name: 'Send confirmed request', exact: true }).waitFor(); assert.match(await page.getByLabel('Complete AI request').textContent(), /password=\[REDACTED\]/); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await count(), 1); assert.equal((await page.evaluate(() => window.keyshell.call('state'))).sessions.find(s => s.sessionId === session.sessionId).status, 'disconnected'); assert.deepEqual(commands, ['pwd', 'whoami', 'uptime']); assert.deepEqual(errors, []);
  } finally { for (const client of clients) { client.end(); client._sock?.destroy(); } if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {}); await app.close().catch(() => {}); } await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});

'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, safeStorage, clipboard, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SSHService } = require('./ssh-service.cjs');
const { Store } = require('./store.cjs');
const { CredentialStore } = require('./credential-store.cjs');
const { AuthService } = require('./auth-service.cjs');
const { AIService } = require('./ai-service.cjs');
const { UpdateService } = require('./update-service.cjs');
const { installIPC, APP_URL } = require('./ipc.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'keyshell', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
// Tests may isolate user data only in unpackaged source launches.
if (!app.isPackaged && process.env.KEYSHELL_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.KEYSHELL_TEST_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../../dist');
  protocol.handle('keyshell', request => {
    const url = new URL(request.url);
    if (url.host !== 'app' || url.search || request.method !== 'GET') return new Response('Denied', { status: 403 });
    let name; try { name = decodeURIComponent(url.pathname); } catch { return new Response('Denied', { status: 403 }); }
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(root + path.sep) || name.includes('\\') || !/\.(html|js|css|svg|png)$/.test(file)) return new Response('Denied', { status: 403 });
    return net.fetch(pathToFileURL(file).href).then(response => { const headers = new Headers(response.headers); headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'"); headers.set('X-Content-Type-Options', 'nosniff'); return new Response(response.body, { status: response.status, headers }); });
  });
  const window = new BrowserWindow({ width: 1400, height: 900, minWidth: 760, minHeight: 560, backgroundColor: '#111417', title: 'KeyShell', frame: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== APP_URL) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const store = new Store(app.getPath('userData')), ssh = new SSHService({ store });
  const auth = new AuthService({ store: new CredentialStore(app.getPath('userData'), safeStorage), openBrowser: async value => { const u = new URL(value); if (u.origin !== 'https://auth.openai.com' || u.pathname !== '/api/accounts/authorize' || u.username || u.password) throw new Error('E-AUTH-URL'); await shell.openExternal(value); } });
  const ai = new AIService({ auth });
  // Explicit source-only fixture; cannot override endpoints or inject executable code.
  if (!app.isPackaged && process.env.KEYSHELL_TEST_AI === '1') require('./test-fixture.cjs').install({ auth, ai });
  let quitting = false, checkingClose = false;
  const cleanup = () => { ssh.dispose(); ai.dispose(); auth.dispose(); };
  const confirmClose = async () => {
    const active = ssh.listSessions().filter(s => ['connected', 'connecting', 'authenticating', 'host-key-required'].includes(s.status));
    if (active.length) { const { response } = await dialog.showMessageBox(window, { type: 'question', title: 'Close KeyShell?', message: `Close ${active.length} active SSH session(s)?`, detail: 'Connections and running commands will end. Unconfirmed results remain unknown.', buttons: ['Cancel', 'Close sessions and quit'], defaultId: 0, cancelId: 0, noLink: true }); if (response !== 1) return false; }
    quitting = true; cleanup(); return true;
  };
  const updates = new UpdateService({ app, updater: require('electron-updater').autoUpdater, confirmClose });
  const removeIPC = installIPC({ ipcMain, window, ssh, ai, auth, store, updates, dialog, app, clipboard, Menu });
  let hasRendererDocument = false;
  window.webContents.on('did-finish-load', () => { hasRendererDocument = true; });
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace && hasRendererDocument) { removeIPC.rendererLost('navigation'); hasRendererDocument = false; } });
  window.webContents.on('render-process-gone', () => removeIPC.rendererLost('renderer-failure'));
  window.webContents.on('did-fail-load', (_event, _code, _description, _url, mainFrame) => { if (mainFrame) removeIPC.rendererLost('load-failure'); });
  window.on('close', event => { if (quitting) return; event.preventDefault(); if (checkingClose) return; checkingClose = true; confirmClose().then(ok => { checkingClose = false; if (ok) window.close(); }); });
  window.on('closed', () => { removeIPC(); cleanup(); app.quit(); });
  app.on('before-quit', event => { if (!quitting && !window.isDestroyed()) { event.preventDefault(); window.close(); } });
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.focus(); });
  await window.loadURL(APP_URL);
}).catch(() => { dialog.showErrorBox('KeyShell could not start', 'Local application state could not be loaded safely.'); app.exit(1); });

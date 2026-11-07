'use strict';
const { randomUUID } = require('node:crypto');
const { fail, validateProfile, validateCredentials } = require('./policy.cjs');
const { AutoAdvice } = require('./auto-advice.cjs');
const APP_URL = 'keyshell://app/index.html';
function trustedFrame(event, window) {
  return !!event.senderFrame && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === APP_URL;
}
function installIPC({ ipcMain, window, ssh, ai, auth, store, updates, dialog, app, clipboard, Menu }) {
  let active = 'general', startingAttempt = null, recovery = null; const keys = new Set(), pastes = new Map(), attempts = new Map(), sessionAttempts = new Map(), rotations = new Map();
  let previewEnabled = false;
  const advice = new AutoAdvice({ ssh, ai, auth, getActive: () => active });
  ssh.setOutputConsumer?.(true);
  const cancelAttempt = id => { const attempt = attempts.get(id); if (!attempt) return; attempt.cancelled = true; attempt.credentials = null; if (attempt.sessionId && ssh.listSessions().some(s => s.sessionId === attempt.sessionId)) ssh.disconnect(attempt.sessionId); attempts.delete(id); };
  const invalidate = () => {
    ai.invalidatePreviews(); pastes.clear();
    for (const e of ssh.executions.values()) if (e.status === 'pending') ssh.cancelExecution(e.id);
  };
  const current = id => { if (id !== active) fail('E-IPC-SESSION'); };
  const pastePreview = (id, data) => {
    current(id); const session = ssh.listSessions().find(s => s.sessionId === id && s.status === 'connected');
    if (!session) fail('E-SSH-NOT-CONNECTED');
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536 || data.includes('\0')) fail('E-TERM-INPUT');
    if (!data) return { empty: true };
    const token = randomUUID(); pastes.clear(); pastes.set(token, { id, generation: session.generation, data });
    return { token, data, generation: session.generation, confirmationRequired: /[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(data) };
  };
  const methods = {
    terminalFocus: value => { if (typeof value !== 'boolean') fail('E-IPC-INPUT'); window.webContents.setIgnoreMenuShortcuts(value); },
    copy: async value => { if (typeof value !== 'string' || Buffer.byteLength(value) > 1048576) fail('E-IPC-INPUT'); await clipboard.writeText(value); return { copied: true }; },
    state: () => ({ profiles: store.listProfiles(), sessions: ssh.listSessions(), auth: auth.state(), version: app.getVersion(), packaged: app.isPackaged, updates: updates.state, recovery, previewEnabled, advice: advice.state(), executions: [...ssh.executions.values()].map(e => { const { stream, token, ...view } = e; return view; }) }),
    activate: id => { if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) fail('E-SSH-SESSION'); if (id !== active) { advice.stop('tab-changed'); invalidate(); active = id; } return { active, advice: advice.state() }; },
    connect: ({ attemptId, profile, credentials, save }) => {
      if (typeof attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(attemptId) || attempts.has(attemptId) || attempts.size >= 16) fail('E-IPC-ATTEMPT');
      validateProfile(profile); validateCredentials(credentials);
      if (credentials?.type === 'privateKey' && !keys.has(credentials.privateKeyPath)) fail('E-IPC-KEY');
      if (typeof save !== 'boolean') fail('E-IPC-INPUT');
      attempts.set(attemptId, { profile, credentials, save, cancelled: false });
      return { attemptId };
    },
    startConnect: async id => {
      const attempt = attempts.get(id); if (!attempt || attempt.cancelled) fail('E-SSH-CONNECT-CANCELLED');
      if (attempt.started) fail('E-IPC-ATTEMPT'); attempt.started = true;
      try {
        const profile = attempt.save ? store.saveProfile(attempt.profile) : attempt.profile;
        startingAttempt = { id, attempt };
        const promise = ssh.connect(profile, attempt.credentials); startingAttempt = null; attempt.credentials = null;
        const result = await promise;
        if (attempt.cancelled) { ssh.disconnect(result.sessionId); fail('E-SSH-CONNECT-CANCELLED'); }
        return result;
      } finally { startingAttempt = null; attempt.credentials = null; attempts.delete(id); }
    },
    cancelConnect: id => { cancelAttempt(id); return { cancelled: true }; },
    disconnect: id => { if (ssh.listSessions().some(s => s.sessionId === id)) ssh.disconnect(id); ai.invalidatePreviews(id); },
    closeTab: id => { if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || id === 'general') fail('E-SSH-SESSION'); if (advice.grant?.sessionId === id || advice.pending?.sessionId === id) advice.stop('tab-closed'); ai.resetSession(id); if (ssh.listSessions().some(s => s.sessionId === id)) ssh.disconnect(id); if (active === id) { invalidate(); active = 'general'; } return { discardedOutputBytes: ssh.discardOutput?.(id) || 0 }; },
    ackOutput: id => { if (typeof id !== 'string') fail('E-IPC-INPUT'); ssh.ackOutput?.(id); },
    rotatePreview: id => {
      const candidate = ssh.listSessions().find(s => s.sessionId === id && s.error === 'E-SSH-HOSTKEY-CHANGED');
      if (!candidate) fail('E-SSH-HOSTKEY-STALE');
      const old = store.getKnownHost(candidate.host, candidate.port), next = { host: candidate.host, port: candidate.port, keyType: candidate.keyType, fingerprint: candidate.fingerprint };
      if (!old) fail('E-SSH-HOSTKEY-STALE'); const token = randomUUID(); rotations.clear(); rotations.set(token, { old, next }); return { token, old, next };
    },
    rotateConfirm: ({ token, verified }) => { const r = rotations.get(token); rotations.delete(token); if (!r || verified !== true) fail('E-SSH-HOSTKEY-ANSWER'); return store.rotateHost(r.old, r.next); },
    deleteProfile: id => { if (typeof id !== 'string') fail('E-IPC-INPUT'); return store.deleteProfile(id); },
    hostKey: ({ id, trust }) => { if (typeof id !== 'string' || typeof trust !== 'boolean') fail('E-IPC-INPUT'); return ssh.answerHostKey(id, trust); },
    write: ({ id, data }) => { current(id); return ssh.write(id, data); },
    resize: ({ id, cols, rows }) => ssh.resize(id, cols, rows),
    pastePreview: ({ id, data }) => pastePreview(id, data),
    clipboardPastePreview: async id => { current(id); if (!ssh.listSessions().some(s => s.sessionId === id && s.status === 'connected')) fail('E-SSH-NOT-CONNECTED'); let data; try { data = await clipboard.readText(); } catch { fail('E-CLIPBOARD-READ'); } return pastePreview(id, data); },
    paste: token => { const p = pastes.get(token); pastes.delete(token); if (!p) fail('E-TERM-STALE'); current(p.id); if (!ssh.listSessions().some(s => s.sessionId === p.id && s.status === 'connected' && s.generation === p.generation)) fail('E-TERM-STALE'); return ssh.write(p.id, p.data); },
    terminalContextMenu: ({ id, selection = '' }) => {
      current(id); if (typeof selection !== 'string' || Buffer.byteLength(selection) > 1048576 || !Menu) fail('E-IPC-INPUT');
      const connected = ssh.listSessions().some(s => s.sessionId === id && s.status === 'connected');
      Menu.buildFromTemplate([
        { label: '복사', enabled: !!selection, click: async () => { try { await clipboard.writeText(selection); } catch { publish('clipboard-error', { code: 'E-CLIPBOARD-WRITE' }); } } },
        { label: '붙여넣기', enabled: connected, click: async () => { try { publish('terminal-paste', { sessionId: id, preview: await methods.clipboardPastePreview(id) }); } catch (e) { publish('clipboard-error', { code: e.code || 'E-TERM-INPUT' }); } } }
      ]).popup({ window }); return { opened: true };
    },
    chooseKey: async () => { const result = await dialog.showOpenDialog(window, { title: 'Choose SSH private key', properties: ['openFile'] }); if (result.canceled) return null; keys.add(result.filePaths[0]); return result.filePaths[0]; },
    login: async options => { if (!options || Object.keys(options).some(k => !['remember', 'accountId'].includes(k))) fail('E-AUTH-INPUT'); const r = await auth.beginLogin(options); r.completion.catch(e => publish('auth-error', { code: e.code || 'E-AUTH-LOGIN' })); return { pending: true }; },
    cancelLogin: () => auth.cancelLogin(), logout: () => auth.logout(), account: id => auth.selectAccount(id),
    sessionModel: id => ({ model: ai.sessions.get(id)?.model || null }),
    models: () => ai.listModels(), model: ({ id, model }) => { current(id); advice.stop('model-changed'); return ai.setModel(id, model); },
    previewMode: value => { if (typeof value !== 'boolean') fail('E-IPC-INPUT'); invalidate(); previewEnabled = value; return { previewEnabled }; },
    directSend: input => { current(input?.sessionId); if (previewEnabled) fail('E-AI-REVIEW-REQUIRED'); const preview = ai.preview(input); publish('manual-question', { sessionId: input.sessionId, text: preview.request.payload.input.at(-1).content }); return ai.send(preview.token); },
    advicePrepare: input => { current(input?.sessionId); return advice.prepare(input); },
    adviceEnable: token => advice.enable(token), adviceStop: () => advice.stop(),
    preview: input => { current(input?.sessionId); return ai.preview(input); },
    send: token => ai.send(token), invalidate: () => invalidate(),
    reset: id => { current(id); advice.stop('conversation-reset'); invalidate(); return ai.resetSession(id); }, cancelAI: id => { advice.stop('cancelled'); return ai.cancel(id); },
    execution: ({ id, command }) => { current(id); return ssh.prepareExecution(id, command); },
    approve: token => { const id = ssh.tokens.get(token), e = ssh.executions.get(id); if (!e) fail('E-EXEC-STALE'); current(e.sessionId); return ssh.approveExecution(token); },
    cancelExecution: id => ssh.cancelExecution(id),
    window: action => { if (action === 'minimize') window.minimize(); else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize(); else if (action === 'close') window.close(); else fail('E-IPC-INPUT'); },
    checkUpdate: () => updates.check(), downloadUpdate: () => updates.download(), installUpdate: () => updates.install()
  };
  const publish = (type, detail) => { try { if (!window.isDestroyed() && !window.webContents.isDestroyed?.()) window.webContents.send('keyshell:event', { type, detail }); } catch { /* Renderer recovery owns transport cleanup; never unwind service callbacks. */ } };
  advice.on('state', detail => publish('advice', detail)); advice.on('question', detail => publish('automatic-question', detail));
  const listeners = [];
  for (const [service, names] of [[ssh, ['session', 'host-key', 'output', 'execution']], [auth, ['change', 'auth-error']], [ai, ['state']], [updates, ['update']]]) for (const name of names) {
    const listener = detail => { if (service === ssh && name === 'session' && startingAttempt) { startingAttempt.attempt.sessionId = detail.sessionId; sessionAttempts.set(detail.sessionId, startingAttempt.id); } if (service === ssh && ['session', 'host-key'].includes(name)) detail = { ...detail, attemptId: sessionAttempts.get(detail.sessionId) }; if (service === auth && name === 'change') invalidate(); if (service === ssh && name === 'session' && detail.status !== 'connected') { ai.invalidatePreviews(detail.sessionId); for (const [t, p] of pastes) if (p.id === detail.sessionId) pastes.delete(t); } publish(service === ai ? 'ai' : name, detail); if (service === ssh && name === 'session' && ['failed', 'disconnected'].includes(detail.status)) sessionAttempts.delete(detail.sessionId); };
    service.on(name, listener); listeners.push([service, name, listener]);
  }
  ipcMain.handle('keyshell:call', async (event, method, input) => {
    if (!trustedFrame(event, window)) return { ok: false, error: 'E-IPC-FRAME' };
    if (!Object.hasOwn(methods, method)) return { ok: false, error: 'E-IPC-METHOD' };
    try { return { ok: true, value: await methods[method](input) }; } catch (e) { return { ok: false, error: /^E-[A-Z0-9-]+$/.test(e.code || '') ? e.code : 'E-REQUEST' }; }
  });
  const remove = () => { advice.dispose(); ipcMain.removeHandler('keyshell:call'); for (const [s, n, l] of listeners) s.off(n, l); };
  remove.rendererLost = reason => { advice.stop('renderer-restarted'); for (const id of [...attempts.keys()]) cancelAttempt(id); invalidate(); const previous = ssh.listSessions(); for (const session of previous) { ai.resetSession(session.sessionId); if (!['failed', 'disconnected'].includes(session.status)) ssh.disconnect(session.sessionId); } ai.resetSession('general'); window.webContents.setIgnoreMenuShortcuts?.(false); const discardedBytes = ssh.clearOutput?.() || 0; active = 'general'; sessionAttempts.clear(); rotations.clear(); recovery = { reason, discardedBytes, message: 'The previous renderer ended. SSH transports were disconnected and approvals discarded. Previous terminal and execution output is not recovered; running command results may be unknown. Reconnect explicitly.' }; };
  return remove;
}
module.exports = { installIPC, trustedFrame, APP_URL };

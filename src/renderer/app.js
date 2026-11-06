import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
const $ = id => document.getElementById(id);
const call = (method, input) => window.keyshell.call(method, input);
const sessions = new Map(), conversations = new Map(), pendingRequests = new Set();
let connectionAttempt = null;
let loginPending = false, loginError = '';
let previewEnabled = false, adviceState = { enabled: false }, composing = false;
const directRequests = new Map();
let active = 'general', profiles = [], auth = {}, attachment = null, selected = null, models = [], modalCancel = null, dialogEpoch = 0;
function el(tag, text, attrs = {}) { const node = document.createElement(tag); if (text !== null && text !== undefined) node.textContent = text; for (const [k, v] of Object.entries(attrs)) { if (k === 'class') node.className = v; else node.setAttribute(k, v); } return node; }
const icon = name => el('img', null, { src: `assets/${name}`, alt: '', class: 'design-icon' });
function button(text, action, cls = '') { const b = el('button', text, { type: 'button', class: cls }); b.addEventListener('click', safe(action)); return b; }
const errorText = code => ({
  'E-AI-BUSY': 'AI 응답이 진행 중입니다. 완료를 기다리거나 응답을 취소한 뒤 다시 보내세요.',
  'E-AI-QUESTION': '질문을 입력해 주세요. 너무 긴 질문은 나누어 보내세요.',
  'E-SHARE-SIZE': '전송할 대화나 첨부가 너무 큽니다. 첨부를 줄이거나 새 대화를 시작해 주세요.',
  'E-AUTH-PLAN-PERMISSION': '이 계정에서 필요한 AI 이용 권한을 확인할 수 없습니다. 계정의 연결 권한을 확인해 주세요.',
  'E-ADVICE-TARGET': '연결된 SSH 세션과 로그인된 ChatGPT 계정·모델을 선택한 뒤 자동 조언을 켜 주세요.',
  'E-SSH-AUTH': 'SSH authentication failed. Check the username and credentials, then reconnect.',
  'E-SSH-HOSTKEY-CHANGED': 'The server key differs from the trusted key. Authentication was blocked. Contact the server administrator and verify the full fingerprint.',
  'E-SSH-HOSTKEY-CANCELLED': 'Connection cancelled before authentication. Open a new connection when ready.',
  'E-SSH-DNS': 'The server name could not be resolved. Check the host and network, then reconnect.',
  'E-SSH-REFUSED': 'The server refused the connection. Check the port and SSH service, then reconnect.',
  'E-SSH-TIMEOUT': 'The SSH connection timed out. Check the network and server, then reconnect.',
  'E-SSH-NETWORK': 'The SSH network connection failed. Check connectivity and reconnect; commands are not retried.',
  'E-SSH-DISCONNECTED': 'SSH disconnected. Running command results may be unknown. Review the server before manually retrying.',
  'E-SSH-NOT-CONNECTED': 'The selected SSH session is disconnected. Reconnect before sending input or reviewing a command.',
  'E-EXEC-OPEN-TIMEOUT': 'The execution channel did not open in time. The command may have reached the server. App execution is blocked on this connection; manual input remains available. Reconnect explicitly before another app execution.',
  'E-EXEC-RECONNECT-REQUIRED': 'App execution is blocked after an unanswered channel request. Check the server and reconnect explicitly; no new command was sent.',
  'E-EXEC-STALE': 'This execution approval expired or its target changed. No new command was sent. Review a fresh proposal.',
  'E-EXEC-UNKNOWN': 'The execution result is unknown. The command may have run; check the server before retrying. Nothing is retried automatically.',
  'E-AI-APPROVAL': 'This sharing approval expired or the conversation changed. No new request was sent. Open a fresh preview.',
  'E-AI-LIMIT': 'The account reached an AI usage limit. Review your ChatGPT plan or try later; SSH remains available.',
  'E-AUTH-REQUIRED': 'ChatGPT sign-in is required for AI requests. Sign in or continue using SSH independently.',
  'E-AUTH-LOGIN': 'ChatGPT sign-in did not complete. Try signing in again; SSH remains available.',
  'E-AUTH-REFRESH': 'The ChatGPT session could not be refreshed. Sign in again; SSH remains available.',
  'E-AI-INTERRUPTED': 'The AI response ended without completion. A request may have been sent. Review it before manually retrying.',
  'E-UPDATE-DEVELOPMENT-BUILD': 'Updates are available only in a signed Windows or macOS release. This development build cannot install updates.',
  'E-UPDATE-VERIFY-OR-NETWORK': 'The update could not be downloaded or verified. It will not be installed. Keep working and check again later.'
}[code] || (code?.startsWith('E-') ? 'The request could not be completed. Review the current connection and try the action again. Nothing is retried automatically.' : code)) + (code?.startsWith('E-') ? ` (${code})` : '');
function notice(error) { $('notice').textContent = errorText(typeof error === 'string' ? error : error.message || 'Request failed'); $('notice').classList.add('visible'); clearTimeout(notice.timer); notice.timer = setTimeout(() => $('notice').classList.remove('visible'), 6000); }
function safe(action) { return (...args) => { try { return Promise.resolve(action(...args)).catch(notice); } catch (e) { notice(e); } }; }
function clearModal() { dialogEpoch++; const cancel = modalCancel; modalCancel = null; if ($('modal').open) $('modal').close(); if (cancel) Promise.resolve(cancel()).catch(notice); }
function modal(title, cancel = null) { clearModal(); modalCancel = cancel; const body = $('modal-body'); body.replaceChildren(el('h2', title, { id: 'modal-title' })); $('modal').showModal(); return body; }
function actions(body, buttons) { const row = el('div', null, { class: 'modal-actions' }); row.append(...buttons); body.append(row); }
$('modal').addEventListener('cancel', event => { event.preventDefault(); clearModal(); });
function field(form, title, name, type = 'text', value = '') { const label = el('label', title); const input = el('input', null, { name, type, 'aria-label': title }); input.value = value; label.append(input); form.append(label); return input; }
function selectField(form, title, entries, value) { const label = el('label', title); const input = el('select', null, { 'aria-label': title }); for (const v of entries) input.append(el('option', v, { value: v })); input.value = value || entries[0]; label.append(input); form.append(label); return input; }
function newConnection(profile = {}) {
  const attempt = { id: crypto.randomUUID(), cancelled: false };
  const cancel = () => { attempt.cancelled = true; return call('cancelConnect', attempt.id); };
  const body = modal('Connect to an SSH server', cancel); connectionAttempt = attempt; attempt.epoch = dialogEpoch;
  body.append(el('p', 'Credentials stay in memory. A new server key requires your confirmation before authentication.'));
  const form = el('form'); body.append(form);
  const name = field(form, 'Connection name', 'name', 'text', profile.name || '');
  const host = field(form, 'Host', 'host', 'text', profile.host || ''); host.required = true;
  const port = field(form, 'Port', 'port', 'number', profile.port || 22); port.min = 1; port.max = 65535; port.required = true;
  const username = field(form, 'Username', 'username', 'text', profile.username || ''); username.required = true;
  const group = selectField(form, 'Group', ['Production', 'Development', 'Other'], profile.group || 'Other');
  const method = selectField(form, 'Authentication', ['Password', 'Private key']);
  const password = field(form, 'Password', 'password', 'password'); password.autocomplete = 'off';
  const key = el('div'); key.hidden = true; const keyLabel = el('span', 'No key chosen'); let keyPath = null;
  key.append(button('Choose private key', async () => { keyPath = await call('chooseKey'); keyLabel.textContent = keyPath ? keyPath.split(/[\\/]/).pop() : 'No key chosen'; }), keyLabel); form.append(key);
  const passphrase = field(form, 'Key passphrase (optional)', 'passphrase', 'password'); passphrase.parentElement.hidden = true;
  method.onchange = () => { key.hidden = method.value !== 'Private key'; password.parentElement.hidden = !key.hidden; passphrase.parentElement.hidden = key.hidden; };
  const remember = field(form, 'Save connection profile (no credentials)', 'save', 'checkbox'); remember.checked = true;
  const error = el('div', '', { class: 'modal-error', role: 'alert' }); form.append(error);
  const connect = el('button', 'Connect', { type: 'submit', class: 'mint' }); actions(form, [button('Cancel', clearModal), connect]);
  form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return; connect.disabled = true;
    const p = { host: host.value.trim(), port: Number(port.value), username: username.value.trim(), group: group.value };
    if (name.value.trim()) p.name = name.value.trim(); if (profile.id) p.id = profile.id;
    const credentials = method.value === 'Password' ? { type: 'password', password: password.value } : { type: 'privateKey', privateKeyPath: keyPath, passphrase: passphrase.value };
    
    password.value = ''; passphrase.value = '';
    try {
      await call('connect', { attemptId: attempt.id, profile: p, credentials, save: remember.checked });
      if (attempt.cancelled) { await call('cancelConnect', attempt.id); return; }
      const result = await call('startConnect', attempt.id);
      if (attempt.cancelled || connectionAttempt !== attempt || attempt.epoch !== dialogEpoch) { await call('disconnect', result.sessionId); return; }
      modalCancel = null; clearModal(); connectionAttempt = null; await activate(result.sessionId); await refreshProfiles();
    } catch (e) { if (!attempt.cancelled && connectionAttempt === attempt && attempt.epoch === dialogEpoch) { error.textContent = errorText(e.message); connect.disabled = false; } } finally { credentials.password = ''; credentials.passphrase = ''; } 
  };
  host.focus();
}
async function refreshProfiles() { const state = await call('state'); previewEnabled = state.previewEnabled; adviceState = state.advice; profiles = state.profiles; renderProfiles(); }
const collapsed = new Set();
function renderProfiles() {
  const nav = $('profiles'); nav.replaceChildren(); const query = $('search').value.toLowerCase();
  const found = profiles.filter(p => [p.name, p.host, p.username, p.group].some(v => v?.toLowerCase().includes(query)));
  if (!found.length) nav.append(el('p', query ? 'No matching connections.' : 'No saved connections yet.', { class: 'empty-list' }));
  for (const group of ['Production', 'Development', 'Other']) {
    const items = found.filter(p => (p.group || 'Other') === group); if (!items.length) continue;
    nav.append(button(`${collapsed.has(group) ? '▸' : '▾'} ${group.toUpperCase()}`, () => { collapsed.has(group) ? collapsed.delete(group) : collapsed.add(group); renderProfiles(); }, 'group-title'));
    if (collapsed.has(group)) continue;
    for (const p of items) {
      const live = [...sessions.values()].find(s => s.meta.id === p.id && s.meta.status === 'connected');
      const row = el('div', null, { class: 'profile-row' }); const b = button('', () => live ? activate(live.meta.sessionId) : newConnection(p), `connection${live?.meta.sessionId === active ? ' selected' : ''}`);
      const info = el('span'); info.append(el('strong', p.name || p.host), el('span', `${p.username} · ${p.host}:${p.port}`, { class: 'sub' })); b.append(el('i', null, { class: `dot${live ? ' green' : ''}` }), info);
      row.append(b, button('×', async () => { const body = modal('Delete saved connection?'); body.append(el('p', p.name || p.host)); actions(body, [button('Cancel', clearModal), button('Delete profile', async () => { await call('deleteProfile', p.id); clearModal(); await refreshProfiles(); })]); }, 'profile-delete')); nav.append(row);
    }
  }
}
function conversation(id = active) { if (!conversations.has(id)) conversations.set(id, []); return conversations.get(id); }
function renderMessages() { $('messages').replaceChildren(...conversation()); $('messages').scrollTop = $('messages').scrollHeight; }
function message(text, cls, id = active) { const node = el('div', text, { class: cls }); conversation(id).push(node); if (id === active) renderMessages(); return node; }
async function activate(id) {
  const activation = await call('activate', id); adviceState = activation.advice; if (id !== active) { clearModal(); discardSelection(); attachment = null; $('question').value = ''; }
  active = id; for (const [sid, s] of sessions) s.pane.hidden = sid !== active;
  $('terminal-empty').hidden = id !== 'general'; $('terminals').hidden = id === 'general';
  $('target').textContent = id === 'general' ? 'No SSH session' : `${sessions.get(id).meta.username}@${sessions.get(id).meta.host}:${sessions.get(id).meta.port}`;
  $('ai-context').textContent = id === 'general' ? 'General conversation · no SSH target' : `Conversation linked to ${sessions.get(id).meta.name || sessions.get(id).meta.host}`;
  renderSessions(); renderMessages(); renderAttachment(); $('cancel-ai').hidden = !pendingRequests.has(active); renderExecutions(); await restoreModel(id); renderSharing(); fit();
}
function renderSessions() {
  $('tabs').replaceChildren(button('General conversation', () => activate('general'), active === 'general' ? 'general-navigation active' : 'general-navigation'));
  for (const [id, s] of sessions) {
    const tab = el('div', null, { class: `tab${active === id ? ' active' : ''}` }); const close = button('×', () => closeSession(id)); close.setAttribute('aria-label', `Close session ${s.meta.name || s.meta.host}`); tab.append(button(s.meta.name || s.meta.host, () => activate(id)), close); $('tabs').append(tab);
  }
  $('tabs').append(button('+', () => newConnection(), 'add-tab'));
  const meta = sessions.get(active)?.meta;
  $('connection-state').textContent = meta?.status || 'Disconnected'; $('connection-state').className = meta?.status === 'connected' ? 'connected' : 'muted'; $('disconnect').hidden = !meta || !['connected', 'connecting', 'authenticating'].includes(meta.status);
  $('reconnect').hidden = !meta || (!meta.executionBlocked && !['failed', 'disconnected', 'unavailable'].includes(meta.status));
  $('session-count').textContent = `${[...sessions.values()].filter(s => s.meta.status === 'connected').length} active sessions`;
  renderProfiles();
}
async function closeSession(id) {
  const s = sessions.get(id); const close = async () => { const result = await call('closeTab', id); if (result?.discardedOutputBytes) notice(`Closed tab. ${result.discardedOutputBytes} queued output bytes were discarded with the session.`); pendingRequests.delete(id); if (active === id) await activate('general'); s.term.dispose(); s.pane.remove(); sessions.delete(id); conversations.delete(id); renderSessions(); };
  if (['connected', 'connecting', 'authenticating', 'host-key-required'].includes(s.meta.status)) { const body = modal('Close SSH session?'); body.append(el('p', `${s.meta.username}@${s.meta.host}:${s.meta.port}. Pending approvals will be discarded. Running results may be unknown.`)); actions(body, [button('Cancel', clearModal), button('Close session', async () => { clearModal(); await close(); }, 'mint')]); } else await close();
}
function ensureSession(meta) {
  if (sessions.has(meta.sessionId)) { sessions.get(meta.sessionId).meta = meta; sessions.get(meta.sessionId).term.options.disableStdin = meta.status !== 'connected'; return sessions.get(meta.sessionId); }
  const pane = el('div', null, { class: 'terminal-pane', 'data-session': meta.sessionId }); pane.hidden = true; $('terminals').append(pane);
  const term = new Terminal({ disableStdin: meta.status !== 'connected', fontSize: 13, fontFamily: 'Consolas, Liberation Mono, monospace', scrollback: 3000, allowProposedApi: false, theme: { background: '#080b0d', foreground: '#e7e8e9', cursor: '#8fffc6', selectionBackground: '#344e72' }, linkHandler: { activate() {} } });
  const addon = new FitAddon(); term.loadAddon(addon); term.open(pane);
  pane.addEventListener('mousedown', () => { const dom = document.getSelection(); if (selected?.kind === 'execution' || executionBody(dom?.anchorNode) || executionBody(dom?.focusNode)) { selected = null; dom.removeAllRanges(); renderSelection(); } }, true);
  pane.addEventListener('focusin', () => call('terminalFocus', true).catch(notice));
  pane.addEventListener('focusout', event => { if (!pane.contains(event.relatedTarget)) call('terminalFocus', false).catch(notice); });
  // No WebLinks addon and no OSC clipboard integration. Paste is intercepted before xterm writes.
  pane.addEventListener('paste', safe(async event => { event.preventDefault(); event.stopImmediatePropagation(); const data = event.clipboardData?.getData('text/plain') || ''; if (!data || active !== meta.sessionId) return; const p = await call('pastePreview', { id: active, data }); if (!p.confirmationRequired) return call('paste', p.token); const body = modal('Confirm terminal paste', () => call('invalidate')); body.append(el('p', 'This paste contains line breaks or control characters. Review the complete content before sending it to the manual SSH shell.'), el('pre', p.data.replace(/\r/g, '␍').replace(/\t/g, '⇥').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`))); actions(body, [button('Cancel', clearModal), button('Paste into SSH', async () => { await call('paste', p.token); modalCancel = null; clearModal(); term.focus(); }, 'mint')]); }), true);
  term.attachCustomKeyEventHandler(event => { if (event.type === 'keydown' && event.key.toLowerCase() === 'c' && (event.metaKey || (event.ctrlKey && event.shiftKey)) && term.hasSelection()) { event.preventDefault(); call('copy', term.getSelection()).catch(notice); return false; } return true; });
  term.onData(data => { if (active === meta.sessionId) call('write', { id: active, data }).catch(notice); });
  const terminalSelectionChanged = () => { if (active !== meta.sessionId) return; const text = term.getSelection(); if (!text && selected?.kind === 'execution') return; selected = text ? { kind: 'terminal', text, id: active, generation: meta.generation, source: `${meta.username}@${meta.host}:${meta.port}` } : null; if (text && executionBody(document.getSelection()?.anchorNode)) document.getSelection().removeAllRanges(); renderSelection(); };
  term.onSelectionChange(terminalSelectionChanged);
  // xterm can omit its change event when a cleared range is selected again at the same coordinates.
  pane.addEventListener('mouseup', () => queueMicrotask(terminalSelectionChanged));
  const s = { meta, pane, term, addon, since: Date.now(), executionNodes: new Map() }; sessions.set(meta.sessionId, s); return s;
}
function fit() { const s = sessions.get(active); if (!s || s.pane.hidden) return; requestAnimationFrame(() => { try { s.addon.fit(); if (s.meta.status === 'connected') call('resize', { id: active, cols: s.term.cols, rows: s.term.rows }).catch(() => {}); } catch {} }); }
new ResizeObserver(fit).observe($('terminals'));
function executionBody(node) { return (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('[data-execution-output]') || null; }
function discardSelection() {
  const dom = document.getSelection(); if (executionBody(dom?.anchorNode) || executionBody(dom?.focusNode)) dom.removeAllRanges();
  selected = null; sessions.get(active)?.term.clearSelection(); renderSelection();
}
function validSelection() {
  const s = sessions.get(active); if (!selected || selected.id !== active || !s || selected.generation !== s.meta.generation) return null;
  if (selected.kind === 'terminal') { const dom = document.getSelection(); if (dom && !dom.isCollapsed && ($('executions').contains(dom.anchorNode) || $('executions').contains(dom.focusNode))) return null; return s.term.getSelection() === selected.text ? selected : null; }
  const dom = document.getSelection();
  return !document.activeElement?.matches('input, textarea, [contenteditable=true]') && s.executionNodes.get(`${selected.executionId}-${selected.stream}`)?.outputBody === selected.node && selected.node.isConnected && $('executions').contains(selected.node) && selected.version === selected.node.outputVersion && dom?.rangeCount === 1 && !dom.isCollapsed && executionBody(dom.anchorNode) === selected.node && executionBody(dom.focusNode) === selected.node && dom.toString() === selected.text ? selected : null;
}
function renderSelection() { $('selection-tools').hidden = !selected; $('selection-info').textContent = selected ? `${selected.text.split('\n').length} lines · ${sessions.get(selected.id)?.meta.name || selected.source}${selected.kind === 'execution' ? ` · exec ${selected.executionId.slice(0, 8)} · ${selected.stream}` : ''}` : ''; }
// Keep native output selection intact while using the existing selection toolbar.
$('selection-tools').addEventListener('mousedown', event => event.preventDefault());
document.addEventListener('selectionchange', () => {
  const dom = document.getSelection(), body = executionBody(dom?.anchorNode), focusBody = executionBody(dom?.focusNode);
  if (!body && !focusBody && !$('executions').contains(dom?.anchorNode) && !$('executions').contains(dom?.focusNode) && selected?.kind !== 'execution') return;
  const s = sessions.get(active), editing = document.activeElement?.matches('input, textarea, [contenteditable=true]');
  if (s?.pane.contains(dom?.anchorNode) && s.pane.contains(dom?.focusNode)) { if (selected?.kind === 'execution') { selected = null; renderSelection(); } return; }
  if (!editing && dom.rangeCount === 1 && !dom.isCollapsed && body && body === focusBody && body.isConnected && $('executions').contains(body) && s?.executionNodes.get(`${body.dataset.executionId}-${body.dataset.stream}`)?.outputBody === body && body.dataset.sessionId === active && body.dataset.generation === s?.meta.generation) {
    selected = { kind: 'execution', id: active, generation: s.meta.generation, node: body, version: body.outputVersion, executionId: body.dataset.executionId, stream: body.dataset.stream, text: dom.toString(), source: `${s.meta.username}@${s.meta.host}:${s.meta.port} · execution ${body.dataset.executionId} · ${body.dataset.stream}` };
    s.term.clearSelection();
  } else { selected = null; s?.term.clearSelection(); }
  renderSelection();
});
function renderAttachment() { $('attachment').textContent = attachment ? `${attachment.text.split('\n').length} lines attached · remove/edit` : 'No output attached'; renderSelection(); }
function editAttachment() {
  if (!attachment) return notice('Select terminal output and choose Send to AI.');
  const body = modal('Selected output attachment'); body.append(el('p', attachment.source)); const textarea = el('textarea', null, { 'aria-label': 'Selected output' }); textarea.value = attachment.text; body.append(textarea);
  actions(body, [button('Remove', async () => { attachment = null; await call('invalidate'); clearModal(); renderAttachment(); }), button('Save selection', async () => { attachment.text = textarea.value; await call('invalidate'); clearModal(); renderAttachment(); }, 'mint')]);
}
async function previewMessage() {
  if (!auth.activeAccountId) return notice('Sign in with ChatGPT to preview a request.'); if (!models.length) return notice('No authorized model available. Sign in or refresh your account.');
  const sessionId = active, question = $('question').value, chosen = $('model').value;
  let draft = attachment ? { ...attachment } : null;
  const body = modal('Review data shared with ChatGPT', () => call('invalidate'));
  body.append(el('p', 'Only this complete request will be sent. Local masking can miss secrets; inspect all conversation context. Source labels stay on this device.'));
  const q = el('textarea', null, { 'aria-label': 'Preview question' }); q.value = question;
  const a = el('textarea', null, { 'aria-label': 'Preview selected output' }); a.value = draft?.text || ''; a.hidden = !draft;
  const source = el('p', draft ? `Selected from ${draft.source}` : 'No terminal output attached');
  const request = el('pre', 'Preparing masked preview…', { 'aria-label': 'Complete AI request' }), masking = el('p'), error = el('p', '', { class: 'modal-error' });
  body.append(source, el('label', 'Question'), q, a, masking, request, error);
  let preview = null, revision = 0;
  const send = button('Send confirmed request', async () => { if (!preview || active !== sessionId) return; send.disabled = true; const token = preview.token; message(preview.request.payload.input.at(-1).content, 'question', sessionId); $('question').value = ''; attachment = null; renderAttachment(); modalCancel = null; clearModal(); pendingRequests.add(sessionId); $('cancel-ai').hidden = !pendingRequests.has(active); try { await call('send', token); } finally { pendingRequests.delete(sessionId); $('cancel-ai').hidden = !pendingRequests.has(active); } }, 'mint'); send.disabled = true;
  const update = async () => { const r = ++revision; preview = null; send.disabled = true; await call('invalidate'); try { const next = await call('preview', { sessionId, question: q.value, model: chosen, attachments: draft ? [{ text: a.value, source: draft.source }] : [] }); if (r !== revision || !body.isConnected || !$('modal').open || active !== sessionId) return; preview = next; request.textContent = JSON.stringify(next.request, null, 2); masking.textContent = `${next.redactions} secret pattern(s) masked. Detection is incomplete. Account: ${next.accountId} · Model: ${next.model}`; send.disabled = false; error.textContent = ''; } catch (e) { if (r === revision) error.textContent = errorText(e.message); } };
  q.addEventListener('input', safe(update)); a.addEventListener('input', safe(update));
  actions(body, [button('Cancel', clearModal), button('Remove attachment', async () => { draft = null; a.hidden = true; source.textContent = 'No terminal output attached'; await update(); }), send]); await update();
}
function renderSharing() {
  const connected = sessions.get(active)?.meta.status === 'connected';
  $('preview-toggle').textContent = `미리보기 ${previewEnabled ? 'ON' : 'OFF'}`; $('preview-toggle').setAttribute('aria-pressed', String(previewEnabled));
  $('send-message').textContent = previewEnabled ? 'Preview →' : '전송 ↵'; $('send-message').setAttribute('aria-label', previewEnabled ? 'Preview message' : 'Send message');
  $('send-message').disabled = pendingRequests.has(active) || directRequests.has(active);
  $('send-hint').textContent = previewEnabled ? 'Enter: 미리보기 · Shift+Enter: 줄바꿈' : 'Enter: 바로 전송 · Shift+Enter: 줄바꿈';
  $('advice-toggle').textContent = `AI 자동 조언 ${adviceState.enabled ? 'ON · 중지' : 'OFF'}`; $('advice-toggle').setAttribute('aria-pressed', String(adviceState.enabled));
  $('advice-toggle').disabled = !adviceState.enabled && (!connected || !auth.activeAccountId || !models.length);
  $('advice-toggle').title = adviceState.enabled ? '이후 자동 전송을 중지합니다.' : !connected ? '먼저 SSH 세션에 연결해 주세요.' : !auth.activeAccountId || !models.length ? 'ChatGPT 로그인과 모델 선택이 필요합니다.' : '공유할 계정·모델·출력 범위를 확인한 뒤 켤 수 있습니다.';
  $('advice-status').hidden = !adviceState.enabled && !adviceState.reason;
  const reason = { stopped: '사용자가 중지했습니다.', cancelled: '응답을 취소했습니다.', 'tab-changed': '다른 탭으로 이동했습니다.', 'tab-closed': '세션 탭을 닫았습니다.', 'model-changed': '모델이 바뀌었습니다.', 'account-changed': '계정 또는 인증 상태가 바뀌었습니다.', 'connection-changed': 'SSH 연결이 바뀌거나 끊겼습니다.', 'context-changed': '공유 대상이 바뀌었습니다.', 'conversation-reset': '새 대화를 시작했습니다.', 'limit-reached': '10회 안내를 완료했습니다. 계속하려면 다시 켜세요.', 'request-failed': 'AI 요청이 실패했습니다. 다시 켜기 전 연결과 사용 한도를 확인하세요.', 'renderer-restarted': '화면이 다시 시작됐습니다.' }[adviceState.reason] || '다시 켜려면 공유 범위를 확인하세요.';
  $('advice-status').textContent = adviceState.enabled ? `새 SSH 출력 자동 공유 중 · ${adviceState.remaining}회 남음` : `자동 공유 중지 · ${reason}${adviceState.error ? ` ${errorText(adviceState.error)}` : ''}`;
  $('sharing-privacy').textContent = adviceState.enabled ? '동의한 새 SSH 출력과 이 대화의 이전 내용이 공유됩니다.' : '질문·직접 첨부한 출력·이 대화의 이전 내용이 전송됩니다.';
}
async function submitMessage() {
  if (pendingRequests.has(active) || directRequests.has(active)) return;
  if (previewEnabled) return previewMessage();
  if (!auth.activeAccountId || !models.length) return notice('Sign in and select an authorized AI model first.');
  const sessionId = active, question = $('question').value, selectedAttachment = attachment;
  if (!question.trim()) return;
  directRequests.set(sessionId, { question, attachment: selectedAttachment }); pendingRequests.add(sessionId); renderSharing();
  $('question').value = ''; attachment = null; renderAttachment(); $('cancel-ai').hidden = false;
  try { await call('directSend', { sessionId, question, model: $('model').value, attachments: selectedAttachment ? [{ ...selectedAttachment }] : [] }); }
  catch (e) { if (active === sessionId && !$('question').value) { $('question').value = question; if (!attachment) attachment = selectedAttachment; renderAttachment(); } throw e; }
  finally { directRequests.delete(sessionId); pendingRequests.delete(sessionId); $('cancel-ai').hidden = !pendingRequests.has(active); renderSharing(); }
}
async function toggleAdvice() {
  if (adviceState.enabled) { adviceState = await call('adviceStop'); renderSharing(); return; }
  const prepared = await call('advicePrepare', { sessionId: active, model: $('model').value });
  const body = modal('AI 자동 조언 켜기', () => call('adviceStop'));
  body.append(el('p', `공유할 SSH 세션: ${prepared.target.username}@${prepared.target.host}:${prepared.target.port}\nChatGPT 계정: ${prepared.account}\n모델: ${prepared.model}`), el('p', '켜는 시점 이후 앱에서 이 세션의 새 터미널·실행 출력을 수신할 때만 자동 공유합니다. 최근 출력 최대 8KB를 모아 출력이 잠시 멈추거나 최대 10초가 지나면 안내를 요청합니다. 최소 1분 간격, 최대 10회이며 질문과 기존 대화도 요청에 포함됩니다.'), el('p', '화면 캡처나 다른 세션은 읽지 않습니다. 로컬 비밀 가림은 완벽하지 않습니다. 끄면 이후 전송을 중지하지만 이미 보낸 내용은 회수할 수 없습니다. 계정·모델·탭·연결·대화가 바뀌면 꺼집니다. 명령 실행은 별도 승인이 필요합니다.'));
  const consent = field(body, '이 세션의 새 출력을 ChatGPT에 자동 공유하는 데 동의합니다', 'advice-consent', 'checkbox');
  const enable = button('동의하고 켜기', async () => { enable.disabled = true; try { adviceState = await call('adviceEnable', prepared.token); modalCancel = null; clearModal(); renderSharing(); } catch (e) { clearModal(); notice('공유 동의가 만료되었거나 대상이 바뀌었습니다. AI 자동 조언 버튼에서 다시 확인해 주세요.'); } }, 'mint'); enable.disabled = true; consent.onchange = () => { enable.disabled = !consent.checked; };
  actions(body, [button('Cancel', clearModal), enable]);
}
async function showExecution(command) {
  if (active === 'general') return notice('Connect and select an SSH session to review execution.');
  const e = await call('execution', { id: active, command });
  const body = modal('Review command execution', () => call('cancelExecution', e.id));
  body.append(el('p', `Trusted SSH target: ${e.target.username}@${e.target.host}:${e.target.port}\nSession ${e.sessionId}\nGeneration ${e.generation}`), el('div', e.target.fingerprint, { class: 'fingerprint' }), el('pre', e.command), el('p', 'Separate SSH exec channel. Server default login environment. Does not inherit the terminal directory or environment. Current directory, shell and effective privileges are unknown.'), el('p', `Risks: ${e.policy.risks.join(', ') || 'Remote executables and startup configuration can have side effects.'}`, { class: 'danger' }));
  if (!e.policy.allowed) body.append(el('p', `Execution blocked: ${e.policy.reasons.join(', ')}. Review and enter manually if appropriate.`, { class: 'modal-error' }));
  const approve = button('Approve & run once', async () => { approve.disabled = true; await call('approve', e.token); modalCancel = null; clearModal(); }, 'mint'); approve.disabled = !e.token;
  actions(body, [button('Cancel', clearModal), approve]);
}
function commandCard(card, id) { const node = el('section', null, { class: 'suggestion' }); const heading = el('div', 'Suggested command', { class: 'suggestion-title' }); heading.prepend(icon('cutout-88-adea854f6b8d.png')); node.append(heading, el('code', card.command, { class: 'command' })); const row = el('div', null, { class: 'actions' }); row.append(button('Copy', () => call('copy', card.command)), button('Review & run', () => { if (active !== id) return notice('Select the source SSH tab first.'); return showExecution(card.command); }, 'mint')); const note = el('p', 'Separate approval required. No safety guarantee.', { class: 'approval-note' }); note.prepend(icon('cutout-93-eb28c1dfa39f.png')); node.append(row, note); conversation(id).push(node); }
async function restoreModel(id = active) {
  const result = await call('sessionModel', id); if (id !== active) return;
  $('model').value = models.some(m => m.slug === result.model) ? result.model : models[0]?.slug || '';
}
function renderExecutions() {
  if (selected?.kind === 'execution') discardSelection();
  const nodes = [...(sessions.get(active)?.executionNodes.values() || [])]; $('executions').replaceChildren(...nodes); $('executions').hidden = !nodes.length;
}
function executionNode(s, key) { if (!s.executionNodes.has(key)) s.executionNodes.set(key, el('div', '', { class: 'execution-status' })); if (s.meta.sessionId === active) renderExecutions(); return s.executionNodes.get(key); }
function appendExecutionOutput(s, detail) {
  const node = executionNode(s, `${detail.executionId}-${detail.stream}`), limit = 1048576;
  node.totalBytes = (node.totalBytes || 0) + new TextEncoder().encode(detail.data).length;
  const encoded = new TextEncoder().encode((node.outputText || '') + detail.data); let start = Math.max(0, encoded.length - limit);
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
  node.outputText = new TextDecoder().decode(encoded.subarray(start));
  const retained = new TextEncoder().encode(node.outputText).length, omitted = node.totalBytes - retained;
  if (!node.outputBody) { node.outputBody = el('span', '', { 'data-execution-output': '', 'data-session-id': s.meta.sessionId, 'data-generation': s.meta.generation, 'data-execution-id': detail.executionId, 'data-stream': detail.stream }); node.outputLabel = el('span'); node.append(node.outputLabel, node.outputBody); }
  node.outputBody.outputVersion = (node.outputBody.outputVersion || 0) + 1;
  node.outputLabel.textContent = `${detail.stream}\n${omitted ? `[Output truncated: ${omitted} bytes omitted; showing ${retained} bytes; limit ${limit} bytes]\n` : ''}`;
  node.outputBody.textContent = node.outputText;
  node.dataset.omittedBytes = String(omitted);
}
function showLogoutResult(result) {
  notice(`${result.localCredentialsCleared === false ? 'Credentials are blocked in this session, but deleting stored credentials failed. Clear stored app credentials before restarting.' : 'Local credentials cleared.'} ${result.remoteRevocationConfirmed ? 'Remote revocation confirmed.' : 'Remote revocation could not be confirmed; revoke this app in your account settings.'}`);
}
async function login(remember = false, addNew = false) {
  if (loginPending) return;
  const accountId = !addNew && $('account').value; loginPending = true; loginError = ''; renderSettingsAuth();
  try { await call('login', { remember, ...(accountId ? { accountId } : {}) }); }
  catch (e) { loginPending = false; loginError = errorText(e.message); renderSettingsAuth(); throw e; }
  $('cancel-login').hidden = !loginPending;
}
async function cancelLogin() { await call('cancelLogin'); loginPending = false; loginError = ''; $('cancel-login').hidden = true; renderSettingsAuth(); }
async function recoverTrust(sessionId) {
  const preview = await call('rotatePreview', sessionId), body = modal('Verify replacement SSH host key');
  body.append(el('p', `Target: ${preview.old.host}:${preview.old.port}. Authentication remains blocked until you independently verify the replacement key.`), el('p', 'Previously trusted fingerprint'), el('div', preview.old.fingerprint, { class: 'fingerprint' }), el('p', `Observed replacement (${preview.next.keyType})`), el('div', preview.next.fingerprint, { class: 'fingerprint' }));
  const verified = field(body, 'I independently verified the new fingerprint with the server administrator', 'verified', 'checkbox');
  const confirm = button('Replace trusted key', async () => { await call('rotateConfirm', { token: preview.token, verified: verified.checked }); clearModal(); notice('Trusted key replaced. Reconnect explicitly with your credentials.'); }, 'mint'); confirm.disabled = true; verified.onchange = () => { confirm.disabled = !verified.checked; };
  actions(body, [button('Cancel', clearModal), confirm]);
}
async function renderAuth(value) {
  const previousSelection = $('account').value; auth = value; const account = value.accounts.find(a => a.id === value.activeAccountId), connected = !!account?.authenticated;
  $('auth-state').textContent = connected ? `ChatGPT · ${account.email || account.label || 'Signed in'}${value.developmentFixture ? ' · DEVELOPMENT FIXTURE' : ''}` : 'ChatGPT · Not signed in'; $('auth-state').prepend(icon('cutout-77-341000b4a2b3.png'));
  $('login').hidden = connected; $('logout').hidden = !connected; $('account-label').hidden = !value.accounts.length; $('model-label').hidden = !connected;
  $('account').replaceChildren(el('option', 'Choose account', { value: '' }), ...value.accounts.map(a => el('option', a.email || a.label || a.id, { value: a.id }))); $('account').value = value.activeAccountId || (value.accounts.some(a => a.id === previousSelection) ? previousSelection : value.accounts[0]?.id || ''); $('add-account').hidden = !value.accounts.length;
  renderSettingsAuth();
  if (connected) { try { models = await call('models'); $('model').replaceChildren(...models.map(m => el('option', m.display_name, { value: m.slug }))); await restoreModel(); } catch (e) { notice(e); } } else { models = []; $('model').replaceChildren(); }
  renderSharing();
}
function renderSettingsAuth() {
  const status = $('settings-auth-status'); if (!status || !$('modal').open) return;
  const account = auth.accounts?.find(a => a.id === auth.activeAccountId), connected = !!account?.authenticated;
  const wasConnected = status.dataset.connected === 'true'; status.dataset.connected = String(connected);
  const state = loginPending ? 'pending' : loginError ? 'error' : connected ? 'connected' : 'disconnected';
  status.dataset.state = state;
  $('settings-auth-label').textContent = `ChatGPT · ${loginPending ? '로그인 중…' : loginError ? '로그인 실패' : connected ? '연결됨' : '연결 안 됨'}`;
  $('settings-auth-detail').textContent = loginPending ? '브라우저에서 로그인을 완료해 주세요. 연결이 확인되면 자동으로 갱신됩니다.' : loginError || (connected ? `${account.email || account.label || '로그인된 계정'}${auth.developmentFixture ? ' · DEVELOPMENT FIXTURE' : ''}` : 'ChatGPT에 로그인하면 연결된 계정이 여기에 표시됩니다.');
  $('settings-sign-in').hidden = connected && !loginError; $('settings-sign-in').disabled = loginPending;
  $('settings-sign-out').hidden = !connected; $('settings-cancel-login').hidden = !loginPending;
  const remember = document.querySelector('#modal input[name="remember"]');
  if (remember) { remember.disabled = auth.persistence !== 'encrypted' || connected || loginPending; if (connected) remember.checked = !!account.remembered; else if (wasConnected) remember.checked = false; }
}
function settings() {
  const body = modal('Settings & privacy');
  const status = el('div', null, { id: 'settings-auth-status', class: 'settings-auth-status', role: 'status', 'aria-live': 'polite' });
  status.append(el('strong', '', { id: 'settings-auth-label' }), el('p', '', { id: 'settings-auth-detail' })); body.append(status);
  body.append(el('p', `KeyShell ${settings.version} · ${settings.packaged ? 'Packaged build' : 'Development build'}\nAuthentication storage: ${auth.persistence === 'encrypted' ? 'OS encrypted storage available' : 'Memory only'}.`), el('p', 'SSH credentials stay in memory. Saved connection profiles, trusted host keys and ChatGPT account registration metadata (email, identity, client ID and host ID) persist locally. ChatGPT tokens persist only when you opt into OS-encrypted storage. Sign-out removes tokens while keeping account registration mappings for future sign-in. Conversations, terminal output and execution records stay in memory and are discarded when the app exits. Nothing reconnects, sends or executes automatically after restart.'));
  for (const session of sessions.values()) if (session.meta.error === 'E-SSH-HOSTKEY-CHANGED') body.append(button(`Recover trusted key: ${session.meta.host}:${session.meta.port}`, () => recoverTrust(session.meta.sessionId)));
  const remember = field(body, 'Remember ChatGPT login using OS encryption', 'remember', 'checkbox'); remember.disabled = auth.persistence !== 'encrypted';
  const signIn = button('Sign in', () => login(remember.checked)), signOut = button('Sign out', async () => showLogoutResult(await call('logout'))), cancel = button('Cancel sign-in', cancelLogin);
  signIn.id = 'settings-sign-in'; signOut.id = 'settings-sign-out'; cancel.id = 'settings-cancel-login';
  actions(body, [cancel, signIn, signOut, button('Done', clearModal)]); renderSettingsAuth();
}
async function updateDialog(check = false) {
  let state; try { state = check ? await call('checkUpdate') : (await call('state')).updates; } catch (e) { notice(e); return; }
  const body = modal('App updates'); body.append(el('p', `Current version ${state.current}. Status: ${state.status}. ${state.version ? `Release ${state.version}` : ''}`)); if (state.notes) body.append(el('pre', state.notes)); if (state.error) body.append(el('p', errorText(state.error), { class: 'modal-error' }));
  actions(body, [button('Later', clearModal), ...(!['downloaded', 'downloading'].includes(state.status) ? [button('Check again', () => updateDialog(true))] : []), ...(state.status === 'available' ? [button('Download update', async () => { await call('downloadUpdate'); await updateDialog(); }, 'mint')] : []), ...(state.status === 'downloaded' ? [button('Install & restart', () => call('installUpdate'), 'mint')] : [])]);
}
window.keyshell.subscribe(safe(async ({ type, detail }) => {
  if (type === 'session') { ensureSession(detail);
    if (['failed', 'disconnected'].includes(detail.status)) { if (active === detail.sessionId) { discardSelection(); attachment = null; renderAttachment(); } if (detail.error) notice(detail.error); }
    renderSessions(); if (active === detail.sessionId) $('connection-state').textContent = detail.status; renderSharing();
  } else if (type === 'host-key') {
    const attempt = connectionAttempt;
    if (!attempt || attempt.cancelled || detail.attemptId !== attempt.id || attempt.epoch !== dialogEpoch) { await call('hostKey', { id: detail.challengeId, trust: false }); return; }
    modalCancel = null; const body = modal('Verify SSH host key', () => { attempt.cancelled = true; return call('cancelConnect', attempt.id); }); attempt.epoch = dialogEpoch;
    body.append(el('p', `First connection to ${detail.username}@${detail.host}:${detail.port}\nRemote endpoint ${detail.remoteAddress}:${detail.remotePort}\nKey type ${detail.keyType}`), el('div', detail.fingerprint, { class: 'fingerprint' }), el('p', 'Compare the complete fingerprint through a trusted channel. Authentication will begin only after you trust it.'));
    actions(body, [button('Cancel connection', clearModal), button('Trust & connect', async () => { if (attempt.cancelled || attempt.epoch !== dialogEpoch) return; await call('hostKey', { id: detail.challengeId, trust: true }); }, 'mint')]);
  } else if (type === 'output') {
    const acknowledge = () => detail.ackId ? call('ackOutput', detail.ackId).catch(notice) : undefined;
    const s = sessions.get(detail.sessionId); if (!s || s.meta.generation !== detail.generation) { acknowledge(); return; }
    if (detail.channel === 'terminal') s.term.write(detail.data, acknowledge);
    else { appendExecutionOutput(s, detail); acknowledge(); }
  } else if (type === 'execution') {
    const s = sessions.get(detail.sessionId); if (!s) return;
    const node = executionNode(s, `${detail.id}-status`);
    node.textContent = `${detail.command}\nExecution: ${detail.status}${Number.isInteger(detail.exitCode) ? ` · exit ${detail.exitCode}` : ''}${detail.error ? ` · ${errorText(detail.error)}` : ''}`;
    if (detail.status === 'running') { const stop = button('Request remote TERM', async () => { await call('cancelExecution', detail.id); stop.disabled = true; }); node.append(stop); }
  } else if (type === 'change') { loginPending = false; loginError = ''; if (!$('settings-auth-status') || !$('modal').open) clearModal(); discardSelection(); attachment = null; conversations.clear(); renderMessages(); renderAttachment(); $('cancel-login').hidden = true; await renderAuth(detail); }
  else if (type === 'auth-error') { if (detail.code === 'E-AUTH-CANCELLED') return; loginPending = false; loginError = errorText(detail.code); $('cancel-login').hidden = true; renderSettingsAuth(); notice(detail.code); }
  else if (type === 'advice') { adviceState = detail; renderSharing(); }
  else if (type === 'manual-question' || type === 'automatic-question') {
    message(`${type === 'automatic-question' ? '자동 조언 요청\n' : ''}${detail.text}`, 'question', detail.sessionId);
  }
  else if (type === 'ai') {
    const id = detail.sessionId || active;
    if (detail.type === 'queued' || detail.type === 'sending') { pendingRequests.add(id); $('cancel-ai').hidden = !pendingRequests.has(active); }
    else if (detail.type === 'cancelled') { pendingRequests.delete(id); $('cancel-ai').hidden = !pendingRequests.has(active); const n = conversation(id).find(n => n.dataset.request === detail.requestId); if (n) n.append(el('p', '응답이 중지되었습니다. 자동 재전송하지 않습니다.', { class: 'sub' })); else { const status = message('응답이 중지되었습니다. 자동 재전송하지 않습니다.', 'request-status', id); status.dataset.request = detail.requestId; } }
    else if (detail.type === 'delta') { const log = conversation(id); let n = log.find(n => n.dataset.request === detail.requestId); if (!n) { n = message('', 'answer', id); n.dataset.request = detail.requestId; } n.textContent += detail.text; if (active === id) $('messages').scrollTop = $('messages').scrollHeight; }
    else if (detail.type === 'completed') { for (const card of detail.commands) commandCard(card, id); if (active === id) renderMessages(); pendingRequests.delete(id); $('cancel-ai').hidden = !pendingRequests.has(active); }
    else if (detail.type === 'error') { message(`${errorText(detail.error.code)} · ${detail.error.transmission}. No automatic retry.`, 'answer', id); pendingRequests.delete(id); $('cancel-ai').hidden = !pendingRequests.has(active); }
    else if (detail.type === 'reset') { pendingRequests.clear(); $('cancel-ai').hidden = true; conversations.clear(); renderMessages(); }
    renderSharing();
  } else if (type === 'update') { $('update').textContent = detail.status === 'available' ? `Update ${detail.version} available` : detail.status === 'downloaded' ? 'Update ready to install' : 'Check for updates'; }
}));
for (const b of document.querySelectorAll('[data-new]')) b.onclick = () => newConnection();
for (const b of document.querySelectorAll('[data-window]')) b.onclick = safe(() => call('window', b.dataset.window));
$('search').oninput = renderProfiles;
$('settings').onclick = settings; $('update').onclick = safe(() => updateDialog());
$('disconnect').onclick = safe(() => closeSession(active)); $('reconnect').onclick = () => { const m = sessions.get(active).meta; newConnection({ host: m.host, port: m.port, username: m.username, name: m.name, id: m.id, group: m.group }); };
$('copy-selection').onclick = safe(() => { const choice = validSelection(); if (!choice) { discardSelection(); return; } return call('copy', choice.text); });
$('clear-selection').onclick = discardSelection;
$('share-selection').onclick = () => { const choice = validSelection(); if (!choice) { discardSelection(); return; } attachment = { text: choice.text, source: choice.source }; renderAttachment(); $('question').focus(); };
$('attachment').onclick = editAttachment;
$('composer').onsubmit = safe(event => { event.preventDefault(); return submitMessage(); });
$('question').addEventListener('compositionstart', () => { composing = true; }); $('question').addEventListener('compositionend', () => { composing = false; });
$('question').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); if (!event.repeat) submitMessage().catch(notice); } };
$('preview-toggle').onclick = safe(async () => { const result = await call('previewMode', !previewEnabled); previewEnabled = result.previewEnabled; renderSharing(); });
$('advice-toggle').onclick = safe(toggleAdvice);
$('question').oninput = safe(() => call('invalidate'));
$('login').onclick = safe(() => login()); $('add-account').onclick = safe(() => login(false, true));
$('cancel-login').onclick = safe(cancelLogin);
$('logout').onclick = safe(async () => showLogoutResult(await call('logout')));
$('account').onchange = safe(() => $('account').value ? call('account', $('account').value) : null);
$('model').onchange = safe(() => call('model', { id: active, model: $('model').value }));
$('new-chat').onclick = safe(async () => { await call('reset', active); pendingRequests.delete(active); $('cancel-ai').hidden = true; conversations.delete(active); attachment = null; renderMessages(); renderAttachment(); });
$('cancel-ai').onclick = safe(async () => { await call('cancelAI', active); pendingRequests.delete(active); $('cancel-ai').hidden = true; notice('AI request cancelled. A transmitted request may have reached the service.'); });
setInterval(() => { const s = sessions.get(active); $('elapsed').textContent = s ? `${s.meta.status} · ${Math.floor((Date.now() - s.since) / 60000)}m · latency not measured` : 'No active session'; }, 1000);
async function start() { const state = await call('state'); previewEnabled = state.previewEnabled; adviceState = state.advice; profiles = state.profiles; settings.version = state.version; settings.packaged = state.packaged; renderProfiles(); for (const meta of state.sessions) ensureSession(meta); await renderAuth(state.auth); await activate('general'); if (state.recovery) { $('recovery').textContent = state.recovery.message; $('recovery').hidden = false; } for (const e of state.executions || []) { const s = sessions.get(e.sessionId); if (s) executionNode(s, `${e.id}-status`).textContent = `${e.command}\nExecution: ${e.status}${Number.isInteger(e.exitCode) ? ` · exit ${e.exitCode}` : ''}\nPrevious output was not recovered after renderer restart.`; } }
start().catch(notice);

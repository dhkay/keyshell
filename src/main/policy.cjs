'use strict';
const net = require('node:net');
const { domainToASCII } = require('node:url');
const LIMITS = Object.freeze({ command: 8192, input: 65536, selection: 1048576, privateKey: 1048576 });
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function text(value, max, code = 'E-SSH-INPUT') {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value)) fail(code);
  return value;
}
function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('E-SSH-INPUT');
  const allowed = ['id', 'name', 'host', 'port', 'username', 'group'];
  if (Object.keys(input).some(k => !allowed.includes(k))) fail('E-SSH-INPUT');
  let host = text(input.host, 253).toLowerCase();
  if (!net.isIP(host)) {
    host = domainToASCII(host);
    if (!host || !host.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) fail('E-SSH-INPUT');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) fail('E-SSH-INPUT');
  const username = text(input.username, 128);
  if (!/^[a-zA-Z0-9_.@-]+$/.test(username)) fail('E-SSH-INPUT');
  const out = { host, port: input.port, username };
  if (input.id !== undefined) { out.id = text(input.id, 128); if (!/^[\w-]+$/.test(out.id)) fail('E-SSH-INPUT'); }
  if (input.name !== undefined) out.name = text(input.name, 128);
  if (input.group !== undefined) { if (!['Production', 'Development', 'Other'].includes(input.group)) fail('E-SSH-INPUT'); out.group = input.group; }
  return out;
}
function validateCredentials(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('E-SSH-AUTH-INPUT');
  if (c.type === 'password') {
    if (Object.keys(c).some(k => !['type', 'password'].includes(k)) || typeof c.password !== 'string' || !c.password.length || Buffer.byteLength(c.password) > 16384 || c.password.includes('\0')) fail('E-SSH-AUTH-INPUT');
    return { type: c.type, password: c.password };
  }
  if (c.type === 'privateKey') {
    if (Object.keys(c).some(k => !['type', 'privateKeyPath', 'passphrase'].includes(k))) fail('E-SSH-AUTH-INPUT');
    const out = { type: c.type, privateKeyPath: text(c.privateKeyPath, 4096, 'E-SSH-AUTH-INPUT') };
    if (c.passphrase !== undefined) { if (typeof c.passphrase !== 'string' || Buffer.byteLength(c.passphrase) > 16384 || c.passphrase.includes('\0')) fail('E-SSH-AUTH-INPUT'); out.passphrase = c.passphrase; }
    return out;
  }
  fail('E-SSH-AUTH-UNSUPPORTED');
}
// Deliberately small grammar: no shell expansion, operators, quoting, scripts or
// arbitrary executables. Even these utilities can have server-specific effects.
function inspectCommand(command) {
  const reasons = [], risks = [];
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > LIMITS.command) reasons.push('invalid-size');
  if (typeof command !== 'string') return { allowed: false, reasons, risks };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(command)) return { allowed: false, reasons: [...reasons, 'control-whitespace'], risks };
  // Single quotes are parsed only as literal arguments; interpolation and nested
  // shell structures remain forbidden even inside quotes.
  const words = []; let remaining = command.trim();
  while (remaining) {
    const match = /^(?:'([A-Za-z0-9_/. :,+%=-]*)'|([A-Za-z0-9_/. :,+%=-]+?))(?= |$)/.exec(remaining);
    if (!match) { reasons.push('unreviewable-shell-syntax'); break; }
    words.push(match[1] ?? match[2]); remaining = remaining.slice(match[0].length).trimStart();
  }
  let cmd = words[0], args = words.slice(1);
  if (cmd === 'sudo') {
    risks.push('privilege-change');
    if (args[0] !== '-n') reasons.push('interactive-or-privileged-context');
    else { cmd = args[1]; args = args.slice(2); }
  }
  const rules = {
    pwd: a => a.length === 0,
    whoami: a => a.length === 0,
    hostname: a => a.length === 0,
    uptime: a => a.length === 0,
    id: a => a.length === 0,
    uname: a => a.every(x => /^-[asnrvmipo]+$/.test(x)),
    ls: a => a.every(x => /^-[alhndrtS]+$/.test(x) || x.startsWith('/')),
    cat: a => a.length > 0 && a.every(x => x.startsWith('/')),
    df: a => a.every(x => /^-[hPTik]+$/.test(x) || x.startsWith('/')),
    du: a => a.every(x => /^-[hskx]+$/.test(x) || x.startsWith('/')),
    rm: a => a.length > 0 && a.some(x => x.startsWith('/')) && a.every(x => /^-[rfiv]+$/.test(x) || x.startsWith('/')),
    chmod: a => a.length >= 2 && /^[0-7]{3,4}$/.test(a[0]) && a.slice(1).every(x => x.startsWith('/')),
    systemctl: a => a.length >= 2 && a.length <= 3 && ['status', 'stop', 'restart', 'start'].includes(a[0]) && /^[\w@.-]+$/.test(a[1]) && (a.length === 2 || a[2] === '--no-pager'),
    ss: a => a.length >= 1 && a.length <= 2 && /^-[ltnpua]+$/.test(a[0]) && (a.length === 1 || /^(?:sport|dport) = :[0-9]{1,5}$/.test(a[1])),
    journalctl: a => { if (!a.includes('--no-pager')) return false; for (let i = 0; i < a.length; i++) { if (['--no-pager', '-xe', '-x', '-e'].includes(a[i])) continue; if (['-u', '--unit'].includes(a[i]) && /^[\w@.-]+$/.test(a[++i] || '')) continue; if (['-n', '--lines'].includes(a[i]) && /^[0-9]{1,5}$/.test(a[++i] || '')) continue; return false; } return true; }
  };
  if (!Object.hasOwn(rules, cmd) || !rules[cmd](args)) reasons.push('unreviewed-command-or-context');
  if (['curl', 'wget', 'scp', 'rsync', 'ssh', 'nc', 'sftp'].includes(cmd)) reasons.push('external-transfer-unverified');
  if (['sudo', 'su'].includes(cmd)) { risks.push('privilege-change'); reasons.push('interactive-or-privileged-context'); }
  if (cmd === 'rm') risks.push('deletion');
  if (cmd === 'chmod') risks.push('permission-change');
  if (cmd === 'systemctl' && args[0] !== 'status') risks.push('service-change');
  return { allowed: reasons.length === 0, reasons, risks, safetyGuaranteed: false, externalTransfer: null,
    limitations: ['Server executables and login startup configuration can have side effects.', 'No interactive-shell directory or environment is inherited.'] };
}
function redactSecrets(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > LIMITS.selection) fail('E-SHARE-SIZE');
  let count = 0;
  const mask = () => { count++; return '[REDACTED]'; };
  const value = input
    .replace(/-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----|$)/g, mask)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, mask)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, (_, p) => p + mask())
    .replace(/\b(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|client[_-]?secret)\b(\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, (_, k, sep) => k + sep + mask())
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:]+:)[^\s/@]+(@)/gi, (_, before, after) => before + mask() + after);
  return { text: value, redactions: count, reviewRequired: true, completeDetection: false };
}
module.exports = { LIMITS, fail, validateProfile, validateCredentials, inspectCommand, redactSecrets };

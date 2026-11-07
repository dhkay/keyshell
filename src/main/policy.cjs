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
// User review authorizes the exact command, not a fixed executable allow-list.
// Risks are advisory; only malformed or hidden-control input is rejected.
function inspectCommand(command) {
  const reasons = [], risks = [];
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > LIMITS.command) reasons.push('invalid-size');
  if (typeof command !== 'string') return { allowed: false, reasons, risks, safetyGuaranteed: false };
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(command) || !command.isWellFormed()) reasons.push('hidden-control-characters');
  if (command.includes('****')) reasons.push('redacted-placeholder');
  if (/[\n]/.test(command)) risks.push('multiple-lines');
  if (/[;&|<>]/.test(command)) risks.push('compound-shell-command');
  if (/[$`]/.test(command)) risks.push('shell-expansion');
  if (/\b(?:sudo|su|doas)\b/.test(command)) risks.push('privilege-change');
  if (/\b(?:rm|rmdir|shred|unlink)\b/.test(command)) risks.push('deletion');
  if (/\b(?:chmod|chown|chgrp)\b/.test(command)) risks.push('permission-change');
  if (/\b(?:systemctl|service)\b/.test(command) && /\b(?:stop|restart|start|reload|disable|enable)\b/.test(command)) risks.push('service-change');
  const transfer = /\b(?:curl|wget|scp|rsync|ssh|nc|sftp)\b/.test(command);
  if (transfer) risks.push('external-transfer');
  if (/\b(?:vim?|nano|less|more|top|htop|passwd|read)\b/.test(command)) risks.push('interactive-command');
  return { allowed: reasons.length === 0, reasons, risks, safetyGuaranteed: false, externalTransfer: transfer ? true : null,
    limitations: ['Server executables and login startup configuration can have side effects.', 'No interactive-shell directory or environment is inherited.', 'Interactive input is unavailable in a separate execution channel; use the terminal for interactive commands.'] };
}
function redactSecrets(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > LIMITS.selection) fail('E-SHARE-SIZE');
  let count = 0;
  const mask = () => { count++; return '****'; };
  const secretName = /(?:password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|session[_-]?(?:id|key)|client[_-]?key|private[_-]?key|signature|credential|authorization|cookie)(?:[_-]?(?:value|data|hash))?$/i;
  const assignment = new RegExp(String.raw`(?<![\w.-])([A-Za-z_][A-Za-z0-9_.-]{0,127}|비밀번호|패스워드|API\s*키)(["']?\s*[=:]\s*)`, 'gi');
  // Match names first: consuming an unrelated JSON string would hide nested log secrets.
  let value = input;
  const eligible = [];
  for (const m of value.matchAll(assignment)) if (secretName.test(m[1]) || /^(비밀번호|패스워드|API\s*키)$/i.test(m[1])) eligible.push(m);
  for (const m of eligible.reverse()) {
    const start = m.index + m[0].length, rest = value.slice(start);
    const token = /^(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\s,;}\]\&"']+)/.exec(rest);
    if (token && token[0] !== '****') value = value.slice(0, start) + mask() + rest.slice(token[0].length);
  }
  value = value
    .replace(/(--(?:password|passwd|passphrase|token|secret|api[-_]key|access[-_]key|client[-_]secret))(?:=|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi, (_, flag) => flag + '=' + mask())
    .replace(/\b(sshpass\s+-p\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi, (_, prefix) => prefix + mask())
    .replace(/-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----|$)/g, mask)
    .replace(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{16,})\b/g, mask)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, mask)
    .replace(/((?:proxy-)?authorization|set-cookie|cookie)(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi, (_, key, sep) => key + sep + mask())
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, (_, prefix) => prefix + mask())
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:]+:)[^\s/@]+(@)/gi, (_, before, after) => before + mask() + after)
    .replace(/\b(mysql|mariadb)([^\r\n]*?\s)(?:--password(?:=|\s+)|-p)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi, (_, command, before) => command + before + '--password=' + mask());
  value = value.replace(/[0-9a-fA-F:.]{2,80}(?:%[A-Za-z0-9_.-]{1,64})?/g, candidate => {
    const zone = candidate.indexOf('%'), base = zone < 0 ? candidate : candidate.slice(0, zone);
    if (!base.includes(':')) return candidate;
    const leading = /^[.:]*/.exec(base)[0].length, trailing = /[.:]*$/.exec(base)[0].length;
    for (let left = 0; left <= leading; left++) for (let right = 0; right <= trailing; right++) {
      const end = base.length - right; if (end <= left) continue;
      if (net.isIP(base.slice(left, end)) === 6) return base.slice(0, left) + mask() + base.slice(end);
    }
    return candidate;
  });
  value = value.replace(/(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])/g, candidate => net.isIP(candidate) === 4 ? mask() : candidate);
  return { text: value, redactions: count, reviewRequired: true, completeDetection: false };
}
module.exports = { LIMITS, fail, validateProfile, validateCredentials, inspectCommand, redactSecrets };

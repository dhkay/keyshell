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

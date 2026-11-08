 'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { redactSecrets, inspectCommand } = require('../src/main/policy.cjs');
const { SensitiveValues } = require('../src/main/sensitive-values.cjs');
test('other IPv4 and IPv6 addresses remain usable as server diagnostic data', () => {
  for (const ip of ['192.0.2.10', '10.0.0.1', '127.0.0.1', '::1', '::', '2001:db8::12', 'fe80::abcd%eth0', '::ffff:192.0.2.1']) {
    for (const text of [ip, '[' + ip + ']:22', 'root@' + ip, JSON.stringify({ host: ip }), ip + '/64']) assert.ok(redactSecrets(text).text.includes(ip), text);
  }
  assert.equal(redactSecrets('PHP 8.5.12 nginx/1.28.1 HTTP 200').text, 'PHP 8.5.12 nginx/1.28.1 HTTP 200');
});
test('secret labels, nested logs, auth headers, keys and database URLs are masked', () => {
  const cases = [
    ['MYSQL_ROOT_PASSWORD="a tricky value"', 'a tricky value'],
    [JSON.stringify({ output: 'password=LOG_VALUE', detail: { api_key: 'API_VALUE' } }), 'LOG_VALUE', 'API_VALUE'],
    ['비밀번호: 한글비밀 API 키=API_VALUE', '한글비밀', 'API_VALUE'],
    ['Authorization: Bearer HEADER_VALUE\nCookie: session=COOKIE_VALUE', 'HEADER_VALUE', 'COOKIE_VALUE'],
    ['postgres://user:DB_VALUE@192.0.2.1/db', 'DB_VALUE'],
    ['mysql -h localhost -pCLI_VALUE', 'CLI_VALUE'],
    ['client --api-key CLI_KEY_VALUE', 'CLI_KEY_VALUE'],
    ['sshpass -p SSH_VALUE ssh host', 'SSH_VALUE'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nKEY_MATERIAL\n-----END OPENSSH PRIVATE KEY-----', 'KEY_MATERIAL'],
    ['sk-proj-12345678901234567890 ghp_12345678901234567890', '12345678901234567890'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.ABCDEFGHIJKLMNOP', 'eyJzdWIiOiJzZWNyZXQifQ']
  ];
  for (const [input, ...secrets] of cases) { const result = redactSecrets(input); for (const secret of secrets) assert.ok(!result.text.includes(secret), input); assert.ok(result.redactions > 0); }
});
test('known credentials mask unlabeled/escaped/encoded copies and retain only comparison digests', () => {
  const registry = new SensitiveValues(); const secret = 'p@ss "한글"\\192.0.2.1';
  assert.equal(registry.add(secret), true); assert.equal(registry.add(secret), false);
  for (const variant of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), encodeURIComponent(secret).replace(/%[A-F0-9]{2}/g, s => s.toLowerCase())]) {
    assert.equal(registry.redact('before ' + variant + ' after').text, 'before **** after');
  }
  assert.ok(!JSON.stringify([...registry.groups]).includes(secret));
  registry.add('abc'); registry.add('bcde'); assert.equal(registry.redact('xabcdey').text, 'x****y');
  const key = registry.key; registry.dispose(); assert.equal(registry.groups.size, 0); assert.ok(key.every(b => b === 0));
});
test('masked values cannot become shell wildcards through AI command execution', () => {
  for (const command of ['curl http://****/', 'rm ****', 'export PASSWORD=****']) assert.ok(inspectCommand(command).reasons.includes('redacted-placeholder'));
});

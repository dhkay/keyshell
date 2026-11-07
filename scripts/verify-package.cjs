'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
async function verify() {
  const directory = process.argv[2] || 'release-dev';
  const archives = fs.readdirSync(directory, { recursive: true }).filter(f => f.endsWith('app.asar'));
  assert.ok(archives.length, 'No application archives found');
  for (const relative of archives) {
    // asar returns native separators, including backslashes on Windows.
    const file = path.join(directory, relative), list = asar.listPackage(file).map(entry => entry.replace(/\\/g, '/'));
    const forbidden = list.filter(f => /^\/(?:docs|tests|\.design|_bmad|scripts|\.github)\//.test(f) || f.includes('test-fixture'));
    assert.deepEqual(forbidden, [], 'Local development files in package');
    for (const required of ['/LICENSE', '/dist/index.html', '/dist/app.js', '/dist/app.css', '/dist/assets/icons.svg', '/dist/assets/cutout-5-dd315ab85ca4.png', '/dist/assets/cutout-88-adea854f6b8d.png', '/dist/assets/cutout-12-6801dd29f9e9.png', '/dist/assets/crop-11-d0b5cbc314dd.png', '/dist/assets/cutout-93-eb28c1dfa39f.png', '/dist/assets/cutout-75-0f627583a1f0.png', '/dist/assets/cutout-65-3d8bfb66c2ce.png', '/dist/assets/cutout-73-7e67beedf9f2.png', '/dist/assets/cutout-77-341000b4a2b3.png', '/src/main/main.cjs', '/src/main/preload.cjs', '/src/main/ipc.cjs', '/src/main/auto-advice.cjs', '/src/main/shared-terminal.cjs', '/src/main/sensitive-values.cjs']) assert.ok(list.includes(required), `Missing ${required}`);
    const pkg = JSON.parse(asar.extractFile(file, 'package.json').toString());
    if (directory.includes('release-dev')) assert.equal(pkg.keyshellSignedRelease, false);
    console.log(`${relative}: ${list.length} entries; required assets present; no local docs/tests/design/fixtures`);
    const resources = path.dirname(file), appDirectory = path.dirname(resources);
    const executable = process.platform === 'win32' ? path.join(appDirectory, `${directory.includes('release-dev') ? 'KeyShell Development' : 'KeyShell'}.exe`) : process.platform === 'darwin' ? path.join(appDirectory, 'MacOS', directory.includes('release-dev') ? 'KeyShell Development' : 'KeyShell') : path.join(appDirectory, 'keyshell');
    const wire = await getCurrentFuseWire(executable);
    for (const name of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) assert.equal(wire[FuseV1Options[name]], 48, `${name} must be disabled`);
    assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], 49);
    if (process.platform !== 'linux') assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], 49);
    console.log('Electron security fuses verified');
  }
}
verify().catch(error => { console.error(error.message); process.exitCode = 1; });

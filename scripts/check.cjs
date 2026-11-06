'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
for (const directory of ['src', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(directory, { recursive: true }).filter(f => /\.(cjs|js)$/.test(f))) {
    const result = spawnSync(process.execPath, file.endsWith('.js') ? ['--input-type=module', '--check'] : ['--check', path.join(directory, file)], file.endsWith('.js') ? { input: fs.readFileSync(path.join(directory, file)), stdio: ['pipe', 'inherit', 'inherit'] } : { stdio: 'inherit' }); if (result.status) process.exit(result.status || 1);
  }
}

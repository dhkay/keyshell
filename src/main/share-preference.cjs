'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('./policy.cjs');

class SharePreference {
  constructor(userDataPath) {
    if (!path.isAbsolute(userDataPath || '')) fail('E-PREFERENCE-PATH');
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    this.file = path.join(userDataPath, 'terminal-sharing.json');
  }
  get() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return false;
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return value.version === 1 && value.enabled === true && Object.keys(value).sort().join(',') === 'enabled,version';
    } catch (error) { return error.code === 'ENOENT'; }
  }
  set(enabled) {
    if (typeof enabled !== 'boolean') fail('E-PREFERENCE-INPUT');
    const temp = path.join(path.dirname(this.file), `${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, enabled })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
      return enabled;
    } catch { fail('E-PREFERENCE-WRITE'); }
    finally { fs.rmSync(temp, { force: true }); }
  }
}
module.exports = { SharePreference };

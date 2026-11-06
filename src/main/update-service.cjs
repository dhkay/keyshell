'use strict';
const { EventEmitter } = require('node:events');
const { fail } = require('./policy.cjs');
function repository(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(p => p === '.' || p === '..')) fail('E-RELEASE-REPOSITORY'); return value.split('/'); }
class UpdateService extends EventEmitter {
  constructor({ app, updater, confirmClose, platform = process.platform, releaseInfo }) {
    super(); this.app = app; this.updater = updater; this.confirmClose = confirmClose; this.platform = platform; this.releaseInfo = releaseInfo || require('../../package.json');
    this.state = { status: 'idle', current: app.getVersion(), development: !app.isPackaged };
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    updater.logger = null;
    updater.on('error', () => this.change({ status: 'failed', error: 'E-UPDATE-VERIFY-OR-NETWORK' }));
    updater.on('update-available', info => this.change({ status: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : JSON.stringify(info.releaseNotes || []) }));
    updater.on('update-not-available', () => this.change({ status: 'current' }));
    updater.on('download-progress', p => this.change({ status: 'downloading', percent: Math.floor(p.percent) }));
    updater.on('update-downloaded', info => this.change({ status: 'downloaded', version: info.version }));
  }
  change(value) { const keepRelease = ['downloading', 'downloaded', 'failed'].includes(value.status); this.state = { current: this.state.current, development: this.state.development, ...(keepRelease ? { version: this.state.version, notes: this.state.notes } : {}), ...value }; this.emit('update', this.state); }
  gate() { const pkg = this.releaseInfo; if (!this.app.isPackaged || pkg.keyshellSignedRelease !== true || !['win32', 'darwin'].includes(this.platform)) fail('E-UPDATE-DEVELOPMENT-BUILD'); repository(pkg.keyshellReleaseRepository); }
  async check() { this.gate(); if (['downloaded', 'downloading'].includes(this.state.status)) return this.state; this.change({ status: 'checking' }); try { await this.updater.checkForUpdates(); } catch { this.change({ status: 'failed', error: 'E-UPDATE-VERIFY-OR-NETWORK' }); } return this.state; }
  async download() { this.gate(); if (this.state.status !== 'available') fail('E-UPDATE-STATE'); await this.updater.downloadUpdate(); return this.state; }
  async install() { this.gate(); if (this.state.status !== 'downloaded') fail('E-UPDATE-STATE'); if (!(await this.confirmClose())) return { cancelled: true }; this.updater.quitAndInstall(false, true); return { installing: true }; }
}
module.exports = { UpdateService, repository };

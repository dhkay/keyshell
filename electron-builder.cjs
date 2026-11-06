'use strict';
const { repository } = require('./src/main/update-service.cjs');
const release = process.env.KEYSHELL_SIGNED_RELEASE === '1';
const slug = process.env.KEYSHELL_RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY;
let publish = null;
if (release) {
  const [owner, repo] = repository(slug); publish = { provider: 'github', owner, repo, releaseType: 'release' };
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Signed releases require a native Windows or macOS runner');
  if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) throw new Error('Signing certificate is required');
  if (process.platform === 'win32' && !process.env.KEYSHELL_WINDOWS_PUBLISHER) throw new Error('Expected Windows signing publisher is required');
  if (process.platform === 'darwin' && (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID)) throw new Error('Apple notarization credentials are required');
}
module.exports = {
  appId: 'org.keyshell.desktop', productName: release ? 'KeyShell' : 'KeyShell Development',
  directories: { output: release ? 'release' : 'release-dev' },
  files: ['LICENSE', 'dist/**/*', 'src/main/**/*.cjs', '!src/main/test-fixture.cjs', 'package.json', '!docs/**/*', '!tests/**/*', '!.design/**/*', '!_bmad/**/*'],
  asar: true, npmRebuild: true, forceCodeSigning: release,
  extraMetadata: { keyshellSignedRelease: release, keyshellReleaseRepository: release ? slug : null },
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: process.platform !== 'linux' },
  publish,
  win: { target: [{ target: 'nsis', arch: ['x64', 'arm64'] }], signAndEditExecutable: true, verifyUpdateCodeSignature: true, signtoolOptions: { publisherName: process.env.KEYSHELL_WINDOWS_PUBLISHER || 'UNCONFIGURED DEVELOPMENT BUILD' } },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  mac: { target: [{ target: 'dmg', arch: ['x64', 'arm64'] }, { target: 'zip', arch: ['x64', 'arm64'] }], minimumSystemVersion: '13.0', hardenedRuntime: true, notarize: release, category: 'public.app-category.developer-tools', identity: release ? undefined : null },
  linux: { target: ['dir'] }
};

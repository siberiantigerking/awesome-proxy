/**
 * electron-builder afterPack hook: embed our icon and version metadata into
 * the packaged .exe.
 *
 * WHY THIS EXISTS
 * ---------------
 * `build.win.signAndEditExecutable` is set to `false` because electron-builder
 * otherwise downloads its `winCodeSign` bundle, which contains macOS symlinks
 * (libcrypto.dylib / libssl.dylib). Extracting symlinks on Windows requires
 * SeCreateSymbolicLinkPrivilege, so on a normal user account the extraction
 * fails and the whole build aborts.
 *
 * The catch is that the same flag also disables the executable-editing step
 * (rcedit) — which is what stamps the icon and version info into the exe. With
 * it off, the built app kept Electron's own icon and identified itself as
 * "Electron / GitHub, Inc.", so Windows drew the Electron logo on the desktop
 * shortcut (the shortcut just inherits the target exe's icon).
 *
 * So we do that one step ourselves here with the standalone `rcedit` binary
 * (maintained by the Electron org). Note we deliberately do NOT use
 * app-builder's own `rcedit` subcommand: it shells out to `7za` and expects the
 * winCodeSign bundle, landing us right back on the problem above.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  // Windows only — nothing to stamp on other platforms.
  if (context.electronPlatformName !== 'win32') return;

  const projectRoot = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(projectRoot, 'resources', 'icon.ico');

  if (!fs.existsSync(exePath)) {
    throw new Error(`afterPack: packaged exe not found at ${exePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`afterPack: icon not found at ${iconPath}`);
  }

  const rcedit = path.join(projectRoot, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  if (!fs.existsSync(rcedit)) {
    throw new Error(`afterPack: rcedit-x64.exe not found at ${rcedit}`);
  }

  const args = [
    exePath,
    '--set-icon', iconPath,
    '--set-file-version', pkg.version,
    '--set-product-version', pkg.version,
    '--set-version-string', 'FileDescription', 'Awesome Proxy',
    '--set-version-string', 'ProductName', 'Awesome Proxy',
    '--set-version-string', 'CompanyName', pkg.author || 'Awesome Proxy',
    '--set-version-string', 'LegalCopyright', `Copyright (c) ${new Date().getFullYear()} ${pkg.author || 'Awesome Proxy'}`,
    '--set-version-string', 'InternalName', 'Awesome Proxy',
    '--set-version-string', 'OriginalFilename', exeName,
  ];

  execFileSync(rcedit, args, { stdio: 'inherit' });

  console.log(`  • afterPack: embedded icon + v${pkg.version} metadata into ${exeName}`);
};

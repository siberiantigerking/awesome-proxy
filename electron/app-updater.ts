/**
 * In-app updates of Awesome Proxy itself: electron-updater against this
 * repository's GitHub Releases (the `build.publish` block in package.json,
 * which electron-builder bakes into resources/app-update.yml).
 *
 * Not to be confused with:
 *   - the sing-box core upgrade (upgradeSingboxCore() in main.ts), which only
 *     swaps the core binary, and
 *   - src/services/auto-update.ts, the subscription refresh scheduler.
 *
 * Main owns everything that matters for safety: where updates come from, how
 * the requests are routed, and when the installer runs. The renderer can only
 * ask to check / download / install / open the releases page, and passes no
 * URLs or paths at all.
 */
import fs from 'fs';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import type { AppUpdater, CancellationToken, ProgressInfo, UpdateInfo } from 'electron-updater';
import {
  compareAppVersions,
  describeUpdateError,
  firstLine,
  missingMetadataReleaseTag,
  releaseNotesToText,
  type AppUpdateErrorKind,
  type UpdatePhase,
} from './app-updater-format';

type ElectronUpdaterModule = typeof import('electron-updater');

// ==================== Status (shared shape with the renderer) ====================
// Mirrors src/types/index.ts; the renderer can't import from electron/ (separate tsconfig).

export type AppUpdateState =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface AppUpdateStatus {
  state: AppUpdateState;
  /** app.getVersion() */
  currentVersion: string;
  /** Set while available / downloading / downloaded / installing. */
  version?: string;
  /** ISO date from latest.yml. */
  releaseDate?: string;
  /** PLAIN TEXT (HTML stripped here in main); render as text only. */
  releaseNotes?: string;
  /** Installer size in bytes, when latest.yml states it. */
  size?: number;
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number };
  error?: { kind: AppUpdateErrorKind; message: string };
}

export interface AppUpdaterDeps {
  getWindow: () => BrowserWindow | null;
  /** Mixed-inbound port of the running core, or null when it isn't running. */
  getProxyPort: () => number | null;
  /** main.ts runQuitCleanup(): stop the core, clear the system proxy. Idempotent. */
  prepareForQuit: () => Promise<void>;
  /**
   * main.ts resetQuitCleanup(): the install didn't go ahead and the app stays
   * open (already disconnected), so a later quit must clean up again. Only
   * called while the app really stays: before quitAndInstall(), or when
   * quitAndInstall() refused synchronously. Once it has spawned the installer,
   * electron-updater has already queued app.quit(), and the app closes even if
   * the launch fails.
   */
  cancelQuitPreparation: () => void;
  /**
   * main.ts: a core is running, starting, or about to be restarted by the
   * watchdog (D21). Checked right before the installer starts: such a core
   * would outlive the quit and keep resources\bin\sing-box.exe locked.
   */
  isCoreActive: () => boolean;
  /** App log (Logs page). */
  log: (line: string) => void;
}

// Hard-coded on purpose: the renderer can open "the releases page", never a URL of its choosing.
const RELEASES_URL = 'https://github.com/siberiantigerking/awesome-proxy/releases';

// The session electron-updater makes every request through. Must equal
// NET_SESSION_NAME in electron-updater 6.1.9 (out/electronHttpExecutor.js:
// session.fromPartition("electron-updater", { cache: false })), with the same
// options, so the proxy set here is the one its requests actually use.
const UPDATER_PARTITION = 'electron-updater';

// Electron `net` requests made by electron-updater get no timeout of their own:
// builder-util-runtime arms its timeout on Node's `socket` event, which
// Electron's ClientRequest never emits. So the app bounds them itself.
// A check is three sequential GitHub requests, and a Windows TCP connect
// timeout alone is ~21 s, hence the generous budget.
const CHECK_TIMEOUT_MS = 45 * 1000;
// A download is cancelled when no progress event arrives for this long.
const DOWNLOAD_STALL_MS = 60 * 1000;

type ReleaseFields = Pick<AppUpdateStatus, 'version' | 'releaseDate' | 'releaseNotes' | 'size'>;

let deps: AppUpdaterDeps | null = null;
let updater: AppUpdater | null = null;
let updaterModule: ElectronUpdaterModule | null = null;
let status: AppUpdateStatus = { state: 'idle', currentVersion: '' };
let latestInfo: UpdateInfo | null = null;
let latestFields: ReleaseFields = {};
/** True while the current check was started by the startup timer rather than a click. */
let backgroundCheck = false;
/** Port the latest check/download was routed through (for error messages). */
let activeProxyPort: number | null = null;
let lastRouteKey: string | null = null;
let downloadToken: CancellationToken | null = null;
let downloadStalled = false;
let stallTimer: NodeJS.Timeout | null = null;
let installing = false;
/** Set once quitAndInstall() has been called, i.e. the installer is being spawned. */
let installerStarted = false;
/**
 * The installer the latest download produced (update-downloaded's
 * downloadedFile). installUpdate() checks it still exists before tearing
 * anything down (D22): antivirus may quarantine it in the meantime.
 */
let downloadedFile: string | null = null;

function setStatus(next: Omit<AppUpdateStatus, 'currentVersion'>): AppUpdateStatus {
  status = { ...next, currentVersion: app.getVersion() };
  broadcast();
  return status;
}

function broadcast(): void {
  const win = deps?.getWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('app-updater:status', status);
  }
}

function releaseFields(info: UpdateInfo): ReleaseFields {
  const size = Array.isArray(info.files) ? info.files[0]?.size : undefined;
  return {
    version: info.version,
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
    releaseNotes: releaseNotesToText(info.releaseNotes) || undefined,
    size: typeof size === 'number' && size > 0 ? size : undefined,
  };
}

function rememberRelease(info: UpdateInfo): void {
  latestInfo = info;
  latestFields = releaseFields(info);
}

/**
 * The state as of now. Read through a function after an await: event handlers
 * change `status` meanwhile, which TypeScript's narrowing can't see.
 */
function currentState(): AppUpdateState {
  return status.state;
}

/** A check result must never overwrite a download in progress, done, or being installed. */
function isPastCheck(): boolean {
  return status.state === 'downloading' || status.state === 'downloaded' || status.state === 'installing';
}

function getUpdater(): AppUpdater {
  if (updater) return updater;

  // Required lazily, and only from the packaged app: main.js loads this module
  // at startup, so a broken or missing updater must cost the update button,
  // not app startup.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod: ElectronUpdaterModule = require('electron-updater');
  const u = mod.autoUpdater;

  // Nothing happens without a click: no auto download, no install on quit.
  u.autoDownload = false;
  u.autoInstallOnAppQuit = false;
  u.allowPrerelease = false;
  u.allowDowngrade = false;
  // Only the full NSIS installer is published; this also silences 6.1.9's
  // per-download warning about web installers.
  u.disableWebInstaller = true;
  // Console only: electron-updater logs the expected "Cannot download
  // differentially, fallback to full download" at error level, which would
  // read as a failure on the Logs page. The app log gets short lines from here.
  u.logger = {
    info: (message?: unknown) => console.log('[updater]', message),
    warn: (message?: unknown) => console.warn('[updater]', message),
    error: (message?: unknown) => console.error('[updater]', message),
  };

  // Registered once, before any download: electron-updater only wires its
  // progress callback if a `download-progress` listener exists when a
  // download starts.
  u.on('update-available', (info) => {
    if (installing || isPastCheck()) return;
    rememberRelease(info);
    deps?.log(`Updater: v${info.version} is available (installed v${app.getVersion()}).`);
    setStatus({ state: 'available', ...latestFields });
  });

  u.on('update-not-available', () => {
    if (installing || isPastCheck()) return;
    deps?.log(`Updater: v${app.getVersion()} is the latest version.`);
    setStatus({ state: 'not-available' });
  });

  u.on('download-progress', (p: ProgressInfo) => {
    if (status.state !== 'downloading') return;
    armStallTimer();
    const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0);
    setStatus({
      state: 'downloading',
      ...latestFields,
      progress: {
        percent: Math.min(100, Math.round(num(p.percent))),
        bytesPerSecond: Math.round(num(p.bytesPerSecond)),
        transferred: num(p.transferred),
        total: num(p.total),
      },
    });
  });

  u.on('update-downloaded', (info) => {
    if (installing) return;
    clearStallTimer();
    if (typeof info.downloadedFile === 'string' && info.downloadedFile) downloadedFile = info.downloadedFile;
    rememberRelease(info);
    deps?.log(`Updater: v${info.version} downloaded and verified (sha512).`);
    setStatus({ state: 'downloaded', ...latestFields });
  });

  u.on('error', (err) => {
    console.error('[updater] error event:', err);
    // Check and download failures are handled where their promises reject, so
    // they aren't reported twice. Only the installer launch reports through
    // this event alone, because quitAndInstall() returns nothing. A refusal
    // inside quitAndInstall() (no valid downloaded update) arrives here before
    // it returns, with no quit queued, so the app stays open. A failed spawn
    // arrives after app.quit() was already queued, so the app closes anyway;
    // a missing file (ENOENT) falls back to shell.openPath and arrives nowhere.
    if (installing && installerStarted) handleInstallFailure(err);
  });

  updaterModule = mod;
  updater = u;
  return u;
}

function routeLabel(port: number | null): string {
  return port ? `via the local proxy (127.0.0.1:${port})` : 'directly (not connected)';
}

/**
 * Point the updater's own session at the running core, or direct when it isn't
 * running. Only the 'electron-updater' partition is touched; the default
 * session and the Windows system proxy are left alone. Never throws.
 */
async function routeUpdaterTraffic(): Promise<number | null> {
  const port = deps?.getProxyPort() ?? null;
  const key = port ? `proxy:${port}` : 'direct';
  try {
    const ses = session.fromPartition(UPDATER_PARTITION, { cache: false });
    // proxyRules alone implies mode 'fixed_servers'. The mixed inbound speaks
    // HTTP CONNECT, which is all an https request through it needs.
    await ses.setProxy(port ? { proxyRules: `http://127.0.0.1:${port}` } : { mode: 'direct' });
    // A pooled socket opened on the previous route would otherwise be reused.
    if (lastRouteKey !== null && lastRouteKey !== key) await ses.closeAllConnections();
    lastRouteKey = key;
  } catch (err) {
    console.error('[updater] could not set the update route:', err);
    deps?.log(`Updater: could not set the update route (${firstLine(err, 200)}).`);
  }
  return port;
}

function fail(phase: UpdatePhase, err: unknown): AppUpdateStatus {
  if (phase === 'check') {
    // D23: the latest release has no latest.yml, but it isn't newer than this
    // install (on the first updater-capable version, GitHub's latest release is
    // the one installed, or an older one). That is "up to date", for the quiet
    // startup check too; only a newer release keeps the no-metadata message.
    const tag = missingMetadataReleaseTag(err);
    if (tag && compareAppVersions(tag, app.getVersion()) <= 0) {
      deps?.log(
        `Updater: the latest release (${tag}) has no update metadata and isn't newer than v${app.getVersion()}; in-app updates start with the next release.`
      );
      return setStatus({ state: 'not-available' });
    }
  }
  const error = describeUpdateError(err, {
    phase,
    proxyPort: phase === 'install' ? null : activeProxyPort,
  });
  console.error(`[updater] ${phase} failed:`, err);
  deps?.log(`Updater: ${phase} failed: ${firstLine(err, 300)}`);
  // Nobody asked for the startup check, so its failure (e.g. GitHub blocked
  // before connecting, or a release without latest.yml) isn't shown as an error.
  if (phase === 'check' && backgroundCheck) return setStatus({ state: 'idle' });
  return setStatus({ state: 'error', error });
}

/** An Error carrying one of the APP_UPDATER_* codes describeUpdateError() maps; the same shape timeoutAfter() builds. */
function codeErr(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function timeoutAfter(ms: number, code: string, message: string): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code })), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function armStallTimer(): void {
  clearStallTimer();
  stallTimer = setTimeout(() => {
    downloadStalled = true;
    downloadToken?.cancel();
  }, DOWNLOAD_STALL_MS);
}

function clearStallTimer(): void {
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

async function checkForUpdates(background: boolean): Promise<AppUpdateStatus> {
  if (!app.isPackaged) return setStatus({ state: 'unsupported' });
  if (status.state === 'checking') {
    // A click during the quiet startup check makes that check report normally.
    if (!background) backgroundCheck = false;
    return status;
  }
  if (isPastCheck() || (background && status.state !== 'idle')) {
    // Nothing to check: a download is underway or done, or the user already
    // checked by hand and the quiet startup check would only repeat (or, on a
    // network blip, erase) that result. Re-sending also resyncs a renderer
    // that was reloaded.
    broadcast();
    return status;
  }

  backgroundCheck = background;
  setStatus({ state: 'checking' });

  let u: AppUpdater;
  try {
    u = getUpdater();
  } catch (err) {
    return fail('check', err);
  }

  activeProxyPort = await routeUpdaterTraffic();
  deps?.log(`Updater: checking for updates ${routeLabel(activeProxyPort)}.`);

  const timeout = timeoutAfter(CHECK_TIMEOUT_MS, 'APP_UPDATER_TIMEOUT', 'The update check timed out');
  try {
    const pending = u.checkForUpdates();
    // If our timeout wins, the check may still reject later; that must not
    // become an unhandled rejection. Its events are still applied: they are
    // real results.
    pending.catch(() => {});
    await Promise.race([pending, timeout.promise]);
    // Resolved without an availability event: the updater was inactive.
    if (currentState() === 'checking') setStatus({ state: 'idle' });
  } catch (err) {
    if (currentState() === 'checking') fail('check', err);
  } finally {
    timeout.cancel();
  }
  return status;
}

async function downloadUpdate(): Promise<AppUpdateStatus> {
  if (!app.isPackaged) return setStatus({ state: 'unsupported' });
  if (status.state !== 'available' || !latestInfo || !updater || !updaterModule) return status;
  const u = updater;
  const version = latestInfo.version;

  // Switch state before the first await, so a second click can't start a
  // second download (electron-updater doesn't dedupe them).
  setStatus({
    state: 'downloading',
    ...latestFields,
    progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: latestFields.size ?? 0 },
  });
  // An earlier download's file says nothing about this one.
  downloadedFile = null;

  activeProxyPort = await routeUpdaterTraffic();
  deps?.log(`Updater: downloading v${version} ${routeLabel(activeProxyPort)}.`);

  const token = new updaterModule.CancellationToken();
  downloadToken = token;
  downloadStalled = false;
  armStallTimer();
  try {
    const files = await u.downloadUpdate(token);
    // update-downloaded normally named the installer already; if it didn't,
    // the first path the download resolved with is the installer.
    if (!downloadedFile && Array.isArray(files) && typeof files[0] === 'string' && files[0]) {
      downloadedFile = files[0];
    }
    // update-downloaded normally got here first; don't leave a dead-end state if it didn't.
    if (currentState() === 'downloading') setStatus({ state: 'downloaded', ...latestFields });
  } catch (err) {
    fail(
      'download',
      downloadStalled ? Object.assign(new Error('The download stalled'), { code: 'APP_UPDATER_STALLED' }) : err
    );
  } finally {
    clearStallTimer();
    downloadToken = null;
  }
  return status;
}

/**
 * The installer launch failed. This keeps the app usable only when
 * quitAndInstall() failed synchronously (it refused or threw): no quit is
 * queued, so the app stays open, already disconnected, and the install message
 * says so. A spawn error arrives here too, but by then electron-updater has
 * queued app.quit(), so the app closes regardless.
 */
function handleInstallFailure(err: unknown): void {
  installing = false;
  installerStarted = false;
  deps?.cancelQuitPreparation();
  fail('install', err);
}

/** The installer the latest download produced is still on disk. */
function installerOnDisk(): boolean {
  return downloadedFile !== null && fs.existsSync(downloadedFile);
}

async function installUpdate(): Promise<AppUpdateStatus> {
  if (!app.isPackaged) return setStatus({ state: 'unsupported' });
  if (status.state !== 'downloaded' || installing || !updater || !deps) return status;
  const u = updater;

  // D22: check before anything is torn down. Once quitAndInstall() runs, a
  // missing installer only closes the app (see below), so this is the last
  // point where the app can say so and stay running and connected.
  if (!installerOnDisk()) {
    deps.log(
      `Updater: the downloaded installer is no longer on disk (${downloadedFile ?? 'no file recorded'}); nothing was disconnected.`
    );
    return setStatus({
      state: 'error',
      error: describeUpdateError(codeErr('APP_UPDATER_INSTALLER_MISSING'), { phase: 'install', proxyPort: null }),
    });
  }

  installing = true;
  setStatus({ state: 'installing', ...latestFields });
  deps.log(`Updater: installing v${latestFields.version ?? '?'}; disconnecting first.`);

  try {
    // Must finish BEFORE the installer starts. Launched with --updated, the
    // installer taskkills a still-running app after ~1.3 s and never waits for
    // its cleanup; a live sing-box would keep resources\bin\sing-box.exe locked
    // and leave the TUN routes/WFP filters and the system proxy behind. This is
    // the same cleanup a normal quit runs (before-quit), not a copy of it.
    await deps.prepareForQuit();
  } catch (err) {
    installing = false;
    deps.cancelQuitPreparation();
    return fail('install', err);
  }

  // D21: the last moment the install can be called off with the app open. A
  // core that came back during the disconnect (a start already under way when
  // the install began) would outlive the quit and keep resources\bin\sing-box.exe
  // locked, so the silent installer couldn't replace it. An installer removed
  // meanwhile would just close the app.
  const coreActive = deps.isCoreActive();
  if (coreActive || !installerOnDisk()) {
    installing = false;
    deps.cancelQuitPreparation();
    return fail(
      'install',
      coreActive
        ? codeErr('APP_UPDATER_CORE_ACTIVE', 'sing-box was started while the update was being prepared')
        : // Not APP_UPDATER_INSTALLER_MISSING: the proxy is disconnected by now,
          // which only the default install message says.
          codeErr('APP_UPDATER_INSTALLER_GONE', 'the downloaded installer disappeared while disconnecting')
    );
  }

  try {
    installerStarted = true;
    // Spawns the installer (/S --updated --force-run, detached) and queues
    // app.quit() for the next tick without waiting to see whether the spawn
    // worked; before-quit lets that quit through because the cleanup above
    // already ran. So from here on a failed launch leaves the app CLOSED and
    // not updated: a spawn error reaches 'error' only after the quit was
    // queued, and a missing file (ENOENT) falls back to shell.openPath, which
    // emits no error at all. Only a synchronous refusal (no valid downloaded
    // update) keeps the app open, already disconnected (handleInstallFailure).
    u.quitAndInstall(true, true);
  } catch (err) {
    handleInstallFailure(err);
  }
  return status;
}

async function openReleasesPage(): Promise<void> {
  try {
    await shell.openExternal(RELEASES_URL);
  } catch (err) {
    console.error('[updater] could not open the releases page:', err);
    deps?.log(`Updater: could not open the releases page (${firstLine(err, 200)}).`);
  }
}

/**
 * True from the moment an install starts until it is called off. main.ts reads
 * it so nothing starts a core during the install's disconnect: not the
 * watchdog (D18), not startSingbox() and not tray Connect (D21).
 */
export function isUpdateInstalling(): boolean {
  return installing;
}

/** The only option the renderer may pass; anything else is ignored. */
function isBackgroundRequest(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { background?: unknown }).background === true
  );
}

/**
 * Register the updater IPC handlers. Call once, after app ready and before the
 * window loads. Has no effect when called again (ipcMain.handle can only
 * register a channel once).
 */
export function initAppUpdater(d: AppUpdaterDeps): void {
  if (deps) return;
  deps = d;
  status = { state: 'idle', currentVersion: app.getVersion() };

  ipcMain.handle('app-updater:check', (_event, options: unknown) =>
    checkForUpdates(isBackgroundRequest(options))
  );
  ipcMain.handle('app-updater:download', () => downloadUpdate());
  ipcMain.handle('app-updater:install', () => installUpdate());
  ipcMain.handle('app-updater:open-releases', () => openReleasesPage());
}

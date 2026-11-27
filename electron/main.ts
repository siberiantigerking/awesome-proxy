import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec, execFile, spawn, ChildProcess } from 'child_process';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
// In-app app updates live in their own module; main only lends it the core's port and the quit cleanup.
import { initAppUpdater, isUpdateInstalling } from './app-updater';
// Restart policy for a core that stops on its own (audit P1-5); pure, so plain Node can test it.
import { planWatchdogRestart, WATCHDOG_DELAYS_MS } from './core-watchdog';
// Where the window may navigate and which links may open outside (audit P0-5); pure as well.
import { isAppUrl, isSafeExternalUrl } from './navigation';
// The core upgrade's Electron-free half (audit P0-6): release lookup and the
// validated-version ceiling, the SHA-256-checked download, the new binary's
// checks, and the swap that keeps the previous core.
import {
  MAX_VALIDATED_CORE,
  parseCoreRelease,
  fetchJson,
  downloadVerified,
  extractZip,
  findFileRecursive,
  readCoreVersion,
  checkConfigWithCore,
  swapCoreBinary,
  restoreCoreBackup,
} from './core-upgrade';
import type { CoreRelease } from './core-upgrade';
// Shared single-source-of-truth config generator (CommonJS module).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  generateSingboxConfig,
  nodeRejectionReason,
  nodeInactiveReason,
  buildOutboundTags,
  TUN_IPV4_PREFIX,
} = require('../shared/config-generator.cjs');
// Node test probes (tcp ping / real delay / UDP / speed), shared with the web
// backend so both report identical numbers.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tcpPing, clashDelay, udpProbe, speedProbe } = require('../shared/node-probes.cjs');
// sing-box version probe (cached, de-duplicated, never caches a failure),
// shared with the web backend.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCoreVersionProbe } = require('../shared/core-version.cjs');
// The one Clash API client (audit P0-1): per-start loopback port + secret,
// injected into the config right before each spawn, Bearer auth on every call.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  createClashApiCredentials,
  writeConfigWithClashApi,
  isControllerListenError,
  clashSelect,
  clashSelection,
  clashConnectionTotals,
} = require('../shared/clash-client.cjs');
// Crash-safe Windows system proxy (audit P0-2): snapshot before enable,
// restore only what we set, recover after an unclean exit. Shared with the
// web backend.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSystemProxy } = require('../shared/system-proxy.cjs');

// One running app per user (audit P0-7, D14). A second launch only wakes the
// running instance (its 'second-instance' event shows the window) and quits.
// It registers no lifecycle handlers at all (see the bottom of this file):
// its quit would otherwise run the quit cleanup, which restores the system
// proxy and would switch off the proxy the first instance is serving.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

// Dynamic import for electron-store (ESM module in CommonJS context)
let store: any = null;

async function getStore() {
  if (!store) {
    const Store = (await import('electron-store')).default;
    store = new Store({
      defaults: {
        nodes: [],
        selectedIndex: -1,
        subscriptions: [],
        settings: {
          socksPort: 1080,
          httpPort: 8080,
          mixedPort: 7890,
          proxyMode: 'system', // 'system' | 'tun' | 'manual'
          // The renderer's defaults (src/services/dns-servers.ts); see SETTINGS_VERSION 6 in settingsStore.ts.
          remoteDns: 'https://1.1.1.1/dns-query',
          directDns: 'https://223.5.5.5/dns-query',
          bypassChina: true,
          logLevel: 'info',
          autoStart: false,
          startMinimized: false,
          theme: 'dark',
        },
      },
    });
  }
  return store;
}

/**
 * Main-owned state in its own file (main-state.json in userData), out of the
 * renderer's reach: the generic store:* IPC only reaches the default store, so
 * a compromised renderer can't forge, say, a system proxy snapshot that main
 * would later write into the registry (D10).
 */
let mainState: any = null;

async function getMainState() {
  if (!mainState) {
    const Store = (await import('electron-store')).default;
    mainState = new Store({ name: 'main-state' });
  }
  return mainState;
}

/** The ownership marker lives in main-state; enable() refuses if it can't be saved. */
const systemProxyMarkerStore = {
  get: () => (mainState ? mainState.get('systemProxyOwnership') ?? null : null),
  set: (marker: unknown) => {
    if (!mainState) throw new Error('main state is not loaded yet');
    mainState.set('systemProxyOwnership', marker);
  },
  clear: () => {
    mainState?.delete('systemProxyOwnership');
  },
};

/**
 * True once the app is really going away, so a window close is a real close
 * instead of hiding to the tray (D15). Set by the first before-quit pass, by
 * runQuitCleanup() (which also covers the updater's install), by an accepted
 * elevation relaunch and by a Windows session end. resetQuitCleanup() clears
 * it again when an update install doesn't go ahead after all.
 */
let isQuitting = false;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let singboxProcess: ChildProcess | null = null;
let singboxLogs: string[] = [];
let isConnecting = false;

const LOG_MAX_LINES = 1000;

function getSingboxPath(): string {
  // In development, look in resources/bin
  // In production, look in extraResources
  const isDev = !app.isPackaged;
  if (isDev) {
    return path.join(process.cwd(), 'resources', 'bin', 'sing-box.exe');
  }
  return path.join(process.resourcesPath, 'bin', 'sing-box.exe');
}

function getCtrlBreakHelperPath(): string {
  const isDev = !app.isPackaged;
  if (isDev) {
    return path.join(process.cwd(), 'resources', 'bin', 'ctrlbreak.exe');
  }
  return path.join(process.resourcesPath, 'bin', 'ctrlbreak.exe');
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'sing-box-config.json');
}

/**
 * Open a link from the window in the default browser, if it is a plain https
 * link (D25). Everything else is dropped: shell.openExternal would hand it to
 * whatever program Windows registered for the protocol.
 */
function openExternalSafely(url: string): void {
  if (!isSafeExternalUrl(url)) {
    // Only the scheme: the rest of a blocked URL may carry credentials.
    let scheme = 'unreadable URL';
    try {
      scheme = new URL(url).protocol;
    } catch {
      /* keep the fallback */
    }
    addLog(`WARN: Blocked a link from the app window (${scheme}); only https links without credentials open in the browser.`);
    return;
  }
  shell.openExternal(url).catch((err: any) => {
    addLog(`WARN: Could not open ${url} in the browser: ${err?.message ?? err}`);
  });
}

function createWindow(): BrowserWindow {
  // A local, so the handlers below always talk about THIS window, even after
  // showMainWindow() has replaced mainWindow with a recreated one.
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
  });
  mainWindow = win;

  // The window only ever shows the app (D25). A page swapped in by injected
  // script would still have the preload bridge, so no new window ever opens,
  // and navigation is limited to the app's own URLs. Links pointing elsewhere
  // go to the default browser, https only.
  const navigationContext = {
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    distDir: path.join(__dirname, '..', 'dist'),
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  // event.url: the positional url argument is deprecated since Electron 25.
  win.webContents.on('will-navigate', (event) => {
    if (isAppUrl(event.url, navigationContext)) return;
    event.preventDefault();
    openExternalSafely(event.url);
  });

  // In development, load from Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // The app lives in the tray, so closing the window only hides it (D15). The
  // title-bar ✕ already hides through app:close; this catches Alt+F4 and the
  // taskbar's "Close window", which used to destroy the window and leave tray
  // "Show Window" with nothing to show. Only a real quit lets it close.
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    // A window recreated by showMainWindow() may already have taken over.
    if (mainWindow === win) mainWindow = null;
  });

  // Windows is logging off or shutting down: before-quit may never get to run
  // its async cleanup, so put the user's proxy settings back synchronously now.
  win.on('session-end', () => {
    isQuitting = true;
    systemProxy.restoreSync();
  });

  return win;
}

/**
 * Bring the window to the front: tray "Show Window", a tray double-click, a
 * second launch (second-instance) and activate. Recreates it when it is gone,
 * which can still happen after a close while isQuitting was set (for example
 * a Windows shutdown that was then cancelled).
 */
function showMainWindow(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The window, if it exists and its renderer can still receive messages. */
function getLiveWindow(): BrowserWindow | null {
  const win = mainWindow;
  return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win : null;
}

/**
 * Send to the renderer when there is one. These sends run from timers and
 * core exit handlers, possibly while the window is being torn down, and
 * webContents.send on a destroyed window or webContents throws ("Object has
 * been destroyed"). Without a window the message has no one to go to anyway:
 * a recreated renderer reads the current state when it starts.
 */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  getLiveWindow()?.webContents.send(channel, ...args);
}

type ProxyModeName = 'system' | 'tun' | 'split' | 'manual';

const MODE_LABELS: Record<ProxyModeName, string> = {
  system: 'System Proxy',
  tun: 'TUN',
  split: 'Split',
  manual: 'Manual',
};

/** Track the last-known proxy mode so tray updates (e.g. on connect) can
 * color the icon correctly without needing the renderer to pass it every
 * single time. Updated via the `tray:set-mode` IPC call from the renderer. */
let currentProxyMode: ProxyModeName = 'system';

function getTrayImage(connected: boolean): Electron.NativeImage {
  // When connected, tint the icon by proxy mode so the taskbar tray icon
  // color indicates which mode is active at a glance (system=blue, tun=red,
  // split=purple, manual=amber). Falls back to the plain logo when idle.
  const candidates = connected
    ? [
        path.join(__dirname, '..', 'resources', `icon-${currentProxyMode}.png`),
        path.join(__dirname, '..', 'resources', 'icon-active.png'),
      ]
    : [
        path.join(__dirname, '..', 'resources', 'icon.png'),
        path.join(__dirname, '..', 'resources', 'icon.jpg'),
      ];
  const iconPath = candidates.find((p) => fs.existsSync(p));
  const img = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function setTrayConnected(connected: boolean) {
  if (!tray) return;
  const img = getTrayImage(connected);
  if (!img.isEmpty()) tray.setImage(img);
  tray.setToolTip(
    connected ? `Awesome Proxy — Connected (${MODE_LABELS[currentProxyMode]})` : 'Awesome Proxy'
  );
}

/** True while sing-box is actually running (mirrors the status the renderer sees). */
let trayConnected = false;

/**
 * Build the tray context menu. Shared by createTray() (initial build) and
 * updateTrayMenu() (rebuilt on every connect/disconnect) so there's a single
 * source of truth for the menu layout — including the one-click connection
 * toggle item requested by the user: a single "Connect"/"Disconnect" entry
 * that flips label based on the current state instead of two always-visible,
 * mostly-disabled items.
 *
 * `reconnecting` is the watchdog's restart (D19): the core is down, but there
 * is still a connection the user may want to end, so the toggle offers
 * Disconnect.
 */
function buildTrayMenu(connected: boolean, reconnecting = false): Menu {
  const offersDisconnect = connected || reconnecting;
  // No new core while an update installs or the app quits (D21): it would
  // outlive the quit and keep sing-box.exe locked for the installer.
  // runQuitCleanup() rebuilds the menu, so this is current once either begins.
  const connectBlocked = isUpdateInstalling() || isQuitting;
  return Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: reconnecting
        ? '🟡 Reconnecting…'
        : connected
        ? `🟢 Connected (${MODE_LABELS[currentProxyMode]})`
        : '🔴 Disconnected',
      enabled: false,
    },
    {
      label: offersDisconnect ? 'Disconnect' : 'Connect',
      enabled: offersDisconnect || !connectBlocked,
      click: () => {
        if (offersDisconnect) {
          // Disconnecting needs nothing from the renderer, so main does it
          // itself (D16): the same steps as the renderer's disconnect(), but
          // it also works with no window. The renderer just receives the
          // 'disconnected' status like after any other stop.
          void disconnectCore();
          return;
        }
        // Re-checked: an open menu keeps the state it was built with.
        if (isUpdateInstalling() || isQuitting) return;
        // Connecting needs node selection, elevation handling, and Clash API
        // calls that live in the renderer's connection service, so the tray
        // asks the renderer to do it, the same way the Dashboard's Connect
        // button does. With no live renderer there is no one to ask: bring the
        // window up and let the user connect from there.
        if (getLiveWindow()) sendToRenderer('tray:connect');
        else showMainWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        // Cleanup (graceful sing-box stop, system proxy disable) happens in
        // the `before-quit` handler, which blocks the actual quit until done.
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const trayIcon = getTrayImage(false);
  tray = new Tray(trayIcon);
  tray.setToolTip('Awesome Proxy');
  tray.setContextMenu(buildTrayMenu(false));

  tray.on('double-click', () => showMainWindow());
}

/**
 * The watchdog has a restart pending (D19). The core is down, so the icon goes
 * back to idle; the menu says so and keeps Disconnect working. The next
 * updateTrayMenu(true|false) leaves this state.
 */
function setTrayReconnecting(): void {
  if (!tray) return;
  // Not connected right now: tray:set-mode must not rebuild the connected menu.
  trayConnected = false;
  setTrayConnected(false);
  tray.setToolTip('Awesome Proxy — Reconnecting…');
  tray.setContextMenu(buildTrayMenu(false, true));
}

// ==================== sing-box Management ====================

function addLog(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const logLine = `[${timestamp}] ${message}`;
  singboxLogs.push(logLine);
  if (singboxLogs.length > LOG_MAX_LINES) {
    singboxLogs = singboxLogs.slice(-LOG_MAX_LINES);
  }
  sendToRenderer('singbox:log', logLine);
}

/**
 * Mixed-inbound port of the config the running core was started with.
 *
 * The in-app updater sends its requests through the core (see app-updater.ts),
 * so it needs the port the core is actually listening on. The started config
 * file is the only source that matches the running core: settings.mixedPort can
 * be edited in Settings without reconnecting, so it may name a port nothing is
 * listening on yet.
 */
let runningMixedPort: number | null = null;

function readMixedPort(configPath: string): number | null {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const inbounds: any[] = Array.isArray(config?.inbounds) ? config.inbounds : [];
    const port = inbounds.find((inbound) => inbound && inbound.type === 'mixed')?.listen_port;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** The running core's mixed port; null while it is stopped or still starting. */
function getCoreProxyPort(): number | null {
  return singboxProcess && !isConnecting ? runningMixedPort : null;
}

/**
 * Clash API credentials of the running core (audit P0-1): a random loopback
 * port and a per-start secret, written into the config file right before each
 * spawn. Main process only — never sent to the renderer and never logged.
 * Cleared together with singboxProcess.
 */
let clashApi: { port: number; secret: string } | null = null;

/**
 * Set at the top of every stopSingbox() and cleared by startSingbox(), so a
 * start that is waiting to retry on another controller port can tell the user
 * (or a quit) asked for the core to be down in the meantime, and the watchdog
 * can tell an exit somebody asked for from a crash (shouldStayStopped()).
 */
let stopRequested = false;

type CoreStartResult = { success: boolean; error?: string };
type CoreAttemptResult = CoreStartResult & { controllerPortBusy?: boolean; port?: number };

// Same pause reconnect() uses for TUN teardown: long enough for whatever held
// the controller port to settle, short enough not to feel like a hang.
const CONTROLLER_RETRY_DELAY_MS = 800;

/**
 * Numbers the startSingbox() calls that got as far as setting isConnecting,
 * so a call's tail can tell whether a newer start has begun since (see
 * startId below).
 */
let coreStartSeq = 0;

async function startSingbox(configPath: string): Promise<CoreStartResult> {
  // First (D21): the updater is disconnecting to run the installer. A core
  // started now would outlive the quit and keep resources\bin\sing-box.exe
  // locked, so the silent installer couldn't replace it. Like the refusal
  // below, it comes before stopRequested is cleared: a refused start never
  // clears a pending stop.
  if (isUpdateInstalling()) {
    return { success: false, error: 'Awesome Proxy is installing an update and will restart in a moment.' };
  }
  // A core upgrade or restore is between its disconnect and the file swap
  // (D31): a core started now would run the old binary and lock the file.
  if (coreSwapInProgress) {
    return { success: false, error: 'The sing-box core is being replaced; connect again in a moment.' };
  }
  // isConnecting covers the async gaps below (credential allocation, the retry
  // pause) in which singboxProcess is still null, so a second start can't slip
  // in and spawn a second core. Before this function became async, the two
  // flags were always set together, so the refusal is the same as before.
  if (singboxProcess || isConnecting) {
    return { success: false, error: 'sing-box is already running' };
  }
  stopRequested = false;

  const singboxPath = getSingboxPath();

  if (!fs.existsSync(singboxPath)) {
    const errorMsg = `sing-box binary not found at: ${singboxPath}`;
    addLog(`ERROR: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  if (!fs.existsSync(configPath)) {
    const errorMsg = `Config file not found at: ${configPath}`;
    addLog(`ERROR: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  isConnecting = true;
  // This start's number. By the time this call's tail runs, a newer start can
  // already be under way. When a singbox:restart (a second node pick, say)
  // stops this start's core before it reported started, the core's exit
  // settles both this start and that stop in the same turn, and the
  // restart's continuation can run first and begin its own start
  // (isConnecting set again, no process yet while it fetches credentials).
  // Clearing the flag then would make singbox:status say 'disconnected' for
  // that start, so the renderer's status-checked disable() after the failed
  // first switch would restore the system proxy under a core about to run,
  // and a third start could slip past the "already running" refusal.
  const startId = ++coreStartSeq;
  let attempt = await attemptCoreStart(configPath);

  if (attempt.controllerPortBusy) {
    // The port was free when we picked it, but something grabbed it before
    // sing-box could bind. Pick a new port and secret and try exactly once more.
    addLog(`sing-box couldn't open its local control port (127.0.0.1:${attempt.port}); retrying on another port.`);
    await new Promise((resolve) => setTimeout(resolve, CONTROLLER_RETRY_DELAY_MS));
    // A stop, a quit or an update install that began during the pause wins.
    if (shouldStayStopped()) {
      isConnecting = false;
      sendToRenderer('singbox:status-change', 'disconnected');
      updateTrayMenu(false);
      return { success: false, error: 'Connecting was cancelled.' };
    }
    attempt = await attemptCoreStart(configPath);
    if (attempt.controllerPortBusy) {
      const errorMsg =
        `sing-box couldn't open its local control port (127.0.0.1:${attempt.port}) because another program is using it. ` +
        'Close that program and connect again.';
      addLog(`ERROR: ${errorMsg}`);
      isConnecting = false;
      sendToRenderer('singbox:status-change', 'disconnected');
      updateTrayMenu(false);
      return { success: false, error: errorMsg };
    }
  }

  // Every failure path has already reported itself; just make sure the flag
  // can't stay stuck (the config-prepare failure never spawned anything).
  // Only this start's own flag: a newer start owns it now (see startId).
  if (!attempt.success && !singboxProcess && startId === coreStartSeq) isConnecting = false;
  return attempt.success ? { success: true } : { success: false, error: attempt.error };
}

/**
 * One spawn of the core: fresh Clash API credentials into the config file,
 * then today's spawn / "started" / exit handling. Resolves
 * `{ controllerPortBusy, port }` instead of a plain failure when the core died
 * before starting because it couldn't bind the controller port, so
 * startSingbox can retry on another one.
 */
async function attemptCoreStart(configPath: string): Promise<CoreAttemptResult> {
  const singboxPath = getSingboxPath();

  let creds: { port: number; secret: string };
  try {
    creds = await createClashApiCredentials();
    // A stop, quit, update install or core swap under way by now wins, as it
    // does after the retry pause (D3). A stop that came while the port was
    // being picked found no process to end, so nothing else would keep this
    // core from starting. This is also how an explicit restart or reconnect
    // replaces a watchdog restart that was already starting.
    if (shouldStayStopped() || coreSwapInProgress) {
      isConnecting = false;
      sendToRenderer('singbox:status-change', 'disconnected');
      updateTrayMenu(false);
      return { success: false, error: 'Connecting was cancelled.' };
    }
    // The last write before the core reads the file: whatever clash_api the
    // renderer wrote (if any) is replaced here.
    writeConfigWithClashApi(configPath, creds);
  } catch (err: any) {
    const errorMsg = `Could not prepare the sing-box config: ${err.message}`;
    addLog(`ERROR: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  runningMixedPort = readMixedPort(configPath);
  clashApi = creds;
  addLog('Starting sing-box core...');

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(singboxPath, ['run', '-c', configPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      singboxProcess = child;
    } catch (err: any) {
      addLog(`ERROR: Failed to start sing-box - ${err.message}`);
      singboxProcess = null;
      clashApi = null;
      isConnecting = false;
      resolve({ success: false, error: err.message });
      return;
    }

    let started = false;
    let controllerPortBusy = false;
    let startupTimer: NodeJS.Timeout;
    const recentLines: string[] = [];
    const STARTED_RE = /sing-box started|server started/i;

    // Child guard: every handler below only touches global core state while
    // this child is still THE core. Otherwise a late exit from an earlier,
    // hard-killed core would clobber the next one and look like a crash. A
    // guarded-out handler still settles its own promise and timer.
    const isCurrent = () => singboxProcess === child;

    const markStarted = () => {
      if (started) return;
      started = true;
      isConnecting = false;
      sendToRenderer('singbox:status-change', 'connected');
      updateTrayMenu(true);
      resolve({ success: true });
      if (startupTimer) clearTimeout(startupTimer);
    };

    const handleLine = (line: string) => {
      addLog(line);
      recentLines.push(line);
      if (recentLines.length > 8) recentLines.shift();
      if (!started && isControllerListenError(line)) controllerPortBusy = true;
      // Report "connected" only when sing-box actually reports it started,
      // not on the first arbitrary log line (which, in Split mode, is a
      // rule-set download line — causing a false connected→disconnected).
      if (!started && STARTED_RE.test(line) && isCurrent()) markStarted();
    };

    child.stdout?.on('data', (data: Buffer) => {
      data.toString().split('\n').filter((l: string) => l.trim()).forEach(handleLine);
    });

    child.stderr?.on('data', (data: Buffer) => {
      data.toString().split('\n').filter((l: string) => l.trim()).forEach(handleLine);
    });

    child.on('error', (err) => {
      addLog(`ERROR: Process error - ${err.message}`);
      if (isCurrent()) {
        singboxProcess = null;
        clashApi = null;
        isConnecting = false;
        sendToRenderer('singbox:status-change', 'disconnected');
        updateTrayMenu(false);
      }
      if (!started) {
        if (startupTimer) clearTimeout(startupTimer);
        resolve({ success: false, error: err.message });
      }
    });

    child.on('exit', (code, signal) => {
      addLog(`sing-box exited with code ${code}, signal ${signal}`);
      // A controller-port race is retried by startSingbox, which keeps
      // isConnecting set across the pause and reports "disconnected" itself
      // only if it gives up — so don't flicker the status here.
      const retryable = !started && controllerPortBusy;
      if (isCurrent()) {
        singboxProcess = null;
        clashApi = null;
        if (started && !shouldStayStopped()) {
          // Nobody asked for this exit (D18): the watchdog restarts the core
          // and reports "connecting" itself, or gives up.
          const errorLines = recentLines.filter((l) => CRASH_LINE_RE.test(l));
          const lastError = errorLines[errorLines.length - 1];
          handleUnexpectedCoreExit(
            `exit code ${code}${signal ? `, signal ${signal}` : ''}${lastError ? `, last error: ${lastError}` : ''}`,
            (errorLines.length ? errorLines : recentLines).slice(-CRASH_NOTICE_MAX_LINES)
          );
        } else if (!retryable) {
          isConnecting = false;
          sendToRenderer('singbox:status-change', 'disconnected');
          updateTrayMenu(false);
        }
      }
      // If it exited before reporting "started", the start failed — surface
      // the recent log lines (e.g. a FATAL config / rule-set error) instead
      // of a misleading connected→disconnected flicker.
      if (!started) {
        if (startupTimer) clearTimeout(startupTimer);
        if (retryable) {
          resolve({ success: false, controllerPortBusy: true, port: creds.port });
          return;
        }
        const detail = recentLines.filter((l) => /fatal|error/i.test(l)).slice(-3).join(' | ')
          || recentLines.slice(-3).join(' | ')
          || `exited with code ${code}`;
        resolve({ success: false, error: 'sing-box failed to start: ' + detail });
      }
    });

    // Fallback: if the process is alive but never printed a recognizable
    // "started" line within the grace period, assume it started.
    startupTimer = setTimeout(() => {
      if (!started) {
        if (isCurrent()) {
          markStarted();
        } else {
          if (!singboxProcess) isConnecting = false;
          resolve({ success: false, error: 'sing-box startup timed out' });
        }
      }
    }, 12000);
  });
}

/**
 * Send a real Windows console CTRL_BREAK_EVENT to a process so it can run its
 * own graceful-shutdown path.
 *
 * Why this is necessary: on Windows, Node's child.kill('SIGTERM'/'SIGINT') is
 * NOT a real signal — libuv maps it straight to TerminateProcess(), an
 * instant hard-kill with zero chance for the target's own cleanup code to
 * run. sing-box's graceful shutdown (triggered by os.Interrupt) is what calls
 * WintunCloseAdapter() to release the TUN adapter cleanly. Skipping it left
 * the adapter half-torn-down, which is why the *next* TUN start intermittently
 * failed with the contradictory "create adapter: file already exists" +
 * "open existing adapter: Element not found" pair — this is a confirmed
 * sing-box/Windows limitation (SagerNet/sing-box#3806): a process can only
 * receive console control events if it actually has a console, and console
 * events can only be delivered by a process attached to that same console.
 * sing-box is spawned with a real (hidden) console — see startSingbox, no
 * `detached` flag — specifically so this reaches it.
 *
 * Uses a small precompiled helper (resources/bin/ctrlbreak.exe) instead of a
 * live PowerShell `Add-Type` C# compile: measured under real conditions,
 * Add-Type invokes csc.exe fresh every call and took 3.4-5.4+ seconds,
 * occasionally exceeding the timeout and silently falling back to a hard
 * kill — which is exactly what re-corrupted the WinTun adapter even with the
 * CTRL_BREAK fix in place. The precompiled helper runs in ~200ms.
 */
function sendCtrlBreak(pid: number): void {
  const helperPath = getCtrlBreakHelperPath();
  if (!fs.existsSync(helperPath)) {
    addLog('WARN: ctrlbreak.exe helper not found — sing-box will be hard-killed instead.');
    singboxProcess?.kill('SIGTERM');
    return;
  }
  // Fire-and-forget: the helper's own exit code/output is unreliable (it
  // often self-terminates from its own console broadcast — see CtrlBreak.cs)
  // so the caller does not await or branch on it. stopSingbox()'s exit-event
  // listener + timeout are what actually decide success/hard-kill.
  execFile(helperPath, [String(pid)], { windowsHide: true, timeout: 3000 }, () => {});
}

function stopSingbox(): Promise<{ success: boolean; error?: string }> {
  // First, even with no core running: a start that is pausing before its
  // controller-port retry checks this and gives up instead of respawning.
  stopRequested = true;
  return new Promise((resolve) => {
    const child = singboxProcess;
    if (!child) {
      resolve({ success: true });
      return;
    }

    addLog('Stopping sing-box core...');
    const pid = child.pid;
    let settled = false;

    // Child guard (same as in attemptCoreStart): only touch global core state
    // while this child is still THE core, but always settle this promise.
    const timeout = setTimeout(() => {
      settled = true;
      if (singboxProcess === child) {
        addLog('sing-box did not exit gracefully in time — forcing termination.');
        child.kill('SIGKILL');
        singboxProcess = null;
        clashApi = null;
      }
      if (!singboxProcess) {
        sendToRenderer('singbox:status-change', 'disconnected');
        updateTrayMenu(false);
      }
      resolve({ success: true });
    }, 5000);

    child.on('exit', () => {
      clearTimeout(timeout);
      // Already reported by the forced-termination path above.
      if (settled) return;
      settled = true;
      if (singboxProcess === child) {
        singboxProcess = null;
        clashApi = null;
      }
      if (!singboxProcess) {
        sendToRenderer('singbox:status-change', 'disconnected');
        updateTrayMenu(false);
      }
      addLog('sing-box stopped.');
      resolve({ success: true });
    });

    if (process.platform === 'win32' && pid) {
      // Fire the CTRL_BREAK helper and then rely ONLY on the exit-event/
      // timeout race above to decide whether to hard-kill. The helper's own
      // exit status/output is NOT a reliable success signal: it broadcasts
      // to process group 0 (everyone on sing-box's console), which reaches
      // sing-box reliably but also frequently kills the helper itself before
      // it can report "OK" — sing-box still shuts down gracefully in that
      // case. Treating the helper's self-inflicted "failure" as a real
      // failure and immediately firing a SIGTERM hard-kill on top of the
      // already-in-progress graceful shutdown was itself corrupting the
      // WinTun adapter (a redundant kill racing the real one).
      sendCtrlBreak(pid);
    } else {
      child.kill('SIGTERM');
    }
  });
}

function updateTrayMenu(connected: boolean) {
  if (!tray) return;
  trayConnected = connected;
  setTrayConnected(connected);
  tray.setContextMenu(buildTrayMenu(connected));
}

// ==================== Traffic Stats ====================

let trafficInterval: NodeJS.Timeout | null = null;

function startTrafficMonitoring() {
  if (trafficInterval) return;

  // sing-box exposes cumulative up/down byte counters via the Clash API (on
  // the running core's per-start port, see clashApi). We poll the snapshot
  // endpoint once per second and derive per-second speed from the delta.
  let lastUp = 0;
  let lastDown = 0;
  let primed = false;

  trafficInterval = setInterval(() => {
    if (!singboxProcess || !clashApi) return;

    void clashConnectionTotals(clashApi).then((totals: { uploadTotal: number; downloadTotal: number } | null) => {
      // Clash API not ready yet, or a malformed/empty response; skip this tick.
      if (!totals) return;
      const totalUp = totals.uploadTotal;
      const totalDown = totals.downloadTotal;

      if (primed) {
        const up = Math.max(0, totalUp - lastUp);
        const down = Math.max(0, totalDown - lastDown);
        sendToRenderer('singbox:traffic', { up, down });
      }
      lastUp = totalUp;
      lastDown = totalDown;
      primed = true;
    });
  }, 1000);
}

function stopTrafficMonitoring() {
  if (trafficInterval) {
    clearInterval(trafficInterval);
    trafficInterval = null;
  }
}

// ==================== System Proxy ====================

/**
 * Registry logic lives in shared/system-proxy.cjs (D5-D9, D11, D12). The
 * marker it saves before every enable is what lets disable / the next launch
 * put back exactly what the user had, and only while the proxy is still ours.
 */
const systemProxy: {
  enable(host: string, port: number): Promise<boolean>;
  disable(): Promise<boolean>;
  recover(options?: { legacyLeftover?: { port: number } }): Promise<string>;
  restoreSync(): void;
  status(): Promise<{ enabled: boolean; server: string }>;
} = createSystemProxy({ markerStore: systemProxyMarkerStore, log: addLog });

/**
 * Everything a disconnect means, in main: stop the traffic poll, stop the
 * core, put the system proxy back. Works without a window (tray, quit), and
 * during a watchdog restart, which it calls off first.
 */
async function disconnectCore(): Promise<void> {
  cancelWatchdog();
  stopTrafficMonitoring();
  await stopSingbox();
  await systemProxy.disable();
}

// ==================== Core Watchdog ====================

/**
 * A core that stops on its own is restarted (audit P1-5, D18): after 1 s, 3 s
 * and 10 s, at most 3 times per rolling minute (core-watchdog.ts). While a
 * restart is pending the system proxy stays set, so in System Proxy mode
 * traffic fails closed instead of quietly going direct. The restarted core
 * keeps the user's node without the renderer, because its cache file restores
 * every selector's last choice.
 */
let watchdogTimer: NodeJS.Timeout | null = null;
/**
 * When each restart of the current crash streak was planned. performance.now()
 * rather than the wall clock, so a clock change can't stretch or shrink the
 * one-minute window.
 */
let watchdogHistory: number[] = [];

/**
 * The watchdog restart under way: its start and what it makes of the result.
 * The watchdog reuses the config file from the last connect, so the renderer
 * applies a change the user makes meanwhile through an explicit stop and
 * start. A node pick arrives as singbox:restart, which stops first and then
 * waits for this run to finish. A Settings change arrives through the
 * renderer's reconnect() as singbox:stop and then singbox:start, and neither
 * waits. There, reconnect()'s 800 ms pause between the two lets this run
 * settle: if this run's start is in the controller-port retry pause
 * (CONTROLLER_RETRY_DELAY_MS), it cancels itself only when that pause ends,
 * and a start before then would be refused as already running.
 */
let watchdogRun: Promise<void> | null = null;

/** The core's log lines worth showing when it stops unexpectedly. */
const CRASH_LINE_RE = /fatal|error|panic/i;
const CRASH_NOTICE_MAX_LINES = 5;

/** The Dashboard banner and the Windows notification when the watchdog gives up (D19). */
const CORE_GAVE_UP_MESSAGE =
  "sing-box stopped unexpectedly and couldn't be restarted. The system proxy was restored, so apps now connect directly.";

/** Kept referenced: a Notification object that is garbage-collected can't deliver its click any more. */
let coreGaveUpNotification: Notification | null = null;

/** The core is meant to be down, so its exit isn't a crash and no restart may run (D18). */
function shouldStayStopped(): boolean {
  return stopRequested || isQuitting || isUpdateInstalling();
}

/**
 * An explicit start, restart or stop replaces a pending restart and starts a
 * new history (D18). Called from the singbox:start / singbox:restart /
 * singbox:stop handlers and disconnectCore(), never from startSingbox(): the
 * watchdog restarts through it, and clearing the history there would make the
 * cap unreachable.
 */
function cancelWatchdog(): void {
  watchdogHistory = [];
  if (!watchdogTimer) return;
  clearTimeout(watchdogTimer);
  watchdogTimer = null;
  // The core is already down, and stopping a core that isn't running reports
  // nothing, so take back the watchdog's "connecting" here. A start that
  // follows reports its own result.
  sendToRenderer('singbox:status-change', 'disconnected');
  updateTrayMenu(false);
}

/**
 * The current core stopped without anyone asking, or a watchdog restart failed,
 * which counts the same (D18): plan the next restart, or give up.
 */
function handleUnexpectedCoreExit(reason: string, lines: string[]): void {
  const plan = planWatchdogRestart(watchdogHistory, performance.now());
  watchdogHistory = plan.history;
  if (plan.delayMs === null) {
    void giveUpOnCore(lines);
    return;
  }
  // Only true while our system proxy is set (System Proxy mode). In TUN/Split
  // the adapter goes away with the core, so traffic can't be held back.
  const proxyNote = systemProxyMarkerStore.get()
    ? '; the system proxy stays on meanwhile, so traffic is blocked rather than sent direct'
    : '';
  addLog(`WARN: sing-box stopped unexpectedly (${reason}). Restarting it in ${plan.delayMs / 1000} s${proxyNote}.`);
  sendToRenderer('singbox:status-change', 'connecting');
  setTrayReconnecting();
  watchdogTimer = setTimeout(() => {
    watchdogRun = runWatchdogRestart().finally(() => {
      watchdogRun = null;
    });
  }, plan.delayMs);
}

async function runWatchdogRestart(): Promise<void> {
  watchdogTimer = null;
  // A Windows session end, an accepted elevation relaunch or an update install
  // can begin while the restart is pending without calling it off. Whoever
  // started it owns the teardown, so just report the core as down.
  if (shouldStayStopped()) {
    sendToRenderer('singbox:status-change', 'disconnected');
    updateTrayMenu(false);
    return;
  }
  const result = await startSingbox(getConfigPath());
  if (result.success) {
    startTrafficMonitoring();
    addLog('sing-box restarted after an unexpected exit.');
    return;
  }
  // Stopped on purpose while it was starting: not a crash, and nothing follows.
  if (shouldStayStopped()) {
    sendToRenderer('singbox:status-change', 'disconnected');
    updateTrayMenu(false);
    return;
  }
  const error = result.error || 'unknown error';
  handleUnexpectedCoreExit(`the restart failed: ${error}`, [error]);
}

/**
 * The restart cap is reached (D19): disconnect for real, so nothing points at
 * a core that isn't coming back, and tell the user: the Dashboard banner if a
 * window is open, a Windows notification either way, and the tray tooltip.
 */
async function giveUpOnCore(lines: string[]): Promise<void> {
  addLog(
    `ERROR: sing-box keeps stopping unexpectedly (restarted ${WATCHDOG_DELAYS_MS.length} times within a minute); giving up and disconnecting.`
  );
  stopTrafficMonitoring();
  await systemProxy.disable();
  sendToRenderer('singbox:status-change', 'disconnected');
  updateTrayMenu(false);
  tray?.setToolTip('Awesome Proxy — Disconnected (core stopped unexpectedly)');
  sendToRenderer('singbox:crashed', { message: CORE_GAVE_UP_MESSAGE, lines, at: Date.now() });
  showCoreGaveUpNotification();
}

function showCoreGaveUpNotification(): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: 'Awesome Proxy disconnected', body: CORE_GAVE_UP_MESSAGE });
  notification.on('click', () => showMainWindow());
  notification.show();
  coreGaveUpNotification = notification;
}

// ==================== URL Validation ====================

/**
 * Validate that a URL is safe to fetch.
 * Blocks internal/private IPs and loopback addresses to prevent SSRF.
 */
function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    // Block URLs with credentials embedded (potential abuse)
    if (parsed.username || parsed.password) {
      return false;
    }

    // Block internal/private hostnames
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'];
    if (blockedHosts.includes(parsed.hostname.toLowerCase())) {
      return false;
    }

    // Check for private IP ranges
    const ipv4Match = parsed.hostname.match(
      /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
    );
    if (ipv4Match) {
      const b1 = parseInt(ipv4Match[1]);
      const b2 = parseInt(ipv4Match[2]);
      // 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x (link-local)
      if (
        b1 === 10 ||
        (b1 === 172 && b2 >= 16 && b2 <= 31) ||
        (b1 === 192 && b2 === 168) ||
        (b1 === 169 && b2 === 254) ||
        b1 === 0 || // 0.0.0.0/8
        b1 === 127 // 127.0.0.0/8 loopback
      ) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ==================== Network Utilities ====================

/**
 * User-Agent sent when fetching subscriptions.
 *
 * This is REQUIRED, not cosmetic: Node's http/https client sends no
 * User-Agent by default, and many subscription providers sit behind a WAF that
 * returns "403 Forbidden" for UA-less requests. That produced the confusing
 * "no nodes found" symptom — the app was successfully downloading an HTML
 * error page and then failing to find proxies in it.
 *
 * The string deliberately identifies as clash/mihomo-compatible because many
 * panels switch response FORMAT based on the UA. We can parse Clash/Mihomo
 * YAML and plain link lists, but NOT sing-box's own JSON config format, so we
 * must not advertise "sing-box" or some providers would hand back a config
 * this app can't read.
 */
const SUBSCRIPTION_USER_AGENT = 'AwesomeProxy/1.0.0 (compatible; clash; mihomo)';

function fetchUrl(url: string, timeout = 10000, redirects = 0): Promise<string> {
  // Validate URL to prevent SSRF attacks
  if (!isUrlSafe(url)) {
    return Promise.reject(new Error('Blocked: potentially unsafe URL (internal/private network)'));
  }
  if (redirects > 6) {
    return Promise.reject(new Error('Too many redirects'));
  }

  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        timeout,
        headers: {
          'User-Agent': SUBSCRIPTION_USER_AGENT,
          Accept: '*/*',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchUrl(res.headers.location, timeout, redirects + 1).then(resolve).catch(reject);
          return;
        }
        // Surface HTTP errors instead of handing an error page to the parser,
        // which previously showed up as a misleading "no valid proxy nodes".
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from subscription server`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * TCP handshake latency. Delegates to the shared probe module so Electron and
 * the web backend can't drift into reporting different numbers.
 */
function testLatency(host: string, port: number): Promise<number> {
  return tcpPing(host, port, 5000);
}

// ==================== Auto Start ====================

function setAutoStart(enabled: boolean) {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath('exe'),
    });
  }
}

function getAutoStart(): boolean {
  if (process.platform === 'win32') {
    return app.getLoginItemSettings().openAtLogin;
  }
  return false;
}

// ==================== Admin / Elevation ====================

/**
 * Detect whether the current process has Administrator rights on Windows.
 * `net session` only succeeds when elevated, so its exit code is a reliable
 * (and dependency-free) probe.
 */
function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    exec('net session', (error) => resolve(!error));
  });
}

/**
 * Relaunch the app with Administrator rights via the UAC prompt, then quit the
 * current (non-elevated) instance. Uses PowerShell's `Start-Process -Verb RunAs`.
 *
 * Key detail: an elevated process started via RunAs inherits
 * C:\Windows\system32 as its working directory, NOT the project folder. So we
 * must pass ABSOLUTE paths and an explicit -WorkingDirectory, otherwise the
 * elevated Electron can't find the app (relative "." resolves against system32)
 * and exits silently — which is exactly the "UAC shown but nothing restarts"
 * symptom.
 */
function relaunchAsAdmin(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);

  return new Promise((resolve) => {
    const exe = process.execPath; // packaged: AwesomeProxy.exe; dev: electron.exe
    const appPath = app.getAppPath(); // absolute path to app root (or asar)
    const workDir = app.isPackaged ? path.dirname(exe) : appPath;

    // Build the argument list for the elevated process.
    let argsArray: string[];
    if (app.isPackaged) {
      // Re-pass original CLI args (minus the exe itself).
      argsArray = process.argv.slice(1);
    } else {
      // Dev: Electron needs the absolute app directory as its first arg. If a
      // Vite dev server is in use, forward its URL via an env-like switch so the
      // elevated instance loads the same renderer.
      argsArray = [appPath];
    }

    // Preserve the dev-server URL so the elevated renderer matches this one.
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || '';

    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const argList = argsArray.length ? ` -ArgumentList ${argsArray.map(quote).join(',')}` : '';

    // Set VITE_DEV_SERVER_URL for the child when in dev, so loadURL works.
    const envPrefix = devServerUrl
      ? `$env:VITE_DEV_SERVER_URL=${quote(devServerUrl)}; `
      : '';

    const psCommand =
      `${envPrefix}Start-Process -FilePath ${quote(exe)}${argList} ` +
      `-WorkingDirectory ${quote(workDir)} -Verb RunAs`;

    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
      if (ok) {
        // This instance is going away: from now on a window close is real.
        isQuitting = true;
        // Give the elevated instance a moment to spawn, then quit this one.
        // app.exit() bypasses `before-quit` entirely (unlike app.quit()), so
        // this is the only cleanup this instance gets, and it must be awaited
        // here: the same runQuitCleanup() a normal quit runs. The graceful
        // sing-box stop in it keeps this path from hard-killing sing-box like
        // the old before-quit bug, which corrupted the WinTun adapter for the
        // next launch. Its system proxy restore is normally a no-op, because
        // reconnect() already disconnected a connected session before asking
        // for elevation; Settings' "Restart as admin" doesn't disconnect
        // first, and then the restore puts the user's proxy back.
        setTimeout(async () => {
          await runQuitCleanup().catch((err) => console.error('Quit cleanup failed:', err));
          app.exit(0);
        }, 800);
      } else {
        // Elevation was declined or failed: this instance stays, so take the
        // lock back. If another launch got it in the meantime, two instances
        // now run; say so in the log.
        if (!app.requestSingleInstanceLock()) {
          addLog('WARN: Could not re-acquire the single-instance lock after the elevation request; another Awesome Proxy instance may be running.');
        }
      }
    };

    // Hand the single-instance lock to the elevated instance (D14): it starts
    // while this one is still alive (the 800 ms above plus the cleanup), and
    // holding the lock would make it treat itself as a second launch and quit.
    app.releaseSingleInstanceLock();
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { windowsHide: true, stdio: 'ignore' }
    );

    child.on('error', () => done(false));
    // RunAs returns exit code 0 once the user accepts UAC (or non-zero/declined).
    child.on('exit', (code) => done(code === 0));
  });
}

// ==================== Core Upgrade (sing-box) ====================

const SINGBOX_RELEASES_API = 'https://api.github.com/repos/SagerNet/sing-box/releases/latest';
// ghproxy-style mirrors are used as fallbacks when GitHub is unreachable
// (same pattern the rule-set downloads already rely on). Transport only
// (D28): whichever source serves the zip, it must match the SHA-256 GitHub's
// API publishes, so a mirror can make a download fail but can't change what
// gets installed.
const GH_DOWNLOAD_MIRRORS = [
  (url: string) => url, // direct GitHub
  (url: string) => 'https://ghfast.top/' + url,
  (url: string) => 'https://gh-proxy.com/' + url,
];

/** The validated core line as users read it, e.g. "1.14.x" (D29). */
const MAX_VALIDATED_CORE_LABEL = `${MAX_VALIDATED_CORE}.x`;

/**
 * Two flags for a core upgrade or restore (D31). coreUpgradeBusy spans the
 * whole run and only turns away a second upgrade or restore.
 * coreSwapInProgress spans just the disconnect and the file swap, and
 * startSingbox refuses while it is set. Connecting during the download or the
 * checks still works; the install stage then disconnects.
 */
let coreUpgradeBusy = false;
let coreSwapInProgress = false;

/**
 * The installed core's version, used to decide which config surface to generate
 * and shown in Settings → About.
 *
 * Cached because config generation happens on every connect and mode change.
 * A failed probe is NOT cached (compat R1): one slow first run used to pin every
 * later config to the oldest surface for the whole session. Invalidated after a
 * core upgrade so the very next config picks up the new surface.
 */
const coreVersionProbe: { get(): Promise<string | null>; invalidate(): void } = createCoreVersionProbe({
  getBinaryPath: getSingboxPath,
  log: addLog,
});

/** Version for config generation; an unreadable core gets the oldest supported surface. */
async function getCoreVersionForConfig(): Promise<string> {
  return (await coreVersionProbe.get()) ?? '0.0.0';
}

function sendUpgradeProgress(data: { stage: string; percent?: number; message?: string }) {
  sendToRenderer('singbox:upgrade-progress', data);
}

type CoreUpdateInfo = CoreRelease & { current: string; maxValidated: string };

/**
 * Ask GitHub's API for the latest sing-box release and compare it with the
 * installed core. Through the running core when connected, else direct (D27),
 * the same routing the app updater uses, and the log says which.
 */
async function checkSingboxUpdate(): Promise<CoreUpdateInfo> {
  const current = (await coreVersionProbe.get()) ?? '0.0.0';
  const proxyPort = getCoreProxyPort();
  addLog(
    `Checking GitHub for a newer sing-box core ${proxyPort ? `via the local proxy (127.0.0.1:${proxyPort})` : 'directly'}.`
  );
  const release = parseCoreRelease(await fetchJson(SINGBOX_RELEASES_API, { proxyPort }), current);
  return { ...release, current, maxValidated: MAX_VALIDATED_CORE_LABEL };
}

/**
 * The version to record for the core being backed up. checkSingboxUpdate
 * reports an unreadable core as 0.0.0, which would only mislead next to
 * "Restore previous core"; such a backup is recorded without a version.
 */
function backupRecordVersion(current: string): string | undefined {
  return current && current !== '0.0.0' ? current : undefined;
}

/** Record what sing-box.exe.bak holds (D32). The .bak itself is only ever copied back, never run. */
async function recordCoreBackup(current: string): Promise<void> {
  const version = backupRecordVersion(current);
  (await getMainState()).set('coreBackup', version ? { version, at: Date.now() } : { at: Date.now() });
}

type CoreUpgradeResult = {
  success: boolean;
  upgraded?: boolean;
  current?: string;
  latest?: string;
  needsConfirmation?: boolean;
  error?: string;
};

// The pre-install check runs the user's own nodes and rules; these stand in
// when there are none, so every mode still exercises a proxy outbound and a
// rule set. `check` never connects, so the address is never contacted.
const CORE_CHECK_FIXTURE_NODE = {
  id: 'core-check',
  name: 'core-check',
  type: 'shadowsocks',
  server: '127.0.0.1',
  port: 9,
  method: 'aes-128-gcm',
  password: 'core-check',
};
const CORE_CHECK_FIXTURE_SPLIT_RULE = {
  id: 'core-check',
  name: 'core-check',
  outbound: 'proxy',
  ruleSets: ['geosite-openai'],
  enabled: true,
};
const CORE_CHECK_MODES: ReadonlyArray<[ProxyModeName, string]> = [
  ['system', 'System'],
  ['tun', 'TUN'],
  ['split', 'Split'],
];

/**
 * D30: generate the System, TUN and Split configs this app would write for
 * the stored nodes and settings, for the NEW core's version, and pipe each into
 * the new binary's `check -c stdin` (never `run`). Returns why it was rejected,
 * or null when all three pass.
 */
async function checkNewCoreAgainstConfigs(exe: string, coreVersion: string, workDir: string): Promise<string | null> {
  const s = await getStore();
  const storedNodes = s.get('nodes');
  const storedIndex = s.get('selectedIndex');
  const settings = s.get('settings') || {};
  const hasNodes = Array.isArray(storedNodes) && storedNodes.length > 0;
  const nodes = hasNodes ? storedNodes : [CORE_CHECK_FIXTURE_NODE];
  const selectedIndex = hasNodes ? (Number.isInteger(storedIndex) ? storedIndex : -1) : 0;
  // The same filter the generator applies to split rules.
  const userRules: any[] = Array.isArray(settings.splitRules) ? settings.splitRules : [];
  const hasEnabledRule = userRules.some(
    (r) => r && r.enabled && Array.isArray(r.ruleSets) && r.ruleSets.length > 0
  );
  const splitRules = hasEnabledRule ? userRules : [...userRules, CORE_CHECK_FIXTURE_SPLIT_RULE];
  // A throwaway controller: check never listens on it, but the real configs
  // always carry one, so the check should too.
  const clashApi = await createClashApiCredentials();
  // Inside the extract folder, which is deleted afterwards.
  const cacheFilePath = path.join(workDir, 'core-check-cache.db');

  for (const [mode, label] of CORE_CHECK_MODES) {
    const config = generateSingboxConfig(nodes, selectedIndex, {
      ...settings,
      proxyMode: mode,
      splitRules,
      clashApi,
      coreVersion,
      cacheFilePath,
    });
    const result = await checkConfigWithCore(exe, config);
    if (!result.ok) {
      const firstLine = result.output.split(/\r?\n/).find((line) => line.trim()) || 'no output';
      return `sing-box v${coreVersion} rejected the ${label} config this app generates: ${firstLine.trim()}`;
    }
  }
  return null;
}

/**
 * Upgrade the core to GitHub's latest release (D28-D32), reporting stages to
 * the renderer. Nothing is stopped or replaced until the download matched
 * GitHub's SHA-256 digest, the new binary reported the expected version and
 * passed the System, TUN and Split checks. Only then does it disconnect and
 * swap the file, keeping the old core as sing-box.exe.bak.
 */
async function upgradeSingboxCore(options: { allowUnvalidated: boolean }): Promise<CoreUpgradeResult> {
  if (coreUpgradeBusy) return { success: false, error: 'A core upgrade is already running.' };
  coreUpgradeBusy = true;

  const tmpDir = app.getPath('temp');
  let zipPath: string | null = null;
  let extractDir: string | null = null;
  const stopped = (error: string): CoreUpgradeResult => {
    addLog(`Core upgrade stopped: ${error}`);
    return { success: false, error };
  };

  try {
    sendUpgradeProgress({ stage: 'checking' });
    const info = await checkSingboxUpdate();
    if (!info.hasUpdate) {
      return { success: true, upgraded: false, current: info.current, latest: info.latest };
    }

    // Past the validated line only after the user confirmed (D29).
    if (!info.validated && !options.allowUnvalidated) {
      return {
        success: false,
        needsConfirmation: true,
        current: info.current,
        latest: info.latest,
        error: `sing-box v${info.latest} has not been validated with Awesome Proxy ${app.getVersion()} (validated: ${MAX_VALIDATED_CORE_LABEL}).`,
      };
    }

    // Fail closed: no digest (or no asset to apply it to) means nothing to
    // verify against. The old constructed fallback URL is gone with it.
    if (!info.sha256 || !info.downloadUrl) {
      return stopped(
        `GitHub didn't publish a SHA-256 digest for sing-box v${info.latest}, so it can't be verified and was not installed.`
      );
    }
    const downloadUrl = info.downloadUrl;

    zipPath = path.join(tmpDir, `sing-box-${info.latest}.zip`);
    extractDir = path.join(tmpDir, `sing-box-${info.latest}-extract`);

    // Mirrors are transport only: every source's bytes are hashed (D28).
    sendUpgradeProgress({ stage: 'downloading', percent: 0 });
    try {
      await downloadVerified(GH_DOWNLOAD_MIRRORS.map((mirror) => mirror(downloadUrl)), zipPath, {
        sha256: info.sha256,
        size: info.size,
        onProgress: (fraction) => sendUpgradeProgress({ stage: 'downloading', percent: Math.round(fraction * 100) }),
      });
    } catch (err: any) {
      if (err?.name === 'CoreIntegrityError') {
        addLog(`WARN: ${err.message}`);
        return stopped("The download didn't match GitHub's SHA-256 digest from any source; nothing was installed.");
      }
      return stopped('Download failed: ' + (err?.message || 'unknown error'));
    }

    sendUpgradeProgress({ stage: 'extracting' });
    try {
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      await extractZip(zipPath, extractDir);
    } catch (err: any) {
      return stopped(err.message);
    }
    const newExe = findFileRecursive(extractDir, 'sing-box.exe');
    if (!newExe) {
      return stopped('sing-box.exe not found in the downloaded archive');
    }

    // The new binary must be the release it claims to be and accept the
    // configs this app generates, before anything is stopped (D30).
    sendUpgradeProgress({ stage: 'validating' });
    const newVersion = await readCoreVersion(newExe);
    if (newVersion !== info.latest) {
      return stopped(
        `The downloaded sing-box reports version ${newVersion ?? '(unreadable)'} instead of v${info.latest}; nothing was installed.`
      );
    }
    const rejection = await checkNewCoreAgainstConfigs(newExe, newVersion, extractDir);
    if (rejection) return stopped(rejection);

    // Swapping disconnects (D31): stop the core and restore the system proxy
    // first, so the proxy never points at a stopped core. This also frees the
    // file, which Windows locks while the core runs.
    sendUpgradeProgress({ stage: 'installing' });
    const target = getSingboxPath();
    coreSwapInProgress = true;
    try {
      await disconnectCore();
      swapCoreBinary(newExe, target, target + '.bak');
      await recordCoreBackup(info.current);
    } catch (err: any) {
      // The copy failed after the backup was refreshed and the old core was put
      // back: the backup now holds the installed core, so its record says so.
      if (err?.backupReplaced) await recordCoreBackup(info.current).catch(() => {});
      return stopped(err.message);
    } finally {
      coreSwapInProgress = false;
    }

    // The binary changed, so the cached version — and with it the set of config
    // fields we're allowed to emit — is now stale.
    coreVersionProbe.invalidate();
    const installed = (await coreVersionProbe.get()) ?? '0.0.0';
    const previous = backupRecordVersion(info.current);
    addLog(
      `sing-box core upgraded to v${installed}; the previous core${previous ? ` (v${previous})` : ''} is kept for "Restore previous core".`
    );
    sendUpgradeProgress({ stage: 'done' });
    return { success: true, upgraded: true, current: installed, latest: info.latest };
  } finally {
    // The download and the extracted files only; never the .bak.
    if (zipPath) {
      try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    }
    if (extractDir) {
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    coreUpgradeBusy = false;
  }
}

/**
 * "Restore previous core" (D32): copy sing-box.exe.bak back over the core,
 * after disconnecting like an upgrade does, then forget the backup.
 */
async function restorePreviousCore(): Promise<{ success: boolean; current?: string; error?: string }> {
  if (coreUpgradeBusy) return { success: false, error: 'A core upgrade is already running.' };
  coreUpgradeBusy = true;
  coreSwapInProgress = true;
  try {
    const target = getSingboxPath();
    const backup = target + '.bak';
    if (!fs.existsSync(backup)) return { success: false, error: 'There is no previous core to restore.' };
    await disconnectCore();
    restoreCoreBackup(target, backup);
    (await getMainState()).delete('coreBackup');
  } catch (err: any) {
    addLog(`Restoring the previous core failed: ${err.message}`);
    // A copy that failed midway may have changed the file: re-read it next time.
    coreVersionProbe.invalidate();
    return { success: false, error: err.message };
  } finally {
    coreSwapInProgress = false;
    coreUpgradeBusy = false;
  }
  coreVersionProbe.invalidate();
  const current = (await coreVersionProbe.get()) ?? '0.0.0';
  addLog(`Restored the previous sing-box core (v${current}).`);
  return { success: true, current };
}

// ==================== IPC Handlers ====================

function registerIpcHandlers() {
  // sing-box management
  //
  // start / restart ignore the path the renderer sends and always use the
  // app's own config file: main now rewrites that file before every spawn
  // (to inject the Clash API credentials), so honouring a renderer-chosen path
  // would hand the renderer a write primitive. The renderer has always passed
  // the path config:write returned, which is this same file.
  //
  // Each of start / stop / restart first calls off a pending watchdog restart
  // and its history (D18): the user's explicit choice replaces it.
  ipcMain.handle('singbox:start', async (_event, _configPath?: string) => {
    cancelWatchdog();
    const result = await startSingbox(getConfigPath());
    if (result.success) startTrafficMonitoring();
    return result;
  });

  ipcMain.handle('singbox:stop', async () => {
    cancelWatchdog();
    stopTrafficMonitoring();
    return await stopSingbox();
  });

  ipcMain.handle('singbox:restart', async (_event, _configPath?: string) => {
    cancelWatchdog();
    stopTrafficMonitoring();
    await stopSingbox();
    // A watchdog restart that was already starting gives way to this one: the
    // stop above ended its core, or makes it cancel itself before spawning.
    // Wait until the watchdog has seen that. Starting sooner would either be
    // refused as already running, or clear stopRequested before the watchdog
    // checks it, so its cancelled start would count as another crash and arm
    // a restart next to this core.
    if (watchdogRun) await watchdogRun;
    const result = await startSingbox(getConfigPath());
    if (result.success) startTrafficMonitoring();
    return result;
  });

  ipcMain.handle('singbox:status', () => {
    // A pending watchdog restart is still a connection on its way back (D19).
    if (isConnecting || watchdogTimer) return 'connecting';
    return singboxProcess ? 'connected' : 'disconnected';
  });

  // Shares the cached probe with config generation instead of spawning the
  // binary again on every Settings visit.
  ipcMain.handle('singbox:version', async () => {
    return (await coreVersionProbe.get()) ?? 'Not found';
  });

  ipcMain.handle('singbox:logs', () => {
    return singboxLogs;
  });

  ipcMain.handle('singbox:clear-logs', () => {
    singboxLogs = [];
    return true;
  });

  // Live-switch a selector's active outbound via the Clash API (no restart).
  // The credentials never leave main; the renderer only names the selector.
  ipcMain.handle('singbox:select', async (_event, selector: string, outbound: string) => {
    if (!clashApi) return { success: false, error: 'sing-box is not running' };
    return await clashSelect(clashApi, String(selector), String(outbound));
  });

  // Read back which outbound a selector is ACTUALLY using, so the renderer can
  // confirm a selection took effect rather than trusting the PUT's status code.
  // A successful PUT only means the request was accepted: sing-box's cache file
  // restores a previous choice on start and overrides the config's `default`,
  // which is what once made a chosen node look ignored.
  ipcMain.handle('singbox:selection', async (_event, selector: string) => {
    if (!clashApi) return { success: false, error: 'sing-box is not running' };
    return await clashSelection(clashApi, String(selector));
  });

  // Let the renderer report the active proxy mode so the tray icon can be
  // tinted accordingly (system=blue, tun=red, split=purple, manual=amber).
  ipcMain.handle('tray:set-mode', (_event, mode: string) => {
    if (mode === 'system' || mode === 'tun' || mode === 'split' || mode === 'manual') {
      currentProxyMode = mode;
      if (trayConnected) {
        setTrayConnected(true);
        tray?.setContextMenu(buildTrayMenu(true));
      }
    }
  });

  // Check GitHub for the latest sing-box release.
  ipcMain.handle('singbox:check-update', async () => {
    try {
      const info = await checkSingboxUpdate();
      return {
        success: true,
        current: info.current,
        latest: info.latest,
        hasUpdate: info.hasUpdate,
        validated: info.validated,
        maxValidated: info.maxValidated,
        downloadUrl: info.downloadUrl ?? undefined,
        notes: info.notes,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Download, verify, check and install the latest sing-box core (one-key
  // upgrade). Only the confirmation flag is read from the renderer (D29): what
  // gets downloaded and how it is verified comes from GitHub's API alone.
  ipcMain.handle('singbox:upgrade', async (_event, options?: { allowUnvalidated?: unknown }) => {
    try {
      return await upgradeSingboxCore({ allowUnvalidated: options?.allowUnvalidated === true });
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Whether a previous core is kept (sing-box.exe.bak), and its version when
  // the upgrade recorded one (D32).
  ipcMain.handle('singbox:core-backup', async () => {
    const state = await getMainState();
    const record = state.get('coreBackup');
    if (!fs.existsSync(getSingboxPath() + '.bak')) {
      // The file is gone (an app update reinstalls bin\, or it was deleted):
      // the record no longer describes anything.
      if (record) state.delete('coreBackup');
      return { available: false };
    }
    return typeof record?.version === 'string' ? { available: true, version: record.version } : { available: true };
  });

  // Put the previous core back (disconnects first, like an upgrade).
  ipcMain.handle('singbox:restore-core', async () => {
    try {
      return await restorePreviousCore();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Configuration
  ipcMain.handle('config:generate', async (_event, nodes, selectedIndex, settings) => {
    // Which core will run this config decides which fields are legal to emit,
    // so detect it rather than assuming the one we shipped with — Settings →
    // About can upgrade the core independently of the app.
    const coreVersion = await getCoreVersionForConfig();
    // Nodes the generator had to leave out would otherwise vanish silently: the
    // core starts fine and the user just never sees that node work. Surface the
    // reason in the app log instead.
    if (Array.isArray(nodes)) {
      const tags = buildOutboundTags(nodes);
      const selectedTag =
        selectedIndex >= 0 && selectedIndex < tags.length ? tags[selectedIndex] : null;
      nodes.forEach((node: any, index: number) => {
        const name = (node && node.name) || '(unnamed)';
        const reason = nodeRejectionReason(node, coreVersion);
        if (reason) {
          addLog(`Skipped node "${name}" — ${reason}`);
          return;
        }
        // Not broken, just not part of THIS config. Worth saying out loud,
        // because "I imported three OpenVPN profiles and only one works" is
        // otherwise indistinguishable from a bug.
        const inactive = nodeInactiveReason(node, tags[index], selectedTag);
        if (inactive) addLog(`Left out node "${name}" — ${inactive}`);
      });
    }
    return generateSingboxConfig(nodes, selectedIndex, {
      ...settings,
      // The renderer-facing config never carries a controller: the real
      // per-start credentials are injected by startSingbox, so whatever the
      // renderer put here is dropped.
      clashApi: undefined,
      coreVersion,
      // Keep the core's cache next to the config instead of letting it land in
      // whatever directory the core was spawned from. See the cache_file notes
      // in the config generator.
      cacheFilePath: path.join(app.getPath('userData'), 'cache.db'),
    });
  });

  ipcMain.handle('config:write', (_event, config) => {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return configPath;
  });

  // System proxy
  // enable accepts only 127.0.0.1 / localhost and a valid port (D12);
  // disable restores the saved settings and is a no-op without a marker (D6).
  ipcMain.handle('system-proxy:enable', async (_event, host, port) => {
    return await systemProxy.enable(host, port);
  });

  ipcMain.handle('system-proxy:disable', async () => {
    return await systemProxy.disable();
  });

  ipcMain.handle('system-proxy:status', async () => {
    return await systemProxy.status();
  });

  // File operations: pickers only. They return a path the user chose and read
  // nothing. There is deliberately no read or write by path (audit P0-5): the
  // app runs elevated in TUN/Split, so such a channel would turn any script
  // running in the renderer into arbitrary file access. A future import should
  // show the dialog and read the file in one main-process call.
  ipcMain.handle('file:select', async (_event, filters) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('file:select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Store
  ipcMain.handle('store:get', async (_event, key: string) => {
    const s = await getStore();
    return s.get(key);
  });

  ipcMain.handle('store:set', async (_event, key: string, value: any) => {
    const s = await getStore();
    s.set(key, value);
    return true;
  });

  ipcMain.handle('store:delete', async (_event, key: string) => {
    const s = await getStore();
    s.delete(key);
    return true;
  });

  // App
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:platform', () => process.platform);
  ipcMain.handle('app:minimize', () => mainWindow?.minimize());
  ipcMain.handle('app:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle('app:close', () => mainWindow?.hide());
  ipcMain.handle('app:quit', () => {
    // Cleanup happens in the `before-quit` handler (blocks until done).
    app.quit();
  });
  ipcMain.handle('app:set-autostart', (_event, enabled: boolean) => setAutoStart(enabled));
  ipcMain.handle('app:get-autostart', () => getAutoStart());
  ipcMain.handle('app:is-admin', () => isElevated());
  ipcMain.handle('app:relaunch-as-admin', () => relaunchAsAdmin());
  ipcMain.handle('app:set-start-minimized', async (_event, enabled: boolean) => {
    const s = await getStore();
    s.set('settings.startMinimized', enabled);
  });

  // Network
  ipcMain.handle('network:fetch-url', async (_event, url: string, timeout?: number) => {
    return await fetchUrl(url, timeout);
  });

  ipcMain.handle('network:test-latency', async (_event, host: string, port: number) => {
    return await testLatency(host, port);
  });

  // Real latency through one specific outbound, measured by sing-box itself.
  // Needs the core running; leaves the active selection untouched.
  ipcMain.handle('network:test-delay', async (_event, tag: string, url?: string, timeout?: number) => {
    if (!singboxProcess || !clashApi) return -1;
    return await clashDelay({ tag, url, timeout: timeout || 5000, port: clashApi.port, secret: clashApi.secret });
  });

  // UDP reachability and throughput both travel through the LOCAL proxy port,
  // so they measure whichever outbound the selector currently points at. The
  // renderer is responsible for selecting the node under test first.
  ipcMain.handle('network:test-udp', async (_event, proxyPort: number) => {
    if (!singboxProcess) return { ok: false, ms: -1, error: 'Core is not running' };
    return await udpProbe({ proxyPort: proxyPort || 7890 });
  });

  ipcMain.handle(
    'network:test-speed',
    async (_event, proxyPort: number, options?: { url?: string; durationMs?: number }) => {
      if (!singboxProcess) return { mbps: 0, bytes: 0, ms: 0, error: 'Core is not running' };
      return await speedProbe({
        proxyPort: proxyPort || 7890,
        url: options?.url,
        durationMs: options?.durationMs,
      });
    }
  );

  // This machine's LAN IPv4 addresses, so the Settings page can tell the user
  // exactly what to point other devices at when LAN sharing is enabled.
  ipcMain.handle('network:get-lan-addresses', () => {
    const out: string[] = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        // Skip loopback, IPv6, and our own TUN adapter. 172.19.0.x is the
        // address we used before moving off Docker/WSL/NekoRay's crowded
        // 172.16/12 space; still filtered so a leftover adapter from an older
        // version isn't offered as a LAN address.
        if (iface.family !== 'IPv4' || iface.internal) continue;
        if (iface.address.startsWith(TUN_IPV4_PREFIX) || iface.address.startsWith('172.19.0.')) continue;
        out.push(iface.address);
      }
    }
    return out;
  });
}

// ==================== Config Generator ====================
// generateSingboxConfig / nodeToOutbound now live in shared/config-generator.cjs
// (single source of truth shared with the web backend in server/index.js).

// ==================== App Lifecycle ====================

// `before-quit`'s listener is NOT awaited by Electron — an async callback
// with no synchronous `event.preventDefault()` lets the app proceed to quit
// immediately, killing the process (and any in-flight PowerShell CTRL_BREAK
// call) before stopSingbox() finishes its graceful shutdown. That silently
// downgraded every quit into the same hard-kill this whole fix was for,
// which is why the WinTun adapter still ended up corrupted on the *next*
// launch even though the in-session stop/reconnect flow worked fine.
// Block the first quit attempt until cleanup is done, then quit for real.
//
// The cleanup is shared with the in-app updater (app-updater.ts), which must
// run exactly these steps BEFORE it starts the installer; the installer's
// app.quit() then passes straight through this handler.
let quitCleanupDone = false;
let quitCleanupPromise: Promise<void> | null = null;

/** Stop the core and clear the system proxy, once; concurrent callers share the run. */
function runQuitCleanup(): Promise<void> {
  // Whoever asks (a quit, the updater's install, the elevation relaunch), the
  // app is going away from here on, so a window close must not just hide.
  isQuitting = true;
  // ...and tray Connect is disabled from now on (D21; buildTrayMenu reads the flag).
  updateTrayMenu(trayConnected);
  if (!quitCleanupPromise) {
    quitCleanupPromise = (async () => {
      try {
        await disconnectCore();
      } finally {
        quitCleanupDone = true;
      }
    })();
  }
  return quitCleanupPromise;
}

/** Forget a finished cleanup, so the next quit runs it again (an update install that didn't go ahead). */
function resetQuitCleanup(): void {
  quitCleanupDone = false;
  quitCleanupPromise = null;
  // The app stays after all, so closing the window hides it again, and tray
  // Connect works again (the updater clears its installing flag first).
  isQuitting = false;
  updateTrayMenu(trayConnected);
}

/**
 * Set once startup has registered the IPC handlers and created the window.
 * 'second-instance' can arrive while startup is still awaiting the store or
 * the system proxy recovery. Showing the window right then would create it
 * before its IPC handlers exist, and startup would create a second one, so
 * such an early launch is only remembered (showWhenStarted) and served at
 * the end of startup.
 */
let startupDone = false;
let showWhenStarted = false;

// Only the primary instance registers lifecycle handlers (D14). A second
// launch quits right after the lock check at the top of this file, and with no
// before-quit handler its quit can't touch this instance's core or proxy.
if (isPrimaryInstance) {
  app.whenReady().then(async () => {
    // Windows ties toasts (the watchdog's give-up notification) to the app's
    // AppUserModelID, which must match its Start menu shortcut (D20). NSIS
    // stamps the installed shortcut with the electron-builder appId; a dev run
    // has no such shortcut, and the exe path is the usual stand-in.
    if (process.platform === 'win32') {
      app.setAppUserModelId(app.isPackaged ? 'com.awesome-proxy' : process.execPath);
    }
    const settingsStore = await getStore(); // Initialize store
    await getMainState();
    // Before any window: put back a system proxy that a crash, a kill or a
    // shutdown left pointing at our (now dead) core. Never blocks startup.
    try {
      const storedPort = settingsStore.get('settings.mixedPort');
      const port = Number.isInteger(storedPort) && storedPort >= 1 && storedPort <= 65535 ? storedPort : 7890;
      await systemProxy.recover({ legacyLeftover: { port } });
    } catch (err: any) {
      addLog(`WARN: System proxy recovery failed: ${err?.message ?? err}`);
    }
    registerIpcHandlers();
    initAppUpdater({
      getWindow: () => mainWindow,
      getProxyPort: getCoreProxyPort,
      prepareForQuit: runQuitCleanup,
      cancelQuitPreparation: resetQuitCleanup,
      // Running, starting, or about to be restarted by the watchdog (D21).
      isCoreActive: () => singboxProcess !== null || isConnecting || watchdogTimer !== null,
      log: addLog,
    });
    // Prime the version cache without holding up the first window: the probe
    // can take seconds while Defender scans a new binary, and both the first
    // config:generate and Settings → About share this one in-flight run.
    void coreVersionProbe.get();
    createWindow();
    createTray();

    const s = await getStore();
    if (s.get('settings.startMinimized')) {
      mainWindow?.hide();
    }
    startupDone = true;
    // A second launch during startup asked for the window; it wins over
    // "Start minimized", like any later second launch.
    if (showWhenStarted) showMainWindow();
  });

  // Someone launched the app again (Start menu, a shortcut, the .vbs
  // launcher): show the running window instead of starting a second app.
  app.on('second-instance', () => {
    if (startupDone) showMainWindow();
    else showWhenStarted = true;
  });

  app.on('window-all-closed', () => {
    // Don't quit on window close - keep running in tray
    if (process.platform !== 'darwin') {
      // App stays in tray
    }
  });

  // macOS only (a dock icon click). Ignored until startup is done, for the
  // reason above; startup creates the window itself.
  app.on('activate', () => {
    if (startupDone) showMainWindow();
  });

  app.on('before-quit', (event) => {
    if (quitCleanupDone) return; // second pass: let it through
    // First pass: once the cleanup quits again, the windows must really close.
    isQuitting = true;
    event.preventDefault();
    void runQuitCleanup()
      .catch((err) => console.error('Quit cleanup failed:', err))
      .then(() => app.quit());
  });
}
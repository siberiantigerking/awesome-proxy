import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec, execFile, spawn, ChildProcess } from 'child_process';
import http from 'http';
import https from 'https';
import net from 'net';
// Shared single-source-of-truth config generator (CommonJS module).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateSingboxConfig } = require('../shared/config-generator.cjs');

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
          remoteDns: 'https://dns.google/dns-query',
          directDns: 'https://dns.alidns.com/dns-query',
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

function createWindow() {
  mainWindow = new BrowserWindow({
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

  // In development, load from Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
 */
function buildTrayMenu(connected: boolean): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: connected ? `🟢 Connected (${MODE_LABELS[currentProxyMode]})` : '🔴 Disconnected',
      enabled: false,
    },
    {
      label: connected ? 'Disconnect' : 'Connect',
      click: () => {
        // Actually connecting needs node selection, elevation handling, and
        // Clash API calls that live in the renderer's connection service —
        // so the tray just asks the renderer to do it, the same way the
        // Dashboard's Connect/Disconnect button does.
        mainWindow?.webContents.send(connected ? 'tray:disconnect' : 'tray:connect');
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

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ==================== sing-box Management ====================

function addLog(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const logLine = `[${timestamp}] ${message}`;
  singboxLogs.push(logLine);
  if (singboxLogs.length > LOG_MAX_LINES) {
    singboxLogs = singboxLogs.slice(-LOG_MAX_LINES);
  }
  mainWindow?.webContents.send('singbox:log', logLine);
}

function startSingbox(configPath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (singboxProcess) {
      resolve({ success: false, error: 'sing-box is already running' });
      return;
    }

    const singboxPath = getSingboxPath();

    if (!fs.existsSync(singboxPath)) {
      const errorMsg = `sing-box binary not found at: ${singboxPath}`;
      addLog(`ERROR: ${errorMsg}`);
      resolve({ success: false, error: errorMsg });
      return;
    }

    if (!fs.existsSync(configPath)) {
      const errorMsg = `Config file not found at: ${configPath}`;
      addLog(`ERROR: ${errorMsg}`);
      resolve({ success: false, error: errorMsg });
      return;
    }

    isConnecting = true;
    addLog('Starting sing-box core...');

    try {
      singboxProcess = spawn(singboxPath, ['run', '-c', configPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let started = false;
      let startupTimer: NodeJS.Timeout;
      const recentLines: string[] = [];
      const STARTED_RE = /sing-box started|server started/i;

      const markStarted = () => {
        if (started) return;
        started = true;
        isConnecting = false;
        mainWindow?.webContents.send('singbox:status-change', 'connected');
        updateTrayMenu(true);
        resolve({ success: true });
        if (startupTimer) clearTimeout(startupTimer);
      };

      const handleLine = (line: string) => {
        addLog(line);
        recentLines.push(line);
        if (recentLines.length > 8) recentLines.shift();
        // Report "connected" only when sing-box actually reports it started,
        // not on the first arbitrary log line (which, in Split mode, is a
        // rule-set download line — causing a false connected→disconnected).
        if (!started && STARTED_RE.test(line)) markStarted();
      };

      singboxProcess.stdout?.on('data', (data: Buffer) => {
        data.toString().split('\n').filter((l: string) => l.trim()).forEach(handleLine);
      });

      singboxProcess.stderr?.on('data', (data: Buffer) => {
        data.toString().split('\n').filter((l: string) => l.trim()).forEach(handleLine);
      });

      singboxProcess.on('error', (err) => {
        addLog(`ERROR: Process error - ${err.message}`);
        singboxProcess = null;
        isConnecting = false;
        mainWindow?.webContents.send('singbox:status-change', 'disconnected');
        updateTrayMenu(false);
        if (!started) {
          if (startupTimer) clearTimeout(startupTimer);
          resolve({ success: false, error: err.message });
        }
      });

      singboxProcess.on('exit', (code, signal) => {
        addLog(`sing-box exited with code ${code}, signal ${signal}`);
        singboxProcess = null;
        isConnecting = false;
        mainWindow?.webContents.send('singbox:status-change', 'disconnected');
        updateTrayMenu(false);
        // If it exited before reporting "started", the start failed — surface
        // the recent log lines (e.g. a FATAL config / rule-set error) instead
        // of a misleading connected→disconnected flicker.
        if (!started) {
          if (startupTimer) clearTimeout(startupTimer);
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
          if (singboxProcess) {
            markStarted();
          } else {
            isConnecting = false;
            resolve({ success: false, error: 'sing-box startup timed out' });
          }
        }
      }, 12000);

    } catch (err: any) {
      addLog(`ERROR: Failed to start sing-box - ${err.message}`);
      singboxProcess = null;
      isConnecting = false;
      resolve({ success: false, error: err.message });
    }
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
  return new Promise((resolve) => {
    if (!singboxProcess) {
      resolve({ success: true });
      return;
    }

    addLog('Stopping sing-box core...');
    const pid = singboxProcess.pid;

    const timeout = setTimeout(() => {
      if (singboxProcess) {
        addLog('sing-box did not exit gracefully in time — forcing termination.');
        singboxProcess.kill('SIGKILL');
        singboxProcess = null;
      }
      mainWindow?.webContents.send('singbox:status-change', 'disconnected');
      updateTrayMenu(false);
      resolve({ success: true });
    }, 5000);

    singboxProcess.on('exit', () => {
      clearTimeout(timeout);
      singboxProcess = null;
      mainWindow?.webContents.send('singbox:status-change', 'disconnected');
      updateTrayMenu(false);
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
      singboxProcess.kill('SIGTERM');
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

  // sing-box exposes cumulative up/down byte counters via the Clash API
  // (enabled in the generated config at 127.0.0.1:9090). We poll the snapshot
  // endpoint once per second and derive per-second speed from the delta.
  let lastUp = 0;
  let lastDown = 0;
  let primed = false;

  trafficInterval = setInterval(() => {
    if (!singboxProcess) return;

    const req = http.get(
      { host: '127.0.0.1', port: 9090, path: '/connections', timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const totalUp = data.uploadTotal || 0;
            const totalDown = data.downloadTotal || 0;

            if (primed) {
              const up = Math.max(0, totalUp - lastUp);
              const down = Math.max(0, totalDown - lastDown);
              mainWindow?.webContents.send('singbox:traffic', { up, down });
            }
            lastUp = totalUp;
            lastDown = totalDown;
            primed = true;
          } catch {
            // Malformed/empty response; skip this tick.
          }
        });
      }
    );
    req.on('error', () => {
      // Clash API not ready yet; skip this tick.
    });
    req.on('timeout', () => req.destroy());
  }, 1000);
}

function stopTrafficMonitoring() {
  if (trafficInterval) {
    clearInterval(trafficInterval);
    trafficInterval = null;
  }
}

// ==================== System Proxy ====================

function sanitizeHost(host: string): string {
  // Only allow valid IP addresses or hostnames
  if (!/^[a-zA-Z0-9.\-:]+$/.test(host)) {
    throw new Error(`Invalid host: ${host}`);
  }
  return host;
}

function enableSystemProxy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Validate inputs to prevent command injection
    host = sanitizeHost(host);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      addLog('Invalid proxy port');
      resolve(false);
      return;
    }
    const proxyServer = `${host}:${port}`;
    const regCommand = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f && reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${proxyServer}" /f`;
    exec(regCommand, (error) => {
      if (error) {
        addLog(`Failed to enable system proxy: ${error.message}`);
        resolve(false);
      } else {
        addLog(`System proxy enabled: ${host}:${port}`);
        resolve(true);
      }
    });
  });
}

function disableSystemProxy(): Promise<boolean> {
  return new Promise((resolve) => {
    const regCommand = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`;
    exec(regCommand, (error) => {
      if (error) {
        addLog(`Failed to disable system proxy: ${error.message}`);
        resolve(false);
      } else {
        addLog('System proxy disabled');
        resolve(true);
      }
    });
  });
}

function getSystemProxyStatus(): Promise<{ enabled: boolean; server: string }> {
  return new Promise((resolve) => {
    exec(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      (error, stdout) => {
        const enabled = stdout?.includes('0x1') ?? false;
        exec(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          (_err, out) => {
            const match = out?.match(/ProxyServer\s+REG_SZ\s+(.+)/);
            resolve({ enabled, server: match?.[1]?.trim() ?? '' });
          }
        );
      }
    );
  });
}

// ==================== Path Validation ====================

/**
 * Validate that a file path is within the app's allowed directories.
 * Prevents arbitrary file system access from the renderer.
 */
function isPathAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const userDataPath = path.resolve(app.getPath('userData'));
  const allowedPaths = [
    userDataPath,
    path.resolve(process.cwd(), 'resources'),
  ];

  return allowedPaths.some((allowed) => resolved.startsWith(allowed));
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

function fetchUrl(url: string, timeout = 10000): Promise<string> {
  // Validate URL to prevent SSRF attacks
  if (!isUrlSafe(url)) {
    return Promise.reject(new Error('Blocked: potentially unsafe URL (internal/private network)'));
  }

  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Switch a selector's active outbound live via the Clash API (no restart).
 * Endpoint: PUT http://127.0.0.1:9090/proxies/{selector} {"name": outbound}
 */
function clashSelect(selector: string, outbound: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: outbound });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 9090,
        path: '/proxies/' + encodeURIComponent(selector),
        method: 'PUT',
        timeout: 3000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        // Clash API returns 204 No Content on success.
        res.resume();
        if (res.statusCode === 204 || res.statusCode === 200) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: 'Clash API returned status ' + res.statusCode });
        }
      }
    );
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Clash API timeout' }); });
    req.write(body);
    req.end();
  });
}

function testLatency(host: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();

    socket.setTimeout(5000);

    socket.on('connect', () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve(latency);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(-1);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(-1);
    });

    socket.connect(port, host);
  });
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
        // Give the elevated instance a moment to spawn, then quit this one.
        // app.exit() bypasses `before-quit` entirely (unlike app.quit()), so
        // the graceful sing-box stop must be awaited explicitly here too —
        // otherwise this path hard-kills sing-box just like the old
        // before-quit bug, corrupting the WinTun adapter for the next launch.
        setTimeout(async () => {
          await stopSingbox();
          app.exit(0);
        }, 800);
      }
    };

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
// jsDelivr / ghproxy mirrors are used as fallbacks when GitHub is unreachable
// (same pattern the rule-set downloads already rely on).
const GH_DOWNLOAD_MIRRORS = [
  (url: string) => url, // direct GitHub
  (url: string) => 'https://ghfast.top/' + url,
  (url: string) => 'https://gh-proxy.com/' + url,
];

/** Return the currently installed sing-box version string, e.g. "1.13.12". */
function getSingboxVersionStr(): Promise<string> {
  return new Promise((resolve) => {
    const singboxPath = getSingboxPath();
    if (!fs.existsSync(singboxPath)) return resolve('0.0.0');
    exec(`"${singboxPath}" version`, (error, stdout) => {
      if (error) return resolve('0.0.0');
      const match = stdout.match(/sing-box version (\S+)/);
      resolve(match ? match[1] : '0.0.0');
    });
  });
}

/** Compare two dotted numeric versions. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** GET a URL and resolve its body as a string (follows redirects, sends UA). */
function httpGetText(url: string, timeout = 15000, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      { timeout, headers: { 'User-Agent': 'AwesomeProxy', Accept: 'application/vnd.github+json' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGetText(res.headers.location, timeout, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

/** Download a URL to a file, reporting fractional progress (0..1). */
function httpDownload(
  url: string,
  destPath: string,
  onProgress?: (fraction: number) => void,
  redirects = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      { timeout: 60000, headers: { 'User-Agent': 'AwesomeProxy' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpDownload(res.headers.location, destPath, onProgress, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const total = parseInt((res.headers['content-length'] as string) || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) onProgress(received / total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (err) => reject(err));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

/** Extract a .zip archive using PowerShell's Expand-Archive (built into Windows). */
function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const cmd = `Expand-Archive -Path ${q(zipPath)} -DestinationPath ${q(destDir)} -Force`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      (err, _stdout, stderr) => {
        if (err) reject(new Error('Extract failed: ' + (stderr || err.message)));
        else resolve();
      }
    );
  });
}

/** Recursively locate a file by name (case-insensitive) within a directory. */
function findFileRecursive(dir: string, name: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function sendUpgradeProgress(data: { stage: string; percent?: number; message?: string }) {
  mainWindow?.webContents.send('singbox:upgrade-progress', data);
}

interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  downloadUrl: string;
  notes: string;
}

/** Query the GitHub releases API for the latest sing-box release and compare. */
async function checkSingboxUpdate(): Promise<UpdateInfo> {
  const current = await getSingboxVersionStr();
  const raw = await httpGetText(SINGBOX_RELEASES_API);
  const data = JSON.parse(raw);
  const tag: string = data.tag_name || '';
  const latest = tag.replace(/^v/, '');
  // Prefer the plain windows-amd64 asset (exclude amd64v3 / legacy variants).
  const assets: any[] = Array.isArray(data.assets) ? data.assets : [];
  const asset = assets.find((a) => /-windows-amd64\.zip$/.test(a.name || ''));
  const downloadUrl = asset
    ? asset.browser_download_url
    : `https://github.com/SagerNet/sing-box/releases/download/${tag}/sing-box-${latest}-windows-amd64.zip`;
  return {
    current,
    latest,
    hasUpdate: latest ? compareVersions(latest, current) > 0 : false,
    downloadUrl,
    notes: data.body || '',
  };
}

/**
 * Download the latest sing-box release, replace the bundled binary, and report
 * progress to the renderer. Stops the running core first (Windows file lock).
 */
async function upgradeSingboxCore(): Promise<{
  success: boolean;
  upgraded?: boolean;
  current?: string;
  latest?: string;
  error?: string;
}> {
  sendUpgradeProgress({ stage: 'checking' });
  const info = await checkSingboxUpdate();
  if (!info.hasUpdate) {
    return { success: true, upgraded: false, current: info.current, latest: info.latest };
  }

  const tmpDir = app.getPath('temp');
  const zipPath = path.join(tmpDir, `sing-box-${info.latest}.zip`);
  const extractDir = path.join(tmpDir, `sing-box-${info.latest}-extract`);

  // Download with mirror fallback (GitHub is frequently blocked in some regions).
  sendUpgradeProgress({ stage: 'downloading', percent: 0 });
  let downloaded = false;
  let lastErr: Error | null = null;
  for (const mirror of GH_DOWNLOAD_MIRRORS) {
    try {
      await httpDownload(mirror(info.downloadUrl), zipPath, (f) =>
        sendUpgradeProgress({ stage: 'downloading', percent: Math.round(f * 100) })
      );
      downloaded = true;
      break;
    } catch (err: any) {
      lastErr = err;
      try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    }
  }
  if (!downloaded) {
    return { success: false, error: 'Download failed: ' + (lastErr?.message || 'unknown error') };
  }

  // Extract.
  sendUpgradeProgress({ stage: 'extracting' });
  try {
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    await extractZip(zipPath, extractDir);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  const newExe = findFileRecursive(extractDir, 'sing-box.exe');
  if (!newExe) {
    return { success: false, error: 'sing-box.exe not found in the downloaded archive' };
  }

  // Stop the running core so we can replace the (locked) file, then swap it in.
  sendUpgradeProgress({ stage: 'installing' });
  stopTrafficMonitoring();
  await stopSingbox();

  const target = getSingboxPath();
  const backup = target + '.bak';
  try {
    if (fs.existsSync(target)) fs.copyFileSync(target, backup);
    fs.copyFileSync(newExe, target);
  } catch (err: any) {
    // Restore the backup if the swap failed midway.
    try { if (fs.existsSync(backup)) fs.copyFileSync(backup, target); } catch { /* ignore */ }
    const perm = err.code === 'EPERM' || err.code === 'EACCES';
    return {
      success: false,
      error: 'Failed to replace binary: ' + err.message + (perm ? ' — try restarting the app as administrator.' : ''),
    };
  }

  // Best-effort cleanup.
  try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(backup, { force: true }); } catch { /* ignore */ }

  const newVer = await getSingboxVersionStr();
  sendUpgradeProgress({ stage: 'done' });
  return { success: true, upgraded: true, current: newVer, latest: info.latest };
}

// ==================== IPC Handlers ====================

function registerIpcHandlers() {
  // sing-box management
  ipcMain.handle('singbox:start', async (_event, configPath: string) => {
    const result = await startSingbox(configPath || getConfigPath());
    if (result.success) startTrafficMonitoring();
    return result;
  });

  ipcMain.handle('singbox:stop', async () => {
    stopTrafficMonitoring();
    return await stopSingbox();
  });

  ipcMain.handle('singbox:restart', async (_event, configPath: string) => {
    stopTrafficMonitoring();
    await stopSingbox();
    const result = await startSingbox(configPath || getConfigPath());
    if (result.success) startTrafficMonitoring();
    return result;
  });

  ipcMain.handle('singbox:status', () => {
    if (isConnecting) return 'connecting';
    return singboxProcess ? 'connected' : 'disconnected';
  });

  ipcMain.handle('singbox:version', async () => {
    const singboxPath = getSingboxPath();
    return new Promise((resolve) => {
      exec(`"${singboxPath}" version`, (error, stdout) => {
        if (error) {
          resolve('Not found');
        } else {
          const match = stdout.match(/sing-box version (\S+)/);
          resolve(match ? match[1] : stdout.trim());
        }
      });
    });
  });

  ipcMain.handle('singbox:logs', () => {
    return singboxLogs;
  });

  ipcMain.handle('singbox:clear-logs', () => {
    singboxLogs = [];
    return true;
  });

  // Live-switch a selector's active outbound via the Clash API (no restart).
  ipcMain.handle('singbox:select', async (_event, selector: string, outbound: string) => {
    return await clashSelect(selector, outbound);
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
      return { success: true, ...(await checkSingboxUpdate()) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Download and install the latest sing-box core (one-key upgrade).
  ipcMain.handle('singbox:upgrade', async () => {
    try {
      return await upgradeSingboxCore();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Configuration
  ipcMain.handle('config:generate', (_event, nodes, selectedIndex, settings) => {
    return generateSingboxConfig(nodes, selectedIndex, settings);
  });

  ipcMain.handle('config:write', (_event, config) => {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return configPath;
  });

  ipcMain.handle('config:read', () => {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    return null;
  });

  // System proxy
  ipcMain.handle('system-proxy:enable', async (_event, host, port) => {
    return await enableSystemProxy(host, port);
  });

  ipcMain.handle('system-proxy:disable', async () => {
    return await disableSystemProxy();
  });

  ipcMain.handle('system-proxy:status', async () => {
    return await getSystemProxyStatus();
  });

  // File operations
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

  ipcMain.handle('file:read-text', (_event, filePath: string) => {
    return fs.readFileSync(filePath, 'utf-8');
  });

  ipcMain.handle('file:write-text', (_event, filePath: string, content: string) => {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
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
}

// ==================== Config Generator ====================
// generateSingboxConfig / nodeToOutbound now live in shared/config-generator.cjs
// (single source of truth shared with the web backend in server/index.js).

// ==================== App Lifecycle ====================

app.whenReady().then(async () => {
  await getStore(); // Initialize store
  registerIpcHandlers();
  createWindow();
  createTray();

  const s = await getStore();
  if (s.get('settings.startMinimized')) {
    mainWindow?.hide();
  }
});

app.on('window-all-closed', () => {
  // Don't quit on window close - keep running in tray
  if (process.platform !== 'darwin') {
    // App stays in tray
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// `before-quit`'s listener is NOT awaited by Electron — an async callback
// with no synchronous `event.preventDefault()` lets the app proceed to quit
// immediately, killing the process (and any in-flight PowerShell CTRL_BREAK
// call) before stopSingbox() finishes its graceful shutdown. That silently
// downgraded every quit into the same hard-kill this whole fix was for,
// which is why the WinTun adapter still ended up corrupted on the *next*
// launch even though the in-session stop/reconnect flow worked fine.
// Block the first quit attempt until cleanup is done, then quit for real.
let quitCleanupDone = false;
app.on('before-quit', (event) => {
  if (quitCleanupDone) return; // second pass: let it through
  event.preventDefault();
  (async () => {
    stopTrafficMonitoring();
    await stopSingbox();
    await disableSystemProxy();
    quitCleanupDone = true;
    app.quit();
  })();
});
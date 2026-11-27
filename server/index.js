/**
 * Standalone backend server for SingBox Proxy Manager
 * Manages sing-box binary, config files, system proxy, and provides REST API + WebSocket.
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { generateSingboxConfig } = require('../shared/config-generator.cjs');
// Node test probes, shared with the Electron main process so both modes report
// identical numbers.
const { tcpPing, clashDelay, udpProbe, speedProbe } = require('../shared/node-probes.cjs');
// sing-box version probe, shared with the Electron main process (compat R1).
const { createCoreVersionProbe } = require('../shared/core-version.cjs');
// The one Clash API client (audit P0-1), shared with the Electron main process.
const {
  createClashApiCredentials,
  writeConfigWithClashApi,
  isControllerListenError,
  clashSelect,
  clashConnectionTotals,
} = require('../shared/clash-client.cjs');
// Crash-safe Windows system proxy (audit P0-2), shared with the Electron main process.
const { createSystemProxy } = require('../shared/system-proxy.cjs');

const isValidPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ==================== Security: origin / CORS ====================
// This backend exposes privileged operations (system proxy, process control,
// arbitrary URL fetch). It must only ever be reachable from the local app UI,
// never from arbitrary websites the user happens to be visiting.
const ALLOWED_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser (curl, Vite proxy) sends no Origin
  try {
    const { hostname } = new URL(origin);
    return ALLOWED_ORIGIN_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
  })
);

// Reject any request whose Origin is a remote site, even for "simple" requests
// that CORS would otherwise allow the side effects of (CSRF hardening).
app.use((req, res, next) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// ==================== State ====================
let singboxProcess = null;
let singboxLogs = [];
let isConnecting = false;
const LOG_MAX_LINES = 1000;
const clients = new Set();

// Config & paths
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(process.env.HOME || '', '.config'), 'singbox-proxy-manager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'sing-box-config.json');
const STORE_FILE = path.join(CONFIG_DIR, 'store.json');

if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// ==================== Store ====================
function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveStore(data) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getStore(key) {
  return loadStore()[key];
}

function setStore(key, value) {
  const data = loadStore();
  data[key] = value;
  saveStore(data);
}

function deleteStore(key) {
  const data = loadStore();
  delete data[key];
  saveStore(data);
}

// ==================== sing-box Path ====================
function getSingboxPath() {
  const candidates = [
    path.join(__dirname, '..', 'resources', 'bin', 'sing-box.exe'),
    path.join(__dirname, '..', 'resources', 'bin', 'sing-box'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try PATH
  return 'sing-box';
}

// ==================== WebSocket ====================
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

wss.on('connection', (ws, req) => {
  // Reject WebSocket upgrades originating from remote websites.
  if (!isAllowedOrigin(req.headers.origin)) {
    ws.close(1008, 'Forbidden origin');
    return;
  }
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

// ==================== Logging ====================
function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const logLine = '[' + timestamp + '] ' + message;
  singboxLogs.push(logLine);
  if (singboxLogs.length > LOG_MAX_LINES) {
    singboxLogs = singboxLogs.slice(-LOG_MAX_LINES);
  }
  broadcast('singbox:log', logLine);
}

// ==================== sing-box Management ====================
// Mirrors electron/main.ts: the Clash API gets a random loopback port and a
// per-start secret (audit P0-1), written into CONFIG_FILE right before each
// spawn. Held only here — never sent to the browser and never logged.
let clashApi = null;

// Set by every stopSingbox(); a start pausing before its controller-port retry
// gives up when it sees this.
let stopRequested = false;

const CONTROLLER_RETRY_DELAY_MS = 800;

// Always the server's own config file: it is rewritten before every spawn, so
// accepting a caller-supplied path would turn the start route into a write
// primitive.
async function startSingbox() {
  const configPath = CONFIG_FILE;
  // isConnecting covers the async gaps (credential allocation, retry pause)
  // in which singboxProcess is still null.
  if (singboxProcess || isConnecting) {
    return { success: false, error: 'sing-box is already running' };
  }
  stopRequested = false;

  const singboxPath = getSingboxPath();

  if (!fs.existsSync(configPath)) {
    const errorMsg = 'Config file not found at: ' + configPath;
    addLog('ERROR: ' + errorMsg);
    return { success: false, error: errorMsg };
  }

  // Check binary exists
  if (singboxPath !== 'sing-box' && !fs.existsSync(singboxPath)) {
    const errorMsg = 'sing-box binary not found at: ' + singboxPath + '. Please place sing-box.exe in resources/bin/';
    addLog('ERROR: ' + errorMsg);
    return { success: false, error: errorMsg };
  }

  isConnecting = true;
  let attempt = await attemptCoreStart(singboxPath, configPath);

  if (attempt.controllerPortBusy) {
    // Something grabbed the port between picking it and sing-box binding it:
    // new port, new secret, exactly one more try.
    addLog("sing-box couldn't open its local control port (127.0.0.1:" + attempt.port + '); retrying on another port.');
    await new Promise((r) => setTimeout(r, CONTROLLER_RETRY_DELAY_MS));
    if (stopRequested) {
      isConnecting = false;
      broadcast('singbox:status-change', 'disconnected');
      return { success: false, error: 'Connecting was cancelled.' };
    }
    attempt = await attemptCoreStart(singboxPath, configPath);
    if (attempt.controllerPortBusy) {
      const errorMsg =
        "sing-box couldn't open its local control port (127.0.0.1:" + attempt.port + ') because another program is using it. ' +
        'Close that program and connect again.';
      addLog('ERROR: ' + errorMsg);
      isConnecting = false;
      broadcast('singbox:status-change', 'disconnected');
      return { success: false, error: errorMsg };
    }
  }

  if (!attempt.success && !singboxProcess) isConnecting = false;
  return attempt.success ? { success: true } : { success: false, error: attempt.error };
}

async function attemptCoreStart(singboxPath, configPath) {
  let creds;
  try {
    creds = await createClashApiCredentials();
    writeConfigWithClashApi(configPath, creds);
  } catch (err) {
    const errorMsg = 'Could not prepare the sing-box config: ' + err.message;
    addLog('ERROR: ' + errorMsg);
    return { success: false, error: errorMsg };
  }
  clashApi = creds;
  addLog('Starting sing-box core...');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(singboxPath, ['run', '-c', configPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      singboxProcess = child;
    } catch (err) {
      addLog('ERROR: Failed to start sing-box - ' + err.message);
      singboxProcess = null;
      clashApi = null;
      isConnecting = false;
      resolve({ success: false, error: err.message });
      return;
    }

    let started = false;
    let controllerPortBusy = false;
    let startupTimer;
    const recentLines = [];
    const STARTED_RE = /sing-box started|server started/i;

    // Child guard: only touch global core state while this child is still the
    // core, so a late exit from an earlier, killed core can't clobber the next.
    const isCurrent = () => singboxProcess === child;

    const markStarted = () => {
      if (started) return;
      started = true;
      isConnecting = false;
      broadcast('singbox:status-change', 'connected');
      resolve({ success: true });
      if (startupTimer) clearTimeout(startupTimer);
    };

    const handleLine = (line) => {
      addLog(line);
      recentLines.push(line);
      if (recentLines.length > 8) recentLines.shift();
      if (!started && isControllerListenError(line)) controllerPortBusy = true;
      if (!started && STARTED_RE.test(line) && isCurrent()) markStarted();
    };

    child.stdout.on('data', (data) => {
      data.toString().split('\n').filter((l) => l.trim()).forEach(handleLine);
    });

    child.stderr.on('data', (data) => {
      data.toString().split('\n').filter((l) => l.trim()).forEach(handleLine);
    });

    child.on('error', (err) => {
      addLog('ERROR: Process error - ' + err.message);
      if (isCurrent()) {
        singboxProcess = null;
        clashApi = null;
        isConnecting = false;
        broadcast('singbox:status-change', 'disconnected');
      }
      if (!started) {
        if (startupTimer) clearTimeout(startupTimer);
        resolve({ success: false, error: err.message });
      }
    });

    child.on('exit', (code, signal) => {
      addLog('sing-box exited with code ' + code + ', signal ' + signal);
      // A controller-port race is retried by startSingbox, which reports
      // "disconnected" itself only if it gives up.
      const retryable = !started && controllerPortBusy;
      if (isCurrent()) {
        singboxProcess = null;
        clashApi = null;
        if (!retryable) {
          isConnecting = false;
          broadcast('singbox:status-change', 'disconnected');
        }
      }
      if (!started) {
        if (startupTimer) clearTimeout(startupTimer);
        if (retryable) {
          resolve({ success: false, controllerPortBusy: true, port: creds.port });
          return;
        }
        const errLines = recentLines.filter((l) => /fatal|error/i.test(l)).slice(-3).join(' | ')
          || recentLines.slice(-3).join(' | ')
          || ('exited with code ' + code);
        resolve({ success: false, error: 'sing-box failed to start: ' + errLines });
      }
    });

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

function stopSingbox() {
  stopRequested = true;
  return new Promise((resolve) => {
    const child = singboxProcess;
    if (!child) {
      resolve({ success: true });
      return;
    }

    addLog('Stopping sing-box core...');
    let settled = false;

    const timeout = setTimeout(() => {
      settled = true;
      if (singboxProcess === child) {
        child.kill('SIGKILL');
        singboxProcess = null;
        clashApi = null;
      }
      if (!singboxProcess) broadcast('singbox:status-change', 'disconnected');
      resolve({ success: true });
    }, 5000);

    child.on('exit', () => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (singboxProcess === child) {
        singboxProcess = null;
        clashApi = null;
      }
      if (!singboxProcess) broadcast('singbox:status-change', 'disconnected');
      addLog('sing-box stopped.');
      resolve({ success: true });
    });

    child.kill('SIGTERM');
  });
}

// ==================== Traffic Monitoring ====================
// Poll sing-box's Clash API (on the running core's per-start port, see
// clashApi) and derive per-second speed from the cumulative counters.
let trafficInterval = null;

function startTrafficMonitoring() {
  if (trafficInterval) return;
  let lastUp = 0;
  let lastDown = 0;
  let primed = false;

  trafficInterval = setInterval(() => {
    if (!singboxProcess || !clashApi) return;
    clashConnectionTotals(clashApi).then((totals) => {
      // Not ready yet or a malformed response: skip this tick.
      if (!totals) return;
      const totalUp = totals.uploadTotal;
      const totalDown = totals.downloadTotal;
      if (primed) {
        broadcast('singbox:traffic', {
          up: Math.max(0, totalUp - lastUp),
          down: Math.max(0, totalDown - lastDown),
        });
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

// ==================== Security: URL validation (SSRF protection) ====================
/**
 * Validate that a URL is safe to fetch from the backend.
 * Blocks non-http(s) protocols, embedded credentials, and internal/private
 * network targets to prevent the fetch endpoint being abused as an SSRF proxy.
 */
function isUrlSafe(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;

    const host = parsed.hostname.toLowerCase();
    const blockedHosts = ['localhost', '0.0.0.0', '[::1]', '[::]', '::1'];
    if (blockedHosts.includes(host)) return false;

    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [b1, b2] = [parseInt(ipv4[1]), parseInt(ipv4[2])];
      if (
        b1 === 10 ||
        (b1 === 172 && b2 >= 16 && b2 <= 31) ||
        (b1 === 192 && b2 === 168) ||
        (b1 === 169 && b2 === 254) ||
        b1 === 0 ||
        b1 === 127
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ==================== System Proxy ====================
// Registry logic is shared with the Electron main process (audit P0-2): a
// snapshot is saved before every enable and put back on disable / the next
// start, only while the proxy is still ours. The marker lives in its own file,
// which /api/store doesn't serve, so a page can't forge what gets restored.
const SYSTEM_PROXY_MARKER_FILE = path.join(CONFIG_DIR, 'system-proxy-ownership.json');

const systemProxy = createSystemProxy({
  markerStore: {
    get() {
      try {
        return JSON.parse(fs.readFileSync(SYSTEM_PROXY_MARKER_FILE, 'utf-8'));
      } catch {
        return null;
      }
    },
    set(marker) {
      fs.writeFileSync(SYSTEM_PROXY_MARKER_FILE, JSON.stringify(marker, null, 2), 'utf-8');
    },
    clear() {
      fs.rmSync(SYSTEM_PROXY_MARKER_FILE, { force: true });
    },
  },
  log: addLog,
});

// ==================== REST API ====================

// start / restart ignore req.body.configPath: see startSingbox.
app.post('/api/singbox/start', async (_req, res) => {
  const result = await startSingbox();
  if (result.success) startTrafficMonitoring();
  res.json(result);
});

app.post('/api/singbox/stop', async (_req, res) => {
  stopTrafficMonitoring();
  res.json(await stopSingbox());
});

app.post('/api/singbox/restart', async (_req, res) => {
  stopTrafficMonitoring();
  await stopSingbox();
  const result = await startSingbox();
  if (result.success) startTrafficMonitoring();
  res.json(result);
});

app.get('/api/singbox/status', (_req, res) => {
  res.json({ status: isConnecting ? 'connecting' : (singboxProcess ? 'connected' : 'disconnected') });
});

app.get('/api/singbox/version', async (_req, res) => {
  res.json({ version: (await coreVersionProbe.get()) ?? 'Not found' });
});

app.get('/api/singbox/logs', (_req, res) => {
  res.json({ logs: singboxLogs });
});

app.post('/api/singbox/clear-logs', (_req, res) => {
  singboxLogs = [];
  res.json({ success: true });
});

// Live-switch a selector's active outbound via the Clash API (no restart).
app.post('/api/singbox/select', async (req, res) => {
  const { selector, outbound } = req.body || {};
  if (typeof selector !== 'string' || typeof outbound !== 'string') {
    return res.json({ success: false, error: 'Invalid selector/outbound' });
  }
  if (!clashApi) return res.json({ success: false, error: 'sing-box is not running' });
  res.json(await clashSelect(clashApi, selector, outbound));
});

// Core update endpoints. In web/server mode the binary lives outside the app
// bundle and swapping it is out of scope, so we report a clear message rather
// than attempt an in-place upgrade. The desktop app performs the real upgrade.
app.get('/api/singbox/check-update', (_req, res) => {
  res.json({ success: false, error: 'Core upgrade is only available in the desktop app.' });
});

app.post('/api/singbox/upgrade', (_req, res) => {
  res.json({ success: false, error: 'Core upgrade is only available in the desktop app.' });
});

/**
 * sing-box version, used to decide which config surface to generate.
 *
 * Some fields only exist in newer cores and are rejected outright by older ones
 * ("json: unknown field ..."), so the generator has to know what it is talking
 * to. Cached because config generation happens on every connect; a failed
 * probe is not cached, so a slow first run can't pin the oldest surface for
 * the whole session (compat R1).
 */
const coreVersionProbe = createCoreVersionProbe({ getBinaryPath: getSingboxPath, log: addLog });

app.post('/api/config/generate', async (req, res) => {
  const { nodes, selectedIndex, settings } = req.body;
  // An unreadable core gets the oldest supported surface for this one config.
  const coreVersion = (await coreVersionProbe.get()) ?? '0.0.0';
  // clashApi: undefined — the browser-facing config never carries a
  // controller; startSingbox injects the real credentials into the file.
  res.json({ config: generateSingboxConfig(nodes, selectedIndex, { ...settings, clashApi: undefined, coreVersion }) });
});

app.post('/api/config/write', (req, res) => {
  const { config } = req.body;
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Invalid config payload' });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  res.json({ path: CONFIG_FILE });
});

// enable accepts only 127.0.0.1 / localhost and a valid port (D12).
app.post('/api/system-proxy/enable', async (req, res) => {
  const { host, port } = req.body || {};
  res.json({ success: await systemProxy.enable(host, port) });
});

app.post('/api/system-proxy/disable', async (_req, res) => {
  res.json({ success: await systemProxy.disable() });
});

app.get('/api/system-proxy/status', async (_req, res) => {
  res.json(await systemProxy.status());
});

app.get('/api/store/:key', (req, res) => {
  res.json({ value: getStore(req.params.key) });
});

app.put('/api/store/:key', (req, res) => {
  setStore(req.params.key, req.body.value);
  res.json({ success: true });
});

app.delete('/api/store/:key', (req, res) => {
  deleteStore(req.params.key);
  res.json({ success: true });
});

app.get('/api/app/version', (_req, res) => {
  res.json({ version: '1.0.0' });
});

app.get('/api/app/platform', (_req, res) => {
  res.json({ platform: process.platform });
});

app.post('/api/network/fetch-url', async (req, res) => {
  try {
    const { url, timeout = 10000 } = req.body;
    if (typeof url !== 'string' || !isUrlSafe(url)) {
      return res.json({ error: 'Blocked: invalid or unsafe URL (internal/private network not allowed)' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      // A User-Agent is required: many subscription providers sit behind a WAF
      // that 403s UA-less requests. Identify as clash/mihomo-compatible so
      // panels that switch format by UA return YAML/link-list (which we can
      // parse) rather than sing-box JSON (which we cannot).
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'AwesomeProxy/1.0.0 (compatible; clash; mihomo)',
          Accept: '*/*',
        },
      });
      if (!response.ok) {
        return res.json({ error: `HTTP ${response.status} from subscription server` });
      }
      res.json({ data: await response.text() });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/api/network/test-latency', async (req, res) => {
  const { host, port } = req.body || {};
  if (typeof host !== 'string' || !/^[a-zA-Z0-9.\-:]+$/.test(host)) {
    return res.json({ latency: -1 });
  }
  if (!isValidPort(port)) {
    return res.json({ latency: -1 });
  }
  res.json({ latency: await tcpPing(host, port, 5000) });
});

// Real latency through one specific outbound, timed by sing-box itself.
app.post('/api/network/test-delay', async (req, res) => {
  const { tag, url, timeout } = req.body || {};
  if (typeof tag !== 'string' || !tag) return res.json({ latency: -1 });
  if (url !== undefined && typeof url !== 'string') return res.json({ latency: -1 });
  if (!singboxProcess || !clashApi) return res.json({ latency: -1 });
  const latency = await clashDelay({
    tag,
    url,
    timeout: Number.isInteger(timeout) ? timeout : 5000,
    port: clashApi.port,
    secret: clashApi.secret,
  });
  res.json({ latency });
});

// UDP reachability and throughput both go through the LOCAL proxy port, so they
// describe whichever outbound the selector currently points at. The caller is
// responsible for selecting the node under test first.
app.post('/api/network/test-udp', async (req, res) => {
  const { proxyPort } = req.body || {};
  if (!isValidPort(proxyPort)) return res.json({ ok: false, ms: -1, error: 'Invalid proxy port' });
  res.json(await udpProbe({ proxyPort }));
});

app.post('/api/network/test-speed', async (req, res) => {
  const { proxyPort, url, durationMs } = req.body || {};
  if (!isValidPort(proxyPort)) {
    return res.json({ mbps: 0, bytes: 0, ms: 0, error: 'Invalid proxy port' });
  }
  if (url !== undefined && typeof url !== 'string') {
    return res.json({ mbps: 0, bytes: 0, ms: 0, error: 'Invalid speed test URL' });
  }
  res.json(
    await speedProbe({
      proxyPort,
      url,
      // Clamp so a crafted request can't pin the server on a download.
      durationMs: Number.isInteger(durationMs) ? Math.min(Math.max(durationMs, 1000), 15000) : 8000,
    })
  );
});

// ==================== Config Generator ====================
// generateSingboxConfig / nodeToOutbound now live in shared/config-generator.cjs
// (single source of truth shared with the Electron main process).

// ==================== Graceful Shutdown ====================
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await stopSingbox();
  await systemProxy.disable();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await stopSingbox();
  await systemProxy.disable();
  process.exit(0);
});

// ==================== Start ====================
const PORT = parseInt(process.env.PORT || '3456');
// Bind to loopback only. This server controls system proxy settings and the
// sing-box process, so it must never be exposed on the LAN/public interfaces.
const HOST = process.env.HOST || '127.0.0.1';
// Before serving anything: put back a system proxy that a crash or kill of a
// previous run left pointing at its dead core. Without a marker file this
// reads nothing. recover() never rejects; the then() keeps startup unconditional.
systemProxy.recover().then((result) => {
  addLog('System proxy recovery at startup: ' + result);
}).then(() => server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Awesome Proxy Backend');
  console.log('  +-- REST API:  http://' + HOST + ':' + PORT + '/api');
  console.log('  +-- WebSocket: ws://' + HOST + ':' + PORT);
  console.log('  +-- Config:    ' + CONFIG_DIR);
  console.log('  +-- sing-box:  ' + getSingboxPath());
  console.log('');
  // Prime the version cache so the first connect doesn't wait on the probe.
  void coreVersionProbe.get();
}));
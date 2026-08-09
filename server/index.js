/**
 * Standalone backend server for SingBox Proxy Manager
 * Manages sing-box binary, config files, system proxy, and provides REST API + WebSocket.
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { generateSingboxConfig } = require('../shared/config-generator.cjs');
// Node test probes, shared with the Electron main process so both modes report
// identical numbers.
const { tcpPing, clashDelay, udpProbe, speedProbe } = require('../shared/node-probes.cjs');

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
function startSingbox(configPath) {
  return new Promise((resolve) => {
    if (singboxProcess) {
      resolve({ success: false, error: 'sing-box is already running' });
      return;
    }

    const singboxPath = getSingboxPath();

    if (!fs.existsSync(configPath)) {
      const errorMsg = 'Config file not found at: ' + configPath;
      addLog('ERROR: ' + errorMsg);
      resolve({ success: false, error: errorMsg });
      return;
    }

    // Check binary exists
    if (singboxPath !== 'sing-box' && !fs.existsSync(singboxPath)) {
      const errorMsg = 'sing-box binary not found at: ' + singboxPath + '. Please place sing-box.exe in resources/bin/';
      addLog('ERROR: ' + errorMsg);
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
      let startupTimer;
      const recentLines = [];
      const STARTED_RE = /sing-box started|server started/i;

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
        if (!started && STARTED_RE.test(line)) markStarted();
      };

      singboxProcess.stdout.on('data', (data) => {
        data.toString().split('\n').filter((l) => l.trim()).forEach(handleLine);
      });

      singboxProcess.stderr.on('data', (data) => {
        data.toString().split('\n').filter((l) => l.trim()).forEach(handleLine);
      });

      singboxProcess.on('error', (err) => {
        addLog('ERROR: Process error - ' + err.message);
        singboxProcess = null;
        isConnecting = false;
        broadcast('singbox:status-change', 'disconnected');
        if (!started) {
          if (startupTimer) clearTimeout(startupTimer);
          resolve({ success: false, error: err.message });
        }
      });

      singboxProcess.on('exit', (code, signal) => {
        addLog('sing-box exited with code ' + code + ', signal ' + signal);
        singboxProcess = null;
        isConnecting = false;
        broadcast('singbox:status-change', 'disconnected');
        if (!started) {
          if (startupTimer) clearTimeout(startupTimer);
          const errLines = recentLines.filter((l) => /fatal|error/i.test(l)).slice(-3).join(' | ')
            || recentLines.slice(-3).join(' | ')
            || ('exited with code ' + code);
          resolve({ success: false, error: 'sing-box failed to start: ' + errLines });
        }
      });

      startupTimer = setTimeout(() => {
        if (!started) {
          isConnecting = false;
          if (singboxProcess) {
            markStarted();
          } else {
            resolve({ success: false, error: 'sing-box startup timed out' });
          }
        }
      }, 12000);
    } catch (err) {
      addLog('ERROR: Failed to start sing-box - ' + err.message);
      singboxProcess = null;
      isConnecting = false;
      resolve({ success: false, error: err.message });
    }
  });
}

function stopSingbox() {
  return new Promise((resolve) => {
    if (!singboxProcess) {
      resolve({ success: true });
      return;
    }

    addLog('Stopping sing-box core...');

    const timeout = setTimeout(() => {
      if (singboxProcess) {
        singboxProcess.kill('SIGKILL');
        singboxProcess = null;
      }
      broadcast('singbox:status-change', 'disconnected');
      resolve({ success: true });
    }, 5000);

    singboxProcess.on('exit', () => {
      clearTimeout(timeout);
      singboxProcess = null;
      broadcast('singbox:status-change', 'disconnected');
      addLog('sing-box stopped.');
      resolve({ success: true });
    });

    singboxProcess.kill('SIGTERM');
  });
}

// ==================== Traffic Monitoring ====================
// Poll sing-box's Clash API (enabled in the generated config on
// 127.0.0.1:9090) and derive per-second speed from the cumulative counters.
let trafficInterval = null;

function startTrafficMonitoring() {
  if (trafficInterval) return;
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
              broadcast('singbox:traffic', {
                up: Math.max(0, totalUp - lastUp),
                down: Math.max(0, totalDown - lastDown),
              });
            }
            lastUp = totalUp;
            lastDown = totalDown;
            primed = true;
          } catch {
            // ignore malformed responses
          }
        });
      }
    );
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
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
function sanitizeHost(host) {
  if (!/^[a-zA-Z0-9.\-:]+$/.test(host)) {
    throw new Error('Invalid host: ' + host);
  }
  return host;
}

function enableSystemProxy(host, port) {
  return new Promise((resolve) => {
    host = sanitizeHost(host);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      addLog('Invalid proxy port');
      resolve(false);
      return;
    }
    const proxyServer = host + ':' + port;
    const regCommand = 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f && reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "' + proxyServer + '" /f';
    exec(regCommand, (error) => {
      if (error) {
        addLog('Failed to enable system proxy: ' + error.message);
        resolve(false);
      } else {
        addLog('System proxy enabled: ' + host + ':' + port);
        resolve(true);
      }
    });
  });
}

function disableSystemProxy() {
  return new Promise((resolve) => {
    const regCommand = 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f';
    exec(regCommand, (error) => {
      if (error) {
        addLog('Failed to disable system proxy: ' + error.message);
        resolve(false);
      } else {
        addLog('System proxy disabled');
        resolve(true);
      }
    });
  });
}

function getSystemProxyStatus() {
  return new Promise((resolve) => {
    exec('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', (error, stdout) => {
      const enabled = (stdout || '').includes('0x1');
      exec('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', (_err, out) => {
        const match = (out || '').match(/ProxyServer\s+REG_SZ\s+(.+)/);
        resolve({ enabled, server: match ? match[1].trim() : '' });
      });
    });
  });
}

// ==================== REST API ====================

app.post('/api/singbox/start', async (req, res) => {
  const configPath = req.body.configPath || CONFIG_FILE;
  const result = await startSingbox(configPath);
  if (result.success) startTrafficMonitoring();
  res.json(result);
});

app.post('/api/singbox/stop', async (_req, res) => {
  stopTrafficMonitoring();
  res.json(await stopSingbox());
});

app.post('/api/singbox/restart', async (req, res) => {
  const configPath = req.body.configPath || CONFIG_FILE;
  stopTrafficMonitoring();
  await stopSingbox();
  const result = await startSingbox(configPath);
  if (result.success) startTrafficMonitoring();
  res.json(result);
});

app.get('/api/singbox/status', (_req, res) => {
  res.json({ status: isConnecting ? 'connecting' : (singboxProcess ? 'connected' : 'disconnected') });
});

app.get('/api/singbox/version', (_req, res) => {
  const singboxPath = getSingboxPath();
  exec('"' + singboxPath + '" version', (error, stdout) => {
    if (error) res.json({ version: 'Not found' });
    else {
      const match = (stdout || '').match(/sing-box version (\S+)/);
      res.json({ version: match ? match[1] : (stdout || '').trim() });
    }
  });
});

app.get('/api/singbox/logs', (_req, res) => {
  res.json({ logs: singboxLogs });
});

app.post('/api/singbox/clear-logs', (_req, res) => {
  singboxLogs = [];
  res.json({ success: true });
});

// Live-switch a selector's active outbound via the Clash API (no restart).
app.post('/api/singbox/select', (req, res) => {
  const { selector, outbound } = req.body || {};
  if (typeof selector !== 'string' || typeof outbound !== 'string') {
    return res.json({ success: false, error: 'Invalid selector/outbound' });
  }
  const body = JSON.stringify({ name: outbound });
  const reqClash = http.request(
    {
      host: '127.0.0.1',
      port: 9090,
      path: '/proxies/' + encodeURIComponent(selector),
      method: 'PUT',
      timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    },
    (clashRes) => {
      clashRes.resume();
      if (clashRes.statusCode === 204 || clashRes.statusCode === 200) {
        res.json({ success: true });
      } else {
        res.json({ success: false, error: 'Clash API returned status ' + clashRes.statusCode });
      }
    }
  );
  reqClash.on('error', (err) => res.json({ success: false, error: err.message }));
  reqClash.on('timeout', () => { reqClash.destroy(); res.json({ success: false, error: 'Clash API timeout' }); });
  reqClash.write(body);
  reqClash.end();
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

app.post('/api/config/generate', (req, res) => {
  const { nodes, selectedIndex, settings } = req.body;
  res.json({ config: generateSingboxConfig(nodes, selectedIndex, settings) });
});

app.post('/api/config/write', (req, res) => {
  const { config } = req.body;
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Invalid config payload' });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  res.json({ path: CONFIG_FILE });
});

app.get('/api/config/read', (_req, res) => {
  if (fs.existsSync(CONFIG_FILE)) {
    res.json({ config: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) });
  } else {
    res.json({ config: null });
  }
});

app.post('/api/system-proxy/enable', async (req, res) => {
  res.json({ success: await enableSystemProxy(req.body.host, req.body.port) });
});

app.post('/api/system-proxy/disable', async (_req, res) => {
  res.json({ success: await disableSystemProxy() });
});

app.get('/api/system-proxy/status', async (_req, res) => {
  res.json(await getSystemProxyStatus());
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
  const latency = await clashDelay({
    tag,
    url,
    timeout: Number.isInteger(timeout) ? timeout : 5000,
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
  await disableSystemProxy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await stopSingbox();
  await disableSystemProxy();
  process.exit(0);
});

// ==================== Start ====================
const PORT = parseInt(process.env.PORT || '3456');
// Bind to loopback only. This server controls system proxy settings and the
// sing-box process, so it must never be exposed on the LAN/public interfaces.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Awesome Proxy Backend');
  console.log('  +-- REST API:  http://' + HOST + ':' + PORT + '/api');
  console.log('  +-- WebSocket: ws://' + HOST + ':' + PORT);
  console.log('  +-- Config:    ' + CONFIG_DIR);
  console.log('  +-- sing-box:  ' + getSingboxPath());
  console.log('');
});
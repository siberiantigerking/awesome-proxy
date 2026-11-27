/**
 * Windows system proxy (WinINET registry values), shared by electron/main.ts
 * and server/index.js.
 *
 * Why (improvement audit P0-2): the app used to set ProxyEnable / ProxyServer /
 * ProxyOverride on connect and blindly clear them on disconnect. Two problems:
 *   - A crash, a kill from Task Manager or a Windows shutdown skipped the clear,
 *     leaving every app pointed at a dead loopback port ("no internet").
 *   - A disconnect, even in Manual mode, wiped whatever proxy another tool or
 *     the user had configured, and never put it back.
 * Now `enable()` first saves the four values it is about to touch (an
 * ownership marker, persisted by the caller), and `disable()` / `recover()` /
 * `restoreSync()` put exactly those back, but only while the registry still
 * shows OUR proxy. Without a marker they leave the registry alone.
 *
 * All registry access goes through reg.exe / powershell.exe via execFile with
 * argument arrays: no shell, so no value can inject a command.
 */

'use strict';

const { execFile, execFileSync } = require('child_process');
const net = require('net');

const INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * Windows system-proxy bypass list (`ProxyOverride`).
 *
 * Previously we set only ProxyEnable/ProxyServer and never wrote this, which was
 * a real defect with two consequences. First, with no bypass list Windows hands
 * localhost, intranet and LAN requests to the proxy; because our route rules can
 * only bypass a PRIVATE IP and not a hostname (sing-box resolves a destination
 * only when an explicit `action: "resolve"` rule says so), those requests fell
 * through to the remote node and failed — local dev servers, NAS boxes, router
 * pages and anything reached by name. Second, we inherited whatever list another
 * proxy tool had left behind, so behaviour depended on install history.
 *
 * Windows matches these as literal/wildcard patterns, NOT CIDR, so the private
 * ranges have to be spelled out. `172.16-31` is written per octet on purpose:
 * that span is where WSL2, Hyper-V and Docker Desktop put their virtual
 * adapters, and proxying it is what breaks those stacks.
 *
 * `<local>` is Windows' token for "any hostname without a dot".
 */
const PROXY_BYPASS = [
  'localhost',
  '127.*',
  '10.*',
  '192.168.*',
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
  '169.254.*',
  '*.local',
  '<local>',
].join(';');

/** The four values a snapshot covers, in the order they are restored. */
const VALUE_NAMES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'];

/**
 * Registry kinds we can write back exactly. Anything else (REG_MULTI_SZ,
 * REG_BINARY, ...) makes enable() refuse, because we could not restore it.
 */
const KIND_TO_REG_TYPE = {
  DWord: 'REG_DWORD',
  String: 'REG_SZ',
  ExpandString: 'REG_EXPAND_SZ',
};
const REG_TYPE_TO_KIND = {
  REG_DWORD: 'DWord',
  REG_SZ: 'String',
  REG_EXPAND_SZ: 'ExpandString',
};

// D12: only ever point the system at this machine's own proxy. A renderer (or
// a page talking to the web backend) must not be able to send every app's
// traffic to a remote host.
const ALLOWED_PROXY_HOSTS = new Set(['127.0.0.1', 'localhost']);

const LOOPBACK_PROBE_TIMEOUT_MS = 300;
const REG_TIMEOUT_MS = 10000;

function sanitizeHost(host) {
  // Only allow valid IP addresses or hostnames
  if (typeof host !== 'string' || !/^[a-zA-Z0-9.\-:]+$/.test(host)) {
    throw new Error(`Invalid host: ${host}`);
  }
  return host;
}

/**
 * Tell Windows the proxy configuration changed.
 *
 * Writing the registry alone is not enough: WinINET caches proxy settings per
 * process and only re-reads them when it receives INTERNET_OPTION_SETTINGS_CHANGED
 * (39) followed by INTERNET_OPTION_REFRESH (37). Without this, apps already
 * running keep using the previous settings until restarted, which looks exactly
 * like "enabling the system proxy did nothing" or "disabling it left me offline".
 *
 * Best-effort: a failure here is not fatal, the registry is still correct.
 */
function notifyProxySettingsChanged(log) {
  return new Promise((resolve) => {
    const ps = [
      '$sig = \'[DllImport("wininet.dll", SetLastError=true)]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\';',
      '$t = Add-Type -MemberDefinition $sig -Name W -Namespace P -PassThru;',
      '[void]$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);',
      '[void]$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0);',
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 10000 },
      (error) => {
        if (error && log) log(`Could not broadcast proxy change (settings still written): ${error.message}`);
        resolve();
      }
    );
  });
}

// ==================== reg.exe I/O ====================

function runReg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: REG_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function runRegSync(args) {
  try {
    const stdout = execFileSync('reg.exe', args, {
      windowsHide: true,
      timeout: REG_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { error: null, stdout: String(stdout || ''), stderr: '' };
  } catch (error) {
    return { error, stdout: String((error && error.stdout) || ''), stderr: String((error && error.stderr) || '') };
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parse one value out of `reg query` output. reg.exe separates name, type and
 * data with four spaces. Only used for our own ASCII values (D7a), so the
 * console code page can't matter here.
 */
function parseRegValue(stdout, name) {
  const re = new RegExp(`^\\s+${escapeRegExp(name)}\\s{4}(REG_[A-Z_]+)(?:\\s{4}(.*))?$`, 'im');
  const m = stdout.match(re);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const raw = (m[2] || '').replace(/\r$/, '');
  if (type === 'REG_DWORD') return { type, data: parseInt(raw, 16) };
  return { type, data: raw };
}

/** "unable to find" in English; the key listing below settles any other language. */
const NOT_FOUND_RE = /unable to find/i;

const isNotFound = (result) => NOT_FOUND_RE.test(result.stderr) || NOT_FOUND_RE.test(result.stdout);

/**
 * Turn a `reg query <key> /v <name>` result into `{ type, data }` / null.
 * `listing` is the result of `reg query <key>` (whole key), only needed when
 * the single-value query failed without the English "unable to find": reg.exe
 * reports "value absent" with exit 1, the same code as real failures, and
 * localized Windows words the message differently. The key listing tells the
 * two apart without depending on the language.
 */
function interpretQuery(result, name, listing) {
  if (!result.error) {
    const value = parseRegValue(result.stdout, name);
    if (value) return value;
    throw new Error(`Could not parse the registry value ${name}`);
  }
  if (isNotFound(result)) return null;
  if (!listing || listing.error) {
    throw new Error(`Could not read the registry value ${name}: ${(result.stderr || result.error.message).trim()}`);
  }
  return parseRegValue(listing.stdout, name);
}

/** `{ type, data }` or null when the value is absent; throws on any other failure. */
async function queryValue(key, name) {
  const result = await runReg(['query', key, '/v', name]);
  const listing = result.error && !isNotFound(result) ? await runReg(['query', key]) : null;
  return interpretQuery(result, name, listing);
}

function queryValueSync(key, name) {
  const result = runRegSync(['query', key, '/v', name]);
  const listing = result.error && !isNotFound(result) ? runRegSync(['query', key]) : null;
  return interpretQuery(result, name, listing);
}

function writeArgs(key, name, kind, data) {
  const regType = KIND_TO_REG_TYPE[kind];
  if (!regType) throw new Error(`Unsupported registry kind ${kind} for ${name}`);
  // reg.exe takes REG_DWORD data as decimal; GetValue() hands DWORDs back as a
  // signed Int32, so normalise to the unsigned value it really is.
  const text = kind === 'DWord' ? String(Number(data) >>> 0) : String(data ?? '');
  return ['add', key, '/v', name, '/t', regType, '/d', text, '/f'];
}

async function writeValue(key, name, kind, data) {
  const result = await runReg(writeArgs(key, name, kind, data));
  if (result.error) throw new Error(`Could not write ${name}: ${(result.stderr || result.error.message).trim()}`);
}

function writeValueSync(key, name, kind, data) {
  const result = runRegSync(writeArgs(key, name, kind, data));
  if (result.error) throw new Error(`Could not write ${name}: ${(result.stderr || result.error.message).trim()}`);
}

/** Delete a value; already absent counts as success. */
async function deleteValue(key, name) {
  const result = await runReg(['delete', key, '/v', name, '/f']);
  if (!result.error) return;
  if ((await queryValue(key, name)) === null) return;
  throw new Error(`Could not delete ${name}: ${(result.stderr || result.error.message).trim()}`);
}

function deleteValueSync(key, name) {
  const result = runRegSync(['delete', key, '/v', name, '/f']);
  if (!result.error) return;
  if (queryValueSync(key, name) === null) return;
  throw new Error(`Could not delete ${name}: ${(result.stderr || result.error.message).trim()}`);
}

/** `HKCU\...` → `Registry::HKEY_CURRENT_USER\...` for PowerShell's -LiteralPath. */
function toPowerShellPath(key) {
  const expanded = key
    .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\');
  return 'Registry::' + expanded;
}

/**
 * Read the four snapshot values with their kinds, encoding-safe (D7a).
 *
 * `reg query` prints in the console code page, so a non-ASCII PAC path or
 * bypass entry (e.g. under C:\Users\<Chinese name>\) would come back mangled
 * and be restored wrong. One PowerShell call with UTF-8 output reads them
 * exactly, unexpanded. Resolves `{ [name]: { kind, data } | null }`; a missing
 * key means every value is absent.
 */
function readSnapshot(key) {
  const literal = toPowerShellPath(key).replace(/'/g, "''");
  const names = VALUE_NAMES.map((n) => `'${n}'`).join(',');
  const script = [
    "$ErrorActionPreference = 'Stop';",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
    '$o = @{};',
    `$p = '${literal}';`,
    `$names = @(${names});`,
    'if (Test-Path -LiteralPath $p) {',
    '  $k = Get-Item -LiteralPath $p;',
    '  $present = $k.GetValueNames();',
    '  foreach ($n in $names) {',
    '    if ($present -contains $n) {',
    "      $o[$n] = @{ kind = $k.GetValueKind($n).ToString(); data = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames') }",
    '    } else { $o[$n] = $null }',
    '  }',
    '} else { foreach ($n in $names) { $o[$n] = $null } }',
    '$o | ConvertTo-Json -Compress -Depth 4',
  ].join(' ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Could not read the proxy settings: ${(stderr || error.message).trim()}`));
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
          const snapshot = {};
          for (const name of VALUE_NAMES) {
            const v = parsed[name];
            snapshot[name] = v && typeof v === 'object' ? { kind: String(v.kind), data: v.data } : null;
          }
          resolve(snapshot);
        } catch (err) {
          reject(new Error(`Could not parse the proxy settings: ${err.message}`));
        }
      }
    );
  });
}

// ==================== Pure logic ====================

/**
 * Split a ProxyServer string into `{ host, port }` entries. Accepts `host:port`
 * and the per-protocol form `http=h:p;https=h:p;socks=h:p`; a missing port
 * means 80, as WinINET assumes.
 */
function parseProxyEntries(server) {
  if (typeof server !== 'string') return [];
  const entries = [];
  for (const part of server.split(';')) {
    let s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq !== -1) s = s.slice(eq + 1).trim();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
    if (!s) continue;
    let host;
    let portText;
    const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) {
      host = bracketed[1];
      portText = bracketed[2];
    } else {
      const colon = s.lastIndexOf(':');
      if (colon !== -1 && s.indexOf(':') === colon) {
        host = s.slice(0, colon);
        portText = s.slice(colon + 1);
      } else {
        host = s;
      }
    }
    const port = portText ? parseInt(portText, 10) : 80;
    entries.push({ host: host.toLowerCase(), port: Number.isInteger(port) ? port : 80 });
  }
  return entries;
}

const isLoopbackHost = (host) => host === 'localhost' || host === '::1' || /^127\./.test(host);

/** True when ProxyServer names only loopback addresses (every entry, at least one). */
function isLoopbackProxy(server) {
  const entries = parseProxyEntries(server);
  return entries.length > 0 && entries.every((e) => isLoopbackHost(e.host));
}

/** True when the registry still shows the proxy WE set. */
function isOurs(marker, current) {
  const enable = current && current.ProxyEnable;
  const server = current && current.ProxyServer;
  return !!(enable && Number(enable.data) === 1 && server && server.data === marker.server);
}

/**
 * Decide what a restore does (D6, D8). `current` holds ProxyEnable and
 * ProxyServer as read now; `previousProxyAlive` only matters when the saved
 * proxy was enabled on a loopback address.
 *
 * Returns `{ action: 'none' | 'foreign' | 'restore', ops, previousDisabled }`,
 * where ops are `{ op: 'write', name, kind, data }` / `{ op: 'delete', name }`.
 * ProxyEnable comes first: if a later write fails, the proxy is at worst off
 * rather than pointing at our stopped core under someone else's name.
 */
function planRestore(marker, current, { previousProxyAlive } = {}) {
  if (!marker || !marker.previous) return { action: 'none', ops: [], previousDisabled: false };
  if (!isOurs(marker, current)) return { action: 'foreign', ops: [], previousDisabled: false };

  const previous = marker.previous;
  const prevEnable = previous.ProxyEnable;
  const prevServer = previous.ProxyServer;
  const wasEnabled = !!(prevEnable && Number(prevEnable.data) === 1);
  // Re-enabling a dead loopback proxy (a NekoBox that has since exited, say)
  // would recreate exactly the "dead proxy, no internet" state this fixes.
  const previousDisabled =
    wasEnabled && !!prevServer && isLoopbackProxy(String(prevServer.data)) && previousProxyAlive !== true;

  const ops = [];
  for (const name of VALUE_NAMES) {
    const value = previous[name];
    if (name === 'ProxyEnable' && previousDisabled) {
      ops.push({ op: 'write', name, kind: prevEnable.kind || 'DWord', data: 0 });
    } else if (value) {
      ops.push({ op: 'write', name, kind: value.kind, data: value.data });
    } else {
      ops.push({ op: 'delete', name });
    }
  }
  return { action: 'restore', ops, previousDisabled };
}

function probeTcp(host, port, timeoutMs = LOOPBACK_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// ==================== Factory ====================

/**
 * @param {object} deps
 * @param {string} [deps.key] registry key (tests pass a scratch key)
 * @param {{ get(): object|null, set(marker: object): void, clear(): void }} deps.markerStore
 *   persists the ownership marker; `set` may throw (enable then refuses)
 * @param {(msg: string) => void} [deps.log]
 * @param {() => Promise<void>} [deps.notify] WinINET refresh broadcast
 * @param {(host: string, port: number, timeoutMs: number) => Promise<boolean>} [deps.isPortOpen]
 */
function createSystemProxy({
  key = INTERNET_SETTINGS_KEY,
  markerStore,
  log = () => {},
  notify,
  isPortOpen = probeTcp,
} = {}) {
  if (!markerStore) throw new Error('createSystemProxy needs a markerStore');
  const broadcast = notify || (() => notifyProxySettingsChanged(log));

  // enable / disable / recover can be fired concurrently (a disconnect while a
  // connect is still finishing, a quit during either). Run them one at a time
  // so a restore never interleaves with a snapshot.
  let chain = Promise.resolve();
  const serialize = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const getMarker = () => {
    try {
      const marker = markerStore.get();
      return marker && typeof marker === 'object' && marker.previous ? marker : null;
    } catch (err) {
      log(`WARN: Could not read the saved system proxy settings: ${err.message}`);
      return null;
    }
  };

  const clearMarker = () => {
    try {
      markerStore.clear();
    } catch (err) {
      log(`WARN: Could not clear the saved system proxy settings: ${err.message}`);
    }
  };

  async function readOwnership() {
    return {
      ProxyEnable: await queryValue(key, 'ProxyEnable'),
      ProxyServer: await queryValue(key, 'ProxyServer'),
    };
  }

  async function isAnyEntryOpen(server) {
    for (const entry of parseProxyEntries(server)) {
      // eslint-disable-next-line no-await-in-loop
      if (await isPortOpen(entry.host, entry.port, LOOPBACK_PROBE_TIMEOUT_MS)) return true;
    }
    return false;
  }

  async function previousAliveFor(marker) {
    const prev = marker.previous;
    const wasEnabled = prev.ProxyEnable && Number(prev.ProxyEnable.data) === 1;
    if (!wasEnabled || !prev.ProxyServer || !isLoopbackProxy(String(prev.ProxyServer.data))) return undefined;
    return isAnyEntryOpen(String(prev.ProxyServer.data));
  }

  async function applyOps(ops) {
    for (const op of ops) {
      // eslint-disable-next-line no-await-in-loop
      if (op.op === 'write') await writeValue(key, op.name, op.kind, op.data);
      // eslint-disable-next-line no-await-in-loop
      else await deleteValue(key, op.name);
    }
  }

  /**
   * The shared core of disable() and recover(): put the snapshot back if the
   * registry is still ours. Returns 'none' | 'foreign' | 'restored' | 'failed'.
   */
  async function restoreOwned() {
    const marker = getMarker();
    if (!marker) return 'none';

    let current;
    try {
      current = await readOwnership();
    } catch (err) {
      // Can't tell whose proxy it is: keep the marker so the next disable or
      // launch tries again rather than guessing.
      log(`Failed to restore the system proxy (could not read it): ${err.message}`);
      return 'failed';
    }

    const probe = isOurs(marker, current) ? await previousAliveFor(marker) : undefined;
    const plan = planRestore(marker, current, { previousProxyAlive: probe });
    if (plan.action === 'foreign') {
      clearMarker();
      log('System proxy was changed by another program; left as is');
      return 'foreign';
    }

    try {
      await applyOps(plan.ops);
    } catch (err) {
      log(`Failed to restore the system proxy: ${err.message}`);
      await broadcast();
      return 'failed';
    }
    clearMarker();
    await broadcast();
    const prevServer = marker.previous.ProxyServer && marker.previous.ProxyServer.data;
    log(
      'System proxy restored to its previous settings' +
        (plan.previousDisabled ? ` (the previous proxy ${prevServer} isn't running, so it was left switched off)` : '')
    );
    return 'restored';
  }

  async function enableImpl(host, port) {
    try {
      sanitizeHost(host);
    } catch (err) {
      log(`Refused to set the system proxy: ${err.message}`);
      return false;
    }
    if (!ALLOWED_PROXY_HOSTS.has(host)) {
      log(`Refused to set the system proxy to ${host}: only 127.0.0.1 or localhost is allowed`);
      return false;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      log('Invalid proxy port');
      return false;
    }
    const server = `${host}:${port}`;

    let marker = getMarker();
    let pausedPac = false;
    if (!marker) {
      // D7: snapshot only when no marker exists, so a re-enable keeps the
      // very first snapshot (the user's real settings, not ours).
      let snapshot;
      try {
        snapshot = await readSnapshot(key);
      } catch (err) {
        log(`Failed to enable system proxy: ${err.message}`);
        return false;
      }
      for (const name of VALUE_NAMES) {
        const value = snapshot[name];
        if (value && !KIND_TO_REG_TYPE[value.kind]) {
          log(`Failed to enable system proxy: ${name} has registry type ${value.kind}, which this app can't restore, so it was left untouched`);
          return false;
        }
      }
      const previous = { ...snapshot };
      // Our own leftover from an older build's crash: don't record it as the
      // user's setting, or the restore would re-enable a dead proxy.
      if (
        snapshot.ProxyEnable && Number(snapshot.ProxyEnable.data) === 1 &&
        snapshot.ProxyServer && snapshot.ProxyServer.data === server
      ) {
        previous.ProxyEnable = { kind: 'DWord', data: 0 };
        if (snapshot.ProxyOverride && snapshot.ProxyOverride.data === PROXY_BYPASS) previous.ProxyOverride = null;
      }
      marker = { version: 1, server, at: Date.now(), previous };
      pausedPac = !!snapshot.AutoConfigURL;
      try {
        markerStore.set(marker);
      } catch (err) {
        // Without a saved snapshot a crash would leave the proxy unrecoverable.
        log(`Failed to enable system proxy: could not save the current settings (${err.message})`);
        return false;
      }
    } else if (marker.server !== server) {
      const updated = { ...marker, server };
      try {
        markerStore.set(updated);
      } catch (err) {
        log(`Failed to enable system proxy: could not save the current settings (${err.message})`);
        return false;
      }
      marker = updated;
    }

    try {
      await writeValue(key, 'ProxyServer', 'String', server);
      // Written explicitly every time rather than left to whatever was there.
      await writeValue(key, 'ProxyOverride', 'String', PROXY_BYPASS);
      // D9: WinINET prefers a PAC script over the manual proxy, so System
      // Proxy mode would silently not apply. The restore puts it back.
      await deleteValue(key, 'AutoConfigURL');
      await writeValue(key, 'ProxyEnable', 'DWord', 1);
    } catch (err) {
      log(`Failed to enable system proxy: ${err.message}`);
      // Best-effort: put back what was there, then forget the snapshot.
      try {
        const probe = await previousAliveFor(marker);
        const plan = planRestore(marker, { ProxyEnable: { data: 1 }, ProxyServer: { data: server } }, {
          previousProxyAlive: probe,
        });
        await applyOps(plan.ops);
      } catch (restoreErr) {
        log(`Could not undo the partial system proxy change: ${restoreErr.message}`);
      }
      clearMarker();
      await broadcast();
      return false;
    }

    await broadcast();
    log(
      `System proxy enabled: ${server} (bypassing localhost, LAN and private ranges)` +
        (pausedPac ? '; paused the proxy auto-config script while connected' : '')
    );
    return true;
  }

  async function recoverImpl({ legacyLeftover } = {}) {
    if (getMarker()) {
      const result = await restoreOwned();
      if (result === 'restored') log('Recovered the system proxy left by an unclean exit');
      return result;
    }
    if (!legacyLeftover) return 'none';

    // D11: a pre-1.5.0 build that crashed left ProxyEnable=1 on its own port
    // with our bypass list and no marker. Clear it the old way, but only when
    // nothing listens there (otherwise it may be a live proxy, ours or not).
    const port = legacyLeftover.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'none';
    try {
      const enable = await queryValue(key, 'ProxyEnable');
      const server = await queryValue(key, 'ProxyServer');
      const override = await queryValue(key, 'ProxyOverride');
      const looksLikeOurs =
        enable && Number(enable.data) === 1 &&
        server && server.data === `127.0.0.1:${port}` &&
        override && override.data === PROXY_BYPASS;
      if (!looksLikeOurs) return 'none';
      if (await isPortOpen('127.0.0.1', port, LOOPBACK_PROBE_TIMEOUT_MS)) return 'none';
      await writeValue(key, 'ProxyEnable', 'DWord', 0);
      await deleteValue(key, 'ProxyOverride');
      await broadcast();
      log(`Recovered the system proxy left by an unclean exit of an earlier version (127.0.0.1:${port} was switched off)`);
      return 'legacy-cleared';
    } catch (err) {
      log(`Could not check for a system proxy left by an earlier version: ${err.message}`);
      return 'failed';
    }
  }

  /**
   * Synchronous restore for Windows session end, where async work may never
   * finish. No port probe (so a loopback previous proxy comes back switched
   * off) and no WinINET broadcast (PowerShell takes seconds; the session is
   * ending anyway). Never throws.
   */
  function restoreSync() {
    try {
      const marker = getMarker();
      if (!marker) return;
      const current = {
        ProxyEnable: queryValueSync(key, 'ProxyEnable'),
        ProxyServer: queryValueSync(key, 'ProxyServer'),
      };
      const plan = planRestore(marker, current, { previousProxyAlive: false });
      if (plan.action === 'foreign') {
        clearMarker();
        return;
      }
      for (const op of plan.ops) {
        if (op.op === 'write') writeValueSync(key, op.name, op.kind, op.data);
        else deleteValueSync(key, op.name);
      }
      clearMarker();
      log('System proxy restored to its previous settings (session ending)');
    } catch (err) {
      try {
        log(`Failed to restore the system proxy at session end: ${err && err.message}`);
      } catch {
        /* never throw from here */
      }
    }
  }

  async function status() {
    try {
      const enable = await queryValue(key, 'ProxyEnable');
      const server = await queryValue(key, 'ProxyServer');
      return { enabled: !!enable && Number(enable.data) === 1, server: server ? String(server.data).trim() : '' };
    } catch {
      return { enabled: false, server: '' };
    }
  }

  return {
    enable: (host, port) =>
      serialize(() =>
        enableImpl(host, port).catch((err) => {
          log(`Failed to enable system proxy: ${err.message}`);
          return false;
        })
      ),
    disable: () =>
      serialize(() =>
        restoreOwned().then(
          (result) => result !== 'failed',
          (err) => {
            log(`Failed to restore the system proxy: ${err.message}`);
            return false;
          }
        )
      ),
    recover: (options) =>
      serialize(() =>
        recoverImpl(options).catch((err) => {
          log(`Could not recover the system proxy: ${err.message}`);
          return 'failed';
        })
      ),
    restoreSync,
    status,
  };
}

module.exports = {
  createSystemProxy,
  planRestore,
  isLoopbackProxy,
  notifyProxySettingsChanged,
  INTERNET_SETTINGS_KEY,
  PROXY_BYPASS,
  // Exported for the scratch tests only (D7a encoding-safe reader).
  readSnapshot,
  parseProxyEntries,
};

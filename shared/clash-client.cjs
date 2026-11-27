/**
 * Clash API client — shared by electron/main.ts, server/index.js and
 * shared/node-probes.cjs. The ONLY place that knows the controller's address,
 * its secret, or the /proxies and /connections routes.
 *
 * Why (improvement audit P0-1): the generated config used to open sing-box's
 * Clash API on a fixed, well-known loopback port with no secret. Any local
 * program, and any web page via a DNS-rebinding or plain fetch to localhost,
 * could then read every live connection and switch the selector, i.e. silently
 * reroute the user's traffic through a node of its choosing. Now every core
 * start gets a random free loopback port and a fresh 256-bit secret, and every
 * request carries `Authorization: Bearer <secret>`.
 *
 * Rules for callers:
 *   - The secret is never logged, never put in an error message, and never sent
 *     to the renderer. Only the backend process (main / server) holds it, and it
 *     writes it into the config file itself right before spawning the core.
 *   - Credentials die with the core: a new start means new credentials.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');

const CLASH_API_HOST = '127.0.0.1';

const isValidPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

/**
 * Ask the OS for a currently free loopback port. There is a small window
 * between closing this probe socket and sing-box binding the port; the start
 * logic retries once on "external controller listen error" to cover it.
 */
function pickFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, CLASH_API_HOST, () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => {
        if (isValidPort(port)) resolve(port);
        else reject(new Error('Could not allocate a loopback port'));
      });
    });
  });
}

/** Fresh `{ port, secret }` for one core start. */
async function createClashApiCredentials() {
  const port = await pickFreeLoopbackPort();
  return { port, secret: crypto.randomBytes(32).toString('hex') };
}

/**
 * The `experimental.clash_api` block for the given credentials. Throws rather
 * than emitting a controller without a secret or on a nonsense port: either
 * would silently reopen the hole this module exists to close.
 */
function buildClashApiBlock(creds) {
  const { port, secret } = creds || {};
  if (!isValidPort(port)) throw new Error('Invalid Clash API port');
  if (typeof secret !== 'string' || !secret) throw new Error('Missing Clash API secret');
  return {
    external_controller: CLASH_API_HOST + ':' + port,
    external_ui: '',
    secret,
  };
}

/**
 * Return a copy of `config` whose `experimental.clash_api` is the block for
 * `creds`, keeping every other `experimental` key (cache_file in particular).
 * Whatever clash_api the config carried before is replaced, so a renderer-
 * written controller address or secret never reaches the core.
 */
function applyClashApi(config, creds) {
  const block = buildClashApiBlock(creds);
  const base = config && typeof config === 'object' ? config : {};
  const experimental =
    base.experimental && typeof base.experimental === 'object' ? base.experimental : {};
  return { ...base, experimental: { ...experimental, clash_api: block } };
}

/**
 * Rewrite the config file on disk with the given credentials. Synchronous on
 * purpose: it is the last write before the core reads the file, and nothing
 * else may interleave with it.
 */
function writeConfigWithClashApi(configPath, creds) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error('could not read ' + configPath + ': ' + err.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(configPath + ' is not valid JSON: ' + err.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(configPath + ' does not contain a JSON object');
  }
  fs.writeFileSync(configPath, JSON.stringify(applyClashApi(parsed, creds), null, 2), 'utf-8');
}

/**
 * True when sing-box's output says it couldn't bind the controller port, e.g.
 * "FATAL[0000] start service: finish-start clash server: external controller
 * listen error: listen tcp 127.0.0.1:19191: bind: Only one usage of each
 * socket address ...". That is the race pickFreeLoopbackPort can lose.
 */
function isControllerListenError(text) {
  return typeof text === 'string' && /external controller listen error/i.test(text);
}

/**
 * One request to the Clash API. Resolves `{ statusCode, body }` for any HTTP
 * answer (callers decide what a status means); rejects with
 * "Core is not running" without a port, "Clash API timeout" on timeout, and
 * the socket error otherwise.
 */
function clashRequest(method, path, body, options = {}) {
  const { port, secret, host = CLASH_API_HOST, timeout = 3000, maxBodyBytes } = options;
  return new Promise((resolve, reject) => {
    if (!isValidPort(port)) {
      reject(new Error('Core is not running'));
      return;
    }
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const headers = {};
    if (secret) headers.Authorization = 'Bearer ' + secret;
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = http.request({ host, port, path, method, timeout, headers }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        // Guard against a runaway body where the caller only needs a small one.
        if (!maxBodyBytes || data.length < maxBodyBytes) data += chunk;
      });
      res.on('end', () => settle(resolve, { statusCode: res.statusCode, body: data }));
      res.on('error', (err) => settle(reject, err));
    });
    req.on('error', (err) => settle(reject, err));
    req.on('timeout', () => {
      req.destroy();
      settle(reject, new Error('Clash API timeout'));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const proxyPath = (name) => '/proxies/' + encodeURIComponent(name);

/**
 * Switch a selector's active outbound live (no restart).
 * PUT /proxies/{selector} {"name": outbound} → 204 on success.
 */
async function clashSelect(creds, selector, outbound) {
  try {
    const res = await clashRequest('PUT', proxyPath(selector), { name: outbound }, { ...creds });
    if (res.statusCode === 204 || res.statusCode === 200) return { success: true };
    return { success: false, error: 'Clash API returned status ' + res.statusCode };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Read a selector's CURRENTLY ACTIVE outbound.
 * GET /proxies/{selector} → { now: "tag", ... }
 *
 * Needed because a successful PUT only means the request was accepted. The
 * selection that decides where traffic goes has to be read back, since the
 * cache file restores a previous choice on start and overrides the config's
 * `default`.
 */
async function clashSelection(creds, selector) {
  let res;
  try {
    res = await clashRequest('GET', proxyPath(selector), null, { ...creds });
  } catch (err) {
    return { success: false, error: err.message };
  }
  if (res.statusCode !== 200) {
    return { success: false, error: 'Clash API returned status ' + res.statusCode };
  }
  try {
    const parsed = JSON.parse(res.body);
    return { success: true, now: parsed && typeof parsed.now === 'string' ? parsed.now : undefined };
  } catch {
    return { success: false, error: 'Could not parse Clash API response' };
  }
}

/**
 * Cumulative traffic counters from GET /connections, or null when the API
 * isn't answering (not ready yet, stopped, or an unexpected reply).
 */
async function clashConnectionTotals(creds, timeout = 2000) {
  try {
    const res = await clashRequest('GET', '/connections', null, { ...creds, timeout });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    return {
      uploadTotal: Number(data && data.uploadTotal) || 0,
      downloadTotal: Number(data && data.downloadTotal) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Ask sing-box to time an HTTP request through one specific outbound.
 * GET /proxies/{tag}/delay?timeout=<ms>&url=<probe url> → { "delay": 123 }
 *
 * Returns ms, or -1 on any failure. A non-200 is itself the "this node is
 * dead" signal, so it maps to -1 rather than throwing. The request gets two
 * seconds on top of the probe timeout so sing-box's own timeout answers first.
 */
async function clashDelayRequest(creds, tag, url, timeout) {
  if (!tag) return -1;
  const path =
    proxyPath(tag) +
    '/delay?timeout=' +
    encodeURIComponent(String(timeout)) +
    '&url=' +
    encodeURIComponent(url);
  try {
    const res = await clashRequest('GET', path, null, {
      ...creds,
      timeout: timeout + 2000,
      maxBodyBytes: 4096,
    });
    if (res.statusCode !== 200) return -1;
    const parsed = JSON.parse(res.body);
    const delay = Number(parsed && parsed.delay);
    return Number.isFinite(delay) && delay >= 0 ? Math.round(delay) : -1;
  } catch {
    return -1;
  }
}

module.exports = {
  CLASH_API_HOST,
  pickFreeLoopbackPort,
  createClashApiCredentials,
  buildClashApiBlock,
  applyClashApi,
  writeConfigWithClashApi,
  isControllerListenError,
  clashRequest,
  clashSelect,
  clashSelection,
  clashConnectionTotals,
  clashDelayRequest,
};

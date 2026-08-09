/**
 * Node test probes — shared by electron/main.ts and server/index.js.
 *
 * Four kinds of test, because they answer genuinely different questions:
 *
 *   tcpPing    Can this machine even reach the node's host:port, and how fast
 *              is the handshake? Works while DISCONNECTED. Says nothing about
 *              whether the proxy credentials/protocol actually work.
 *
 *   clashDelay Real latency of an HTTP request carried THROUGH a specific
 *              outbound, measured by sing-box itself via the Clash API. This is
 *              the number that tells you the node works end to end. Needs the
 *              core running, but does NOT disturb the active selection.
 *
 *   udpProbe   Does UDP survive the tunnel? Performed by asking the local mixed
 *              inbound for a SOCKS5 UDP ASSOCIATE and running a real DNS query
 *              over it. Many nodes are TCP-only, which silently breaks games,
 *              QUIC and voice chat, and nothing else here would reveal that.
 *
 *   speedProbe Throughput through the tunnel, by downloading through the local
 *              proxy port and timing the payload.
 *
 * IMPORTANT: udpProbe and speedProbe go through the LOCAL PROXY PORT, so they
 * measure whichever outbound the selector currently points at. To attribute
 * them to a specific node the caller must switch the selector first and put it
 * back afterwards. clashDelay and tcpPing need no such dance.
 */

'use strict';

const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const http = require('http');

// Cloudflare rather than Google throughout: cp.cloudflare.com is Cloudflare's
// captive-portal endpoint (204, empty body, anycast everywhere) and is reachable
// from far more networks than www.gstatic.com, which is blocked outright on some
// of them. A probe URL that the node can't reach makes a working node look dead,
// so reachability matters more here than brand preference.
const DEFAULT_DELAY_URL = 'https://cp.cloudflare.com/generate_204';

/**
 * Speed test endpoints, tried in order until one actually serves data.
 *
 * CacheFly comes first because it was the only one that reliably returned 200
 * through the tunnel in testing: Cloudflare's `__down` endpoint answers 403 to
 * plain non-browser clients, which would otherwise be reported as "0 Mbps" and
 * look like a broken node. Cloudflare and OVH stay as fallbacks in case CacheFly
 * is blocked on a given network.
 */
const DEFAULT_SPEED_URLS = [
  'https://cachefly.cachefly.net/100mb.test',
  'https://speed.cloudflare.com/__down?bytes=100000000',
  'https://proof.ovh.net/files/100Mb.dat',
];
const DEFAULT_SPEED_URL = DEFAULT_SPEED_URLS[0];

// STUN servers for the UDP check, tried in order. Cloudflare first, Google as
// a fallback so a single provider being blocked doesn't produce a false "no UDP".
const DEFAULT_STUN_SERVERS = [
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.l.google.com', port: 19302 },
];

/**
 * TCP handshake time to host:port, in ms. -1 on timeout/error.
 */
function tcpPing(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeout);
    socket.on('connect', () => finish(Date.now() - start));
    socket.on('timeout', () => finish(-1));
    socket.on('error', () => finish(-1));
    socket.connect(port, host);
  });
}

/**
 * Ask sing-box to time an HTTP request through one specific outbound.
 * GET /proxies/{tag}/delay?timeout=<ms>&url=<probe url> -> { "delay": 123 }
 *
 * Returns ms, or -1 when the outbound can't reach the probe URL. A non-200 from
 * the Clash API is itself the "this node is dead" signal, so it maps to -1
 * rather than throwing.
 */
function clashDelay(options = {}) {
  const {
    tag,
    url = DEFAULT_DELAY_URL,
    timeout = 5000,
    host = '127.0.0.1',
    port = 9090,
  } = options;

  return new Promise((resolve) => {
    if (!tag) {
      resolve(-1);
      return;
    }
    const path =
      '/proxies/' +
      encodeURIComponent(tag) +
      '/delay?timeout=' +
      encodeURIComponent(String(timeout)) +
      '&url=' +
      encodeURIComponent(url);

    const req = http.request(
      { host, port, path, method: 'GET', timeout: timeout + 2000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          // Guard against a runaway response body.
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(-1);
            return;
          }
          try {
            const parsed = JSON.parse(body);
            const delay = Number(parsed && parsed.delay);
            resolve(Number.isFinite(delay) && delay >= 0 ? Math.round(delay) : -1);
          } catch {
            resolve(-1);
          }
        });
      }
    );
    req.on('error', () => resolve(-1));
    req.on('timeout', () => {
      req.destroy();
      resolve(-1);
    });
    req.end();
  });
}

/**
 * Build a STUN binding request (RFC 5389). Returns { transactionId, buffer }.
 *
 * STUN is used instead of the more obvious DNS query for one important reason:
 * the generated config hijacks DNS (`{ protocol: 'dns', action: 'hijack-dns' }`),
 * so a query to port 53 never leaves as UDP through the outbound — sing-box
 * answers it internally over DoH. A DNS probe would therefore report "UDP works"
 * even on a strictly TCP-only node. STUN runs on its own port, isn't hijacked,
 * and is exactly what WebRTC uses, so a reply proves real UDP transit.
 */
function buildStunRequest() {
  const buffer = Buffer.alloc(20);
  buffer.writeUInt16BE(0x0001, 0); // Binding Request
  buffer.writeUInt16BE(0, 2); // no attributes
  buffer.writeUInt32BE(0x2112a442, 4); // magic cookie
  const transactionId = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) transactionId[i] = Math.floor(Math.random() * 256);
  transactionId.copy(buffer, 8);
  return { transactionId, buffer };
}

function readSocks5Reply(chunk) {
  // VER REP RSV ATYP BND.ADDR BND.PORT
  if (chunk.length < 10) return null;
  if (chunk[0] !== 0x05 || chunk[1] !== 0x00) return null;
  const atyp = chunk[3];
  let addr;
  let cursor;
  if (atyp === 0x01) {
    addr = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
    cursor = 8;
  } else if (atyp === 0x04) {
    if (chunk.length < 22) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(chunk.readUInt16BE(4 + i * 2).toString(16));
    addr = parts.join(':');
    cursor = 20;
  } else if (atyp === 0x03) {
    const length = chunk[4];
    if (chunk.length < 5 + length + 2) return null;
    addr = chunk.toString('ascii', 5, 5 + length);
    cursor = 5 + length;
  } else {
    return null;
  }
  return { addr, port: chunk.readUInt16BE(cursor) };
}

/**
 * SOCKS5 UDP request header: RSV(2) FRAG(1) ATYP(1) DST.ADDR DST.PORT.
 *
 * Domain targets are sent in ATYP=3 form so the proxy resolves them on the far
 * side — the probe then needs no working local DNS of its own.
 */
function buildSocks5UdpHeader(host, port) {
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isIpv4) {
    const header = Buffer.alloc(10);
    header.writeUInt8(0x01, 3);
    const octets = host.split('.').map(Number);
    for (let i = 0; i < 4; i++) header.writeUInt8(octets[i], 4 + i);
    header.writeUInt16BE(port, 8);
    return header;
  }
  const hostBytes = Buffer.from(host, 'ascii');
  const header = Buffer.alloc(7 + hostBytes.length);
  header.writeUInt8(0x03, 3);
  header.writeUInt8(hostBytes.length, 4);
  hostBytes.copy(header, 5);
  header.writeUInt16BE(port, 5 + hostBytes.length);
  return header;
}

/**
 * Check whether UDP actually survives the tunnel.
 *
 * Asks the local mixed/socks inbound for a SOCKS5 UDP ASSOCIATE, then sends a
 * STUN binding request through the relay and waits for the matching response.
 * Resolves { ok, ms, error } — `ok: false` means the active outbound is TCP-only
 * or is dropping UDP, which is what silently breaks games, QUIC and voice chat.
 *
 * Each configured STUN server is tried in turn before giving up, so one blocked
 * provider can't produce a false negative.
 */
function udpProbe(options = {}) {
  const {
    proxyHost = '127.0.0.1',
    proxyPort = 7890,
    timeout = 6000,
    servers = DEFAULT_STUN_SERVERS,
  } = options;

  const targets = Array.isArray(servers) && servers.length ? servers : DEFAULT_STUN_SERVERS;
  // Split the budget across attempts, with a floor so a single try is still
  // given enough time to complete over a slow link.
  const perAttempt = Math.max(2500, Math.floor(timeout / targets.length));

  const attempt = (target) =>
    new Promise((resolve) => {
      const control = new net.Socket();
      const udp = dgram.createSocket('udp4');
      const stun = buildStunRequest();
      let stage = 'greeting';
      let start = 0;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { udp.close(); } catch { /* already closed */ }
        control.destroy();
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ ok: false, ms: -1, error: `No UDP response via ${target.host}` }),
        perAttempt
      );

      control.on('error', (err) => finish({ ok: false, ms: -1, error: err.message }));
      udp.on('error', (err) => finish({ ok: false, ms: -1, error: err.message }));

      control.on('data', (chunk) => {
        if (stage === 'greeting') {
          if (chunk.length < 2 || chunk[0] !== 0x05 || chunk[1] !== 0x00) {
            finish({ ok: false, ms: -1, error: 'Proxy refused SOCKS5 (no-auth) greeting' });
            return;
          }
          stage = 'associate';
          // 0.0.0.0:0 placeholder: we don't know which local port the OS will
          // give our datagram socket until it sends.
          control.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }

        if (stage === 'associate') {
          const reply = readSocks5Reply(chunk);
          if (!reply) {
            finish({ ok: false, ms: -1, error: 'Proxy rejected UDP ASSOCIATE (TCP-only node?)' });
            return;
          }
          stage = 'relaying';
          // A relay bound to 0.0.0.0 means "same host as the control connection".
          const relayHost = reply.addr === '0.0.0.0' ? proxyHost : reply.addr;
          const packet = Buffer.concat([buildSocks5UdpHeader(target.host, target.port), stun.buffer]);
          start = Date.now();
          udp.send(packet, reply.port, relayHost, (err) => {
            if (err) finish({ ok: false, ms: -1, error: err.message });
          });
        }
      });

      udp.on('message', (message) => {
        // Strip the SOCKS5 UDP header, then confirm this is OUR STUN response:
        // type 0x0101 (Binding Success) with a matching transaction ID.
        if (message.length < 10) return;
        const atyp = message[3];
        const headerLength = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 7 + message[4];
        const payload = message.subarray(headerLength);
        if (payload.length < 20) return;
        if (payload.readUInt16BE(0) !== 0x0101) return;
        if (!payload.subarray(8, 20).equals(stun.transactionId)) return;
        finish({ ok: true, ms: Date.now() - start });
      });

      control.setNoDelay(true);
      control.connect(proxyPort, proxyHost, () => {
        // SOCKS5 greeting, one method: no authentication.
        control.write(Buffer.from([0x05, 0x01, 0x00]));
      });
    });

  return (async () => {
    let last = { ok: false, ms: -1, error: 'UDP probe failed' };
    for (const target of targets) {
      last = await attempt(target);
      if (last.ok) return last;
    }
    return last;
  })();
}

function parseTarget(rawUrl) {
  const parsed = new URL(rawUrl);
  const secure = parsed.protocol === 'https:';
  return {
    secure,
    host: parsed.hostname,
    port: Number(parsed.port) || (secure ? 443 : 80),
    path: `${parsed.pathname}${parsed.search}`,
    href: parsed.href,
  };
}

/**
 * Download through the local proxy port and measure throughput.
 *
 * Resolves { mbps, bytes, ms, error }. Timing starts at the FIRST BODY BYTE so
 * connection setup and TLS handshake don't drag the number down — this reports
 * transfer speed, not time-to-first-byte.
 *
 * Byte counting is done on the raw stream after the header boundary. With
 * chunked encoding that includes a few bytes of chunk framing per chunk, which
 * is noise at these sizes and not worth de-framing for a speed indicator.
 */
function speedProbeOnce(options = {}) {
  const {
    proxyHost = '127.0.0.1',
    proxyPort = 7890,
    url = DEFAULT_SPEED_URL,
    durationMs = 8000,
    maxBytes = 100 * 1024 * 1024,
    connectTimeout = 8000,
    maxRedirects = 3,
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    const sockets = new Set();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      for (const socket of sockets) socket.destroy();
      resolve(result);
    };

    // Hard ceiling so a stalled transfer can't hang the caller.
    const hardTimer = setTimeout(
      () => finish({ mbps: 0, bytes: 0, ms: 0, error: 'Speed test timed out' }),
      durationMs + connectTimeout + 4000
    );

    const attempt = (rawUrl, redirectsLeft) => {
      let target;
      try {
        target = parseTarget(rawUrl);
      } catch {
        finish({ mbps: 0, bytes: 0, ms: 0, error: 'Invalid speed test URL' });
        return;
      }

      const proxySocket = new net.Socket();
      sockets.add(proxySocket);
      proxySocket.setTimeout(connectTimeout);
      proxySocket.on('timeout', () => finish({ mbps: 0, bytes: 0, ms: 0, error: 'Proxy connect timed out' }));
      proxySocket.on('error', (err) => finish({ mbps: 0, bytes: 0, ms: 0, error: err.message }));

      // Reads the HTTP response off `stream`, counting body bytes.
      const consume = (stream) => {
        let headerDone = false;
        let buffered = Buffer.alloc(0);
        let bytes = 0;
        let firstByteAt = 0;
        let stopTimer = null;

        const complete = () => {
          const ms = firstByteAt ? Date.now() - firstByteAt : 0;
          if (!bytes || ms <= 0) {
            finish({ mbps: 0, bytes, ms: 0, error: 'No data received' });
            return;
          }
          const mbps = (bytes * 8) / (ms / 1000) / 1_000_000;
          finish({ mbps: Math.round(mbps * 100) / 100, bytes, ms });
        };

        stream.on('data', (chunk) => {
          if (!headerDone) {
            buffered = Buffer.concat([buffered, chunk]);
            const boundary = buffered.indexOf('\r\n\r\n');
            if (boundary === -1) {
              if (buffered.length > 64 * 1024) {
                finish({ mbps: 0, bytes: 0, ms: 0, error: 'Malformed HTTP response' });
              }
              return;
            }
            const head = buffered.toString('latin1', 0, boundary);
            const statusLine = head.split('\r\n')[0] || '';
            const status = Number(statusLine.split(' ')[1]);

            if (status >= 300 && status < 400) {
              const location = /^location:\s*(.+)$/im.exec(head);
              if (location && redirectsLeft > 0) {
                sockets.delete(proxySocket);
                proxySocket.destroy();
                attempt(new URL(location[1].trim(), target.href).href, redirectsLeft - 1);
                return;
              }
              finish({ mbps: 0, bytes: 0, ms: 0, error: `Redirect loop (HTTP ${status})` });
              return;
            }
            if (!(status >= 200 && status < 300)) {
              finish({ mbps: 0, bytes: 0, ms: 0, error: `Speed test server returned HTTP ${status}` });
              return;
            }

            headerDone = true;
            const bodyStart = buffered.subarray(boundary + 4);
            buffered = Buffer.alloc(0);
            firstByteAt = Date.now();
            bytes += bodyStart.length;
            stopTimer = setTimeout(complete, durationMs);
            return;
          }

          bytes += chunk.length;
          if (bytes >= maxBytes) {
            if (stopTimer) clearTimeout(stopTimer);
            complete();
          }
        });

        stream.on('end', () => {
          if (stopTimer) clearTimeout(stopTimer);
          if (headerDone) complete();
        });
        stream.on('error', (err) => finish({ mbps: 0, bytes: 0, ms: 0, error: err.message }));
      };

      const sendRequest = (stream, requestPath) => {
        stream.write(
          `GET ${requestPath} HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            'User-Agent: AwesomeProxy/1.0 speedtest\r\n' +
            'Accept: */*\r\n' +
            'Accept-Encoding: identity\r\n' +
            'Connection: close\r\n\r\n'
        );
      };

      proxySocket.connect(proxyPort, proxyHost, () => {
        proxySocket.setTimeout(0);
        if (!target.secure) {
          // Plain HTTP through an HTTP proxy: absolute-form request target.
          consume(proxySocket);
          sendRequest(proxySocket, target.href);
          return;
        }

        // HTTPS: CONNECT tunnel first, then TLS inside it.
        let connectBuffer = '';
        const onConnectData = (chunk) => {
          connectBuffer += chunk.toString('latin1');
          const boundary = connectBuffer.indexOf('\r\n\r\n');
          if (boundary === -1) return;
          proxySocket.removeListener('data', onConnectData);
          const status = Number((connectBuffer.split(' ')[1] || '').trim());
          if (status !== 200) {
            finish({ mbps: 0, bytes: 0, ms: 0, error: `Proxy CONNECT failed (HTTP ${status})` });
            return;
          }
          const tlsSocket = tls.connect(
            { socket: proxySocket, servername: target.host },
            () => {
              consume(tlsSocket);
              sendRequest(tlsSocket, target.path);
            }
          );
          sockets.add(tlsSocket);
          tlsSocket.on('error', (err) => finish({ mbps: 0, bytes: 0, ms: 0, error: err.message }));
        };
        proxySocket.on('data', onConnectData);
        proxySocket.write(
          `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`
        );
      });
    };

    attempt(url, maxRedirects);
  });
}

/**
 * Download through the local proxy port and measure throughput, falling through
 * a list of endpoints until one serves data.
 *
 * The fallback matters: an endpoint that refuses our request (Cloudflare answers
 * 403 to non-browser clients) is indistinguishable from a dead node if we only
 * ever try one host. A caller that passes an explicit `url` gets exactly that
 * one and no fallbacks.
 */
async function speedProbe(options = {}) {
  const candidates = options.url ? [options.url] : options.urls || DEFAULT_SPEED_URLS;
  let last = { mbps: 0, bytes: 0, ms: 0, error: 'No speed test endpoint reachable' };
  for (const url of candidates) {
    last = await speedProbeOnce({ ...options, url });
    if (last.mbps > 0) return last;
  }
  return last;
}

module.exports = {
  tcpPing,
  clashDelay,
  udpProbe,
  speedProbe,
  speedProbeOnce,
  DEFAULT_DELAY_URL,
  DEFAULT_SPEED_URL,
  DEFAULT_SPEED_URLS,
};

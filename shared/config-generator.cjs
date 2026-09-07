/**
 * Shared sing-box config generator.
 *
 * This module is the SINGLE SOURCE OF TRUTH for translating ProxyNode objects
 * into a sing-box configuration. It is consumed by both:
 *   - server/index.js   (web mode backend)
 *   - electron/main.ts  (Electron main process, via require)
 *
 * Target core: sing-box 1.13.x
 *
 * Schema notes (verified against sing-box 1.13.12):
 *   - The `dns` and `block` outbound TYPES were removed in 1.13.0.
 *     DNS hijacking is now done with a route rule action ("hijack-dns") and
 *     blocking with the "reject" rule action.
 *   - `transport` must NOT be emitted for plain TCP. Only ws/grpc/http/quic
 *     are valid transport types. Emitting `{ type: "tcp" }` is a fatal error.
 *   - The legacy `geoip`/`geosite` route rules were removed in 1.12.0. We use
 *     `ip_is_private` + domain_suffix offline rules so startup never depends on
 *     downloading remote rule-sets (the deployment network blocks GitHub).
 *   - `route.default_domain_resolver` is required as of 1.12.0 to resolve
 *     server domains for dial fields.
 */

'use strict';

const VALID_TRANSPORTS = new Set(['ws', 'grpc', 'http', 'quic']);

// ==================== Core Version Gating ====================
//
// The config surface is NOT the same across cores, and the app can end up
// running a core newer than the one it shipped with, because Settings → About
// can upgrade sing-box independently of the app. So anything that only exists
// in a newer core has to be gated, or we generate a config the running core
// rejects outright ("json: unknown field ...") and nothing connects at all.
//
// Verified against both real binaries: 1.13.18 REJECTS `hysteria2.disable_chrome_parrot`,
// `obfs.type: gecko` and OpenVPN endpoints, all of which 1.14.0 accepts. Those
// three are what the gate is for.
//
// A gate is NOT enough on its own: `check` accepting a field does not mean the
// core will start with it. `rule_set.http_client` is the cautionary case — it is
// a valid 1.14 field that passes `check` and then fails at startup, so it stayed
// on the older `download_detour` spelling instead (see the `rule_set` block).
// Any new gated field has to be verified by actually RUNNING the core.
//
// `coreVersion` is passed in via settings by whichever side generates the config
// (electron/main.ts and server/index.js both detect it from the binary). When it
// is missing or unparseable we assume the OLDEST supported surface, because
// emitting a field the core does not know is fatal while omitting a new one
// merely loses an optimisation.
const CORE_1_14 = '1.14.0';

function compareCoreVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .replace(/^v/, '')
      // "1.14.0-rc.5" → [1, 14, 0]: a pre-release of X carries X's config
      // surface, so treating it as X is correct here.
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** True when `version` is at least `minimum`. Unknown versions are treated as older. */
function coreAtLeast(version, minimum) {
  if (!version || !/\d/.test(String(version))) return false;
  return compareCoreVersions(version, minimum) >= 0;
}

// TUN interface addresses. Exported so the Electron side can recognise (and
// filter out) our own adapter when listing this machine's LAN addresses.
const TUN_IPV4 = '198.18.0.1/30';
// Deliberately NOT fdfe:dcba:9876::1/126. That value is the one in sing-box's
// documentation, so every client that copied the example ends up on it —
// NekoBox/NekoRay included. Verified on a machine running both: `neko-tun` held
// 172.19.0.1 AND fdfe:dcba:9876::1, i.e. the exact pair we used to claim.
// A ULA is supposed to carry a randomly chosen global ID for precisely this
// reason, so we use our own instead of the copy-pasted one. (fd19:8180 echoes
// 198.18 from the IPv4 side purely as a mnemonic.)
const TUN_IPV6 = 'fd19:8180:9a3f::1/126';
const TUN_IPV4_PREFIX = '198.18.0.';

// Private IPv4 space, fed to the TUN's `route_exclude_address` when
// `tunBypassLocalNetworks` is on. Covers every bridge the Windows virtual
// network stacks use: WSL2's NAT and Hyper-V's Default Switch land somewhere in
// 172.16/12, Docker Desktop uses 172.17/16 plus 192.168.65/24, and a plain LAN
// is 192.168/16 or 10/8.
//
// IPv4 only, deliberately. Those stacks are all IPv4 NAT, and sing-box's own
// example pairs 192.168.0.0/16 with fc00::/7 — but OUR TUN address lives inside
// fc00::/7 (see TUN_IPV6), so excluding it would name the tunnel's own prefix as
// something to keep off the tunnel. Not worth the risk for no gain.
//
// 198.18.0.0/15 is absent on purpose even though it is also reserved: that is
// where the TUN itself sits.
const LOCAL_NETWORK_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

// ==================== Rule-Set URL Mapping ====================
// Used by split-mode domain routing to resolve rule_set tags to remote URLs.

const GEOSITE_BASE = 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite';
const GEOIP_BASE = 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geoip';
const GEOIP_LITE_BASE = 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo-lite/geoip';

const RULE_SET_URLS = {
  'geosite-openai': 'https://testingcf.jsdelivr.net/gh/Toperlock/sing-box-geosite@main/rule/OpenAI.srs',
  'geosite-anthropic': `${GEOSITE_BASE}/anthropic.srs`,
  'geosite-youtube': `${GEOSITE_BASE}/youtube.srs`,
  'geoip-google': `${GEOIP_BASE}/google.srs`,
  'geosite-google': `${GEOSITE_BASE}/google.srs`,
  'geosite-github': `${GEOSITE_BASE}/github.srs`,
  'geoip-telegram': `${GEOIP_BASE}/telegram.srs`,
  'geosite-telegram': `${GEOSITE_BASE}/telegram.srs`,
  'geoip-twitter': `${GEOIP_BASE}/twitter.srs`,
  'geosite-twitter': `${GEOSITE_BASE}/twitter.srs`,
  'geoip-facebook': `${GEOIP_BASE}/facebook.srs`,
  'geosite-facebook': `${GEOSITE_BASE}/facebook.srs`,
  'geoip-netflix': `${GEOIP_BASE}/netflix.srs`,
  'geosite-netflix': `${GEOSITE_BASE}/netflix.srs`,
  'geosite-disney': `${GEOSITE_BASE}/disney.srs`,
  'geosite-spotify': `${GEOSITE_BASE}/spotify.srs`,
  'geosite-tiktok': `${GEOSITE_BASE}/tiktok.srs`,
  'geoip-apple': `${GEOIP_LITE_BASE}/apple.srs`,
  'geosite-apple': `${GEOSITE_BASE}/apple.srs`,
  'geosite-amazon': `${GEOSITE_BASE}/amazon.srs`,
  'geosite-microsoft': `${GEOSITE_BASE}/microsoft.srs`,
  'geosite-category-games': `${GEOSITE_BASE}/category-games.srs`,
  'geosite-hbo': `${GEOSITE_BASE}/hbo.srs`,
  'geosite-primevideo': `${GEOSITE_BASE}/primevideo.srs`,
  'geosite-bilibili': `${GEOSITE_BASE}/bilibili.srs`,
  'geosite-geolocation-!cn': `${GEOSITE_BASE}/geolocation-!cn.srs`,
  'geoip-cn': `${GEOIP_BASE}/cn.srs`,
  'geosite-cn': `${GEOSITE_BASE}/cn.srs`,
  'geosite-reddit': `${GEOSITE_BASE}/reddit.srs`,
  'geosite-discord': `${GEOSITE_BASE}/discord.srs`,
  'geosite-twitch': `${GEOSITE_BASE}/twitch.srs`,
  'geosite-whatsapp': `${GEOSITE_BASE}/whatsapp.srs`,
  'geosite-line': `${GEOSITE_BASE}/line.srs`,
  'geosite-signal': `${GEOSITE_BASE}/signal.srs`,
  'geosite-linkedin': `${GEOSITE_BASE}/linkedin.srs`,
  'geosite-pinterest': `${GEOSITE_BASE}/pinterest.srs`,
  'geosite-steam': `${GEOSITE_BASE}/steam.srs`,
  'geosite-epicgames': `${GEOSITE_BASE}/epicgames.srs`,
  'geosite-playstation': `${GEOSITE_BASE}/playstation.srs`,
  'geosite-xbox': `${GEOSITE_BASE}/xbox.srs`,
  'geosite-nintendo': `${GEOSITE_BASE}/nintendo.srs`,
  'geosite-notion': `${GEOSITE_BASE}/notion.srs`,
  'geosite-dropbox': `${GEOSITE_BASE}/dropbox.srs`,
  'geosite-onedrive': `${GEOSITE_BASE}/onedrive.srs`,
  'geosite-gitlab': `${GEOSITE_BASE}/gitlab.srs`,
  'geosite-zoom': `${GEOSITE_BASE}/zoom.srs`,
  'geosite-slack': `${GEOSITE_BASE}/slack.srs`,
  'geosite-imgur': `${GEOSITE_BASE}/imgur.srs`,
  'geosite-medium': `${GEOSITE_BASE}/medium.srs`,
  'geosite-quora': `${GEOSITE_BASE}/quora.srs`,
  'geosite-wikimedia': `${GEOSITE_BASE}/wikimedia.srs`,
  'geosite-soundcloud': `${GEOSITE_BASE}/soundcloud.srs`,
  'geosite-deezer': `${GEOSITE_BASE}/deezer.srs`,
  'geosite-tidal': `${GEOSITE_BASE}/tidal.srs`,
  'geosite-hulu': `${GEOSITE_BASE}/hulu.srs`,
  'geosite-showtimeanytime': `${GEOSITE_BASE}/showtimeanytime.srs`,
  'geosite-imdb': `${GEOSITE_BASE}/imdb.srs`,
  'geosite-craigslist': `${GEOSITE_BASE}/craigslist.srs`,
  'geosite-ebay': `${GEOSITE_BASE}/ebay.srs`,
  'geosite-walmart': `${GEOSITE_BASE}/walmart.srs`,
  'geosite-shopee': `${GEOSITE_BASE}/shopee.srs`,
  'geosite-paypal': `${GEOSITE_BASE}/paypal.srs`,
  'geosite-stripe': `${GEOSITE_BASE}/stripe.srs`,
  'geosite-coursera': `${GEOSITE_BASE}/coursera.srs`,
  'geosite-udemy': `${GEOSITE_BASE}/udemy.srs`,
  'geosite-duolingo': `${GEOSITE_BASE}/duolingo.srs`,
  'geosite-xai': `${GEOSITE_BASE}/xai.srs`,
  'geosite-google-gemini': `${GEOSITE_BASE}/google-gemini.srs`,
  'geosite-deepseek': `${GEOSITE_BASE}/deepseek.srs`,
  'geosite-perplexity': `${GEOSITE_BASE}/perplexity.srs`,
  'geosite-huggingface': `${GEOSITE_BASE}/huggingface.srs`,
};

/**
 * Coerce a value to a usable TCP port, or 0 if it isn't one.
 * Guards against the UI handing us NaN / 0 / 70000 and sing-box refusing to
 * start on an invalid listener.
 */
function toPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 0;
  return port;
}

/**
 * Build a deterministic, unique outbound tag for a node.
 * Falls back to an index-based tag and de-duplicates collisions so the
 * selector/urtest references always resolve.
 */
function buildOutboundTags(nodes) {
  const tags = [];
  const seen = new Map();
  nodes.forEach((node, index) => {
    let base = (node && (node.tag || node.name)) || `node-${index}`;
    base = String(base).trim() || `node-${index}`;
    let tag = base;
    if (seen.has(tag)) {
      const count = seen.get(tag) + 1;
      seen.set(tag, count);
      tag = `${base}-${count}`;
    } else {
      seen.set(tag, 0);
    }
    tags.push(tag);
  });
  return tags;
}

/**
 * Build the transport object for a node, or undefined for plain TCP.
 * Emitting a transport block for "tcp" is invalid in sing-box and is the
 * main reason vmess/vless nodes previously failed to start.
 */
function buildTransport(node) {
  const type = node.transportType;
  if (!type || type === 'tcp' || !VALID_TRANSPORTS.has(type)) {
    return undefined;
  }

  switch (type) {
    case 'ws': {
      const transport = { type: 'ws' };
      if (node.transportPath) transport.path = node.transportPath;
      if (node.transportHost) transport.headers = { Host: node.transportHost };
      return transport;
    }
    case 'grpc': {
      const transport = { type: 'grpc' };
      if (node.transportPath) transport.service_name = node.transportPath;
      return transport;
    }
    case 'http': {
      const transport = { type: 'http' };
      if (node.transportPath) transport.path = node.transportPath;
      if (node.transportHost) transport.host = [node.transportHost];
      return transport;
    }
    case 'quic':
      return { type: 'quic' };
    default:
      return undefined;
  }
}

/**
 * Build a TLS block for protocols where TLS is optional (vmess/vless).
 * Returns undefined when TLS is disabled. Supports Reality and uTLS
 * fingerprint for VLESS+Reality nodes.
 */
function buildOptionalTls(node) {
  if (!node.tls) return undefined;
  const tls = { enabled: true, server_name: node.sni || node.server };
  if (node.allowInsecure) tls.insecure = true;
  if (node.realityPublicKey) {
    tls.reality = { enabled: true, public_key: node.realityPublicKey };
    if (node.realityShortId) tls.reality.short_id = node.realityShortId;
  }
  if (node.fingerprint) {
    tls.utls = { enabled: true, fingerprint: node.fingerprint };
  } else if (tls.reality) {
    // uTLS is MANDATORY for a Reality client in sing-box: without it the core
    // refuses to start at all with
    //   "create service: initialize outbound[N]: uTLS is required by reality
    //    client"
    // which surfaces to the user as the whole app failing to connect, not as a
    // problem with one node. Reality links normally carry `fp`, but not all
    // generators include it, so default to chrome rather than emit a config the
    // core rejects.
    tls.utls = { enabled: true, fingerprint: 'chrome' };
  }
  return tls;
}

/**
 * Build a mandatory TLS block (trojan/hysteria2 are always TLS).
 */
function buildRequiredTls(node) {
  const tls = { enabled: true, server_name: node.sni || node.server };
  if (node.allowInsecure) tls.insecure = true;
  return tls;
}

// Shadowsocks 2022 methods take a base64-encoded key of an exact length, not a
// free-form password. Feeding them a plain password is a FATAL error that kills
// the whole core ("decode key: illegal base64 data"), not just that one node.
const SS2022_KEY_BYTES = {
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32,
};

/** True when `value` is base64 decoding to exactly `bytes` bytes. */
function isBase64OfLength(value, bytes) {
  if (typeof value !== 'string' || !value) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === bytes;
  } catch {
    return false;
  }
}

function isValidSs2022Key(method, password) {
  const expected = SS2022_KEY_BYTES[method];
  if (!expected) return true; // not a 2022 method, nothing to validate
  return isBase64OfLength(password, expected);
}

/**
 * Can this node be emitted without the core refusing to START?
 *
 * `sing-box check` passes some configs that then abort at service creation, so
 * a schema-valid config is not enough. Anything rejected here is left out of the
 * config entirely — including from the selector and urltest groups — so ONE
 * malformed node can no longer stop every other node from working. Returns a
 * reason string when unusable, or null when fine.
 */
function nodeRejectionReason(node, coreVersion) {
  if (!node || typeof node !== 'object') return 'not an object';
  if (!node.type) return 'missing protocol';
  if (!node.server) return 'missing server address';
  if (!toPort(node.port)) return 'invalid port';

  // Gecko obfuscation was added in sing-box 1.14.0. Emitting it against an
  // older core is fatal, and quietly dropping the obfs instead would be worse
  // than skipping: a server that requires obfs rejects an unobfuscated client,
  // so the node would fail anyway with no explanation. Skip it with a reason.
  if (node.type === 'hysteria2' && node.obfsType === 'gecko' && !coreAtLeast(coreVersion, CORE_1_14)) {
    return 'obfs "gecko" requires sing-box 1.14.0 or newer (Settings → About → Upgrade Core)';
  }

  if (node.type === 'shadowsocks' || node.type === 'shadowtls') {
    const method = node.method || (node.type === 'shadowtls' ? 'aes-128-gcm' : 'aes-256-gcm');
    if (!isValidSs2022Key(method, node.password)) {
      return `method ${method} needs a base64 key of ${SS2022_KEY_BYTES[method]} bytes`;
    }
  }
  if (node.type === 'wireguard') {
    // WireGuard keys are 32 raw bytes, base64-encoded. A wrong length aborts
    // the whole core at startup ("failed to set private_key: hex string does not
    // fit the slice"), so a single mistyped key would take every node down.
    if (!node.privateKey) return 'missing WireGuard private key';
    if (!isBase64OfLength(node.privateKey, 32)) return 'WireGuard private key must be 32 bytes of base64';
    if (!node.peerPublicKey) return 'missing WireGuard peer public key';
    if (!isBase64OfLength(node.peerPublicKey, 32)) return 'WireGuard peer public key must be 32 bytes of base64';
    if (node.preSharedKey && !isBase64OfLength(node.preSharedKey, 32)) {
      return 'WireGuard pre-shared key must be 32 bytes of base64';
    }
  }
  if ((node.type === 'vmess' || node.type === 'vless' || node.type === 'tuic') && !node.uuid) {
    return 'missing uuid';
  }
  if (node.type === 'openvpn') {
    const reason = openvpnRejectionReason(node, coreVersion);
    if (reason) return reason;
  }
  return null;
}

/**
 * Validation for OpenVPN nodes, which needs to be stricter than the rest.
 *
 * Most bad node settings only break that node. A malformed OpenVPN
 * control-channel key instead makes sing-box 1.14.0 **panic**, and a panic takes
 * the entire process down — every other node with it. Measured against the
 * bundled 1.14.0 core:
 *
 *   tls_auth / tls_crypt with a 256-byte key  -> fine
 *   tls_auth / tls_crypt with 128 or 512 byte -> panic, exit code 2
 *   tls_crypt_v2 (any key we could construct) -> panic, exit code 2
 *
 * The panic is inside sing-openvpn (client_session_tls.go setReady on a nil
 * client) and `sing-box check` does not catch it, so the only safe place to stop
 * it is here, before the endpoint is ever written.
 */
function openvpnRejectionReason(node, coreVersion) {
  if (!coreAtLeast(coreVersion, CORE_1_14)) {
    return 'OpenVPN requires sing-box 1.14.0 or newer (Settings → About → Upgrade Core)';
  }
  // TLS mode always needs a trust anchor; we only generate TLS mode.
  if (!node.ovpnCa || !/BEGIN CERTIFICATE/.test(node.ovpnCa)) {
    return 'missing OpenVPN CA certificate (the <ca> block of the .ovpn file)';
  }
  // The core requires both halves or neither.
  if (Boolean(node.ovpnClientCert) !== Boolean(node.ovpnClientKey)) {
    return 'OpenVPN client certificate and key must both be present or both absent';
  }
  if (node.ovpnControlWrapType) {
    if (node.ovpnControlWrapType === 'tls_crypt_v2') {
      return 'tls-crypt-v2 is not supported yet: sing-box 1.14.0 crashes on it, which would take every other node down';
    }
    if (node.ovpnControlWrapType !== 'tls_auth' && node.ovpnControlWrapType !== 'tls_crypt') {
      return `unknown OpenVPN control channel wrapping "${node.ovpnControlWrapType}"`;
    }
    const bytes = openvpnStaticKeyBytes(node.ovpnControlWrapKey);
    if (bytes < 0) return 'OpenVPN tls-auth/tls-crypt key is not a valid OpenVPN Static key V1';
    if (bytes !== OPENVPN_STATIC_KEY_BYTES) {
      return `OpenVPN tls-auth/tls-crypt key must be ${OPENVPN_STATIC_KEY_BYTES} bytes, got ${bytes} (a wrong size crashes the core)`;
    }
  }
  return null;
}

/**
 * Reason an otherwise-VALID node is left out of this particular config.
 *
 * Distinct from nodeRejectionReason: nothing is wrong with the node, it just
 * cannot coexist with the current selection.
 *
 * OpenVPN is the only case. An `openvpn-client` endpoint dials its server at
 * STARTUP and holds the session open whether or not anything routes through it —
 * verified against 1.14.0 by pointing an endpoint that no selector, urltest or
 * route rule referenced at a UDP socket we owned, and still receiving its
 * handshake. That is inherent to endpoints: they are interfaces, not lazy
 * dialers.
 *
 * So emitting every imported profile opens every VPN session simultaneously.
 * Providers cap concurrent sessions per account (free tiers commonly at one), so
 * the first profile connects and the rest silently never establish — no error,
 * just a node that never works. Exactly what a user hit with three ProtonVPN
 * profiles: one logged "tunnel established", the other two logged nothing.
 *
 * Emitting only the selected profile keeps at most one session alive, and none
 * at all while a non-OpenVPN node is selected. The cost is that switching to or
 * between OpenVPN nodes cannot use the Clash API live-switch, because the tag
 * isn't in the running config; switchNode already falls back to a restart.
 */
function nodeInactiveReason(node, tag, selectedTag) {
  if (node && node.type === 'openvpn' && tag !== selectedTag) {
    return 'OpenVPN profiles connect one at a time, so this one is only dialled while it is the selected node';
  }
  return null;
}

/**
 * True for protocols that must be emitted as a top-level `endpoints` entry
 * rather than an `outbounds` entry.
 *
 * WireGuard is the only one currently: the WireGuard *outbound* was deprecated
 * in sing-box 1.11.0 and REMOVED in 1.13.0, replaced by an endpoint. Endpoint
 * tags are still referenced from selectors/route rules exactly like outbound
 * tags, so nothing else in the config has to know the difference.
 */
function isEndpointProtocol(type) {
  return type === 'wireguard' || type === 'openvpn';
}

/**
 * Split a PEM / OpenVPN key blob into the line array sing-box expects.
 *
 * A single multi-line string is also accepted by the core, but the line array
 * matches the documented shape and survives JSON round-tripping without
 * depending on how the editor normalised newlines.
 */
function pemLines(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Byte length of an OpenVPN Static key V1 blob, or -1 if it isn't one.
 *
 * Used to keep a malformed control-channel key out of the config: see
 * nodeRejectionReason for why that matters more than usual here.
 */
function openvpnStaticKeyBytes(text) {
  if (typeof text !== 'string' || !/BEGIN\s+OpenVPN\s+Static\s+key/i.test(text)) return -1;
  const hex = text.replace(/-----[^-]*-----/g, '').replace(/\s+/g, '');
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return -1;
  return hex.length / 2;
}

/** OpenVPN static keys are always 2048-bit; anything else makes the core panic. */
const OPENVPN_STATIC_KEY_BYTES = 256;

/**
 * Convert an OpenVPN ProxyNode into a sing-box `openvpn-client` endpoint.
 *
 * Only TLS mode is generated. `static_key` mode is a pre-TLS OpenVPN dialect
 * with no forward secrecy that upstream keeps purely for immutable enterprise
 * servers; it shares almost no fields with TLS mode, so supporting it would mean
 * a second parallel shape for a configuration nobody hands out today.
 */
function nodeToOpenvpnEndpoint(node, tag) {
  const tls = { certificate: pemLines(node.ovpnCa) };
  // OpenVPN verifies the server certificate NAME rather than sending SNI, so
  // this is `verify-x509-name`, not a TLS SNI. Left unset means the chain is
  // still verified but the name is not.
  if (node.sni) tls.server_name = node.sni;
  if (node.ovpnClientCert && node.ovpnClientKey) {
    tls.client_certificate = pemLines(node.ovpnClientCert);
    tls.client_key = pemLines(node.ovpnClientKey);
  }
  if (node.ovpnControlWrapType && node.ovpnControlWrapKey) {
    tls.control_wrap = {
      type: node.ovpnControlWrapType,
      key: pemLines(node.ovpnControlWrapKey),
    };
    // Only meaningful for tls-auth; tls-crypt keys are used bidirectionally.
    if (node.ovpnControlWrapType === 'tls_auth' && node.ovpnControlWrapDirection) {
      tls.control_wrap.direction = node.ovpnControlWrapDirection;
    }
  }

  const endpoint = {
    type: 'openvpn-client',
    tag,
    server: node.server,
    server_port: node.port,
    network: node.ovpnNetwork === 'tcp' ? 'tcp' : 'udp',
    tls,
  };
  if (node.username) endpoint.username = node.username;
  if (node.password) endpoint.password = node.password;
  if (Array.isArray(node.ovpnDataCiphers) && node.ovpnDataCiphers.length) {
    endpoint.data_ciphers = node.ovpnDataCiphers;
  }
  // `cipher` in an .ovpn file is the pre-negotiation cipher, which maps to
  // data_ciphers_fallback rather than to data_ciphers.
  if (node.ovpnDataCiphersFallback) endpoint.data_ciphers_fallback = node.ovpnDataCiphersFallback;
  if (node.ovpnAuth) endpoint.auth = node.ovpnAuth;
  if (node.ovpnCompressionLzo) endpoint.compression_lzo = node.ovpnCompressionLzo;
  if (node.mtu) endpoint.mtu = node.mtu;
  return endpoint;
}

/**
 * Convert a WireGuard ProxyNode into a sing-box `endpoints` entry.
 */
function nodeToEndpoint(node, tag) {
  if (node.type === 'openvpn') return nodeToOpenvpnEndpoint(node, tag);
  const endpoint = {
    type: 'wireguard',
    tag,
    address: Array.isArray(node.localAddress) && node.localAddress.length
      ? node.localAddress
      : ['10.0.0.2/32'],
    private_key: node.privateKey || '',
    peers: [
      {
        address: node.server,
        port: node.port,
        public_key: node.peerPublicKey || '',
        // Route everything through the peer unless told otherwise.
        allowed_ips: ['0.0.0.0/0', '::/0'],
      },
    ],
  };
  if (node.preSharedKey) endpoint.peers[0].pre_shared_key = node.preSharedKey;
  if (Array.isArray(node.reserved) && node.reserved.length === 3) {
    endpoint.peers[0].reserved = node.reserved;
  }
  if (node.persistentKeepalive) {
    endpoint.peers[0].persistent_keepalive_interval = node.persistentKeepalive;
  }
  if (node.mtu) endpoint.mtu = node.mtu;
  return endpoint;
}

/**
 * Convert a single ProxyNode into one or more sing-box outbound objects.
 *
 * Returns an ARRAY because some protocols need a helper outbound alongside the
 * primary one (ShadowTLS). The FIRST element is always the primary outbound and
 * its tag equals `tag` — that's what selectors/route rules reference. Any extra
 * elements are internal helpers with derived tags.
 */
function nodeToOutbounds(node, tag, coreVersion) {
  // ShadowTLS is a TLS-camouflage *wrapper*, not a standalone proxy: the real
  // payload is a Shadowsocks connection tunnelled through it. So we emit the
  // shadowtls outbound as a helper and point a shadowsocks outbound at it via
  // `detour`, keeping `tag` on the shadowsocks one so it stays the thing the
  // rest of the config selects.
  if (node.type === 'shadowtls') {
    const helperTag = `${tag}-shadowtls`;
    const helper = {
      type: 'shadowtls',
      tag: helperTag,
      server: node.server,
      server_port: node.port,
      version: node.shadowTlsVersion || 3,
      tls: buildRequiredTls(node),
    };
    // v1 has no password; v2/v3 require one.
    if ((node.shadowTlsVersion || 3) !== 1 && node.shadowTlsPassword) {
      helper.password = node.shadowTlsPassword;
    }
    const primary = {
      type: 'shadowsocks',
      tag,
      // Deliberately NOT a 2022-blake3-* default: those require a base64 key of
      // an exact length, so defaulting to one turns any node that omits `method`
      // into a fatal startup error. A classic AEAD accepts any password.
      method: node.method || 'aes-128-gcm',
      password: node.password,
      detour: helperTag,
    };
    return [primary, helper];
  }

  return [nodeToOutbound(node, tag, coreVersion)];
}

/**
 * Convert a single ProxyNode into a sing-box outbound object.
 */
function nodeToOutbound(node, tag, coreVersion) {
  switch (node.type) {
    case 'vmess': {
      const outbound = {
        type: 'vmess',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: node.uuid,
        alter_id: node.alterId || 0,
        security: node.security || 'auto',
      };
      const tls = buildOptionalTls(node);
      if (tls) outbound.tls = tls;
      const transport = buildTransport(node);
      if (transport) outbound.transport = transport;
      return outbound;
    }

    case 'vless': {
      const outbound = {
        type: 'vless',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: node.uuid,
      };
      if (node.flow) outbound.flow = node.flow;
      const tls = buildOptionalTls(node);
      if (tls) outbound.tls = tls;
      const transport = buildTransport(node);
      if (transport) outbound.transport = transport;
      return outbound;
    }

    case 'trojan': {
      const outbound = {
        type: 'trojan',
        tag,
        server: node.server,
        server_port: node.port,
        password: node.password,
        tls: buildRequiredTls(node),
      };
      const transport = buildTransport(node);
      if (transport) outbound.transport = transport;
      return outbound;
    }

    case 'shadowsocks':
      return {
        type: 'shadowsocks',
        tag,
        server: node.server,
        server_port: node.port,
        method: node.method || 'aes-256-gcm',
        password: node.password,
      };

    case 'hysteria2': {
      const outbound = {
        type: 'hysteria2',
        tag,
        server: node.server,
        password: node.password,
        tls: buildRequiredTls(node),
      };
      // Port hopping: `server_ports` CONFLICTS with `server_port`, so emit
      // exactly one of them. sing-box ignores server_port when server_ports is
      // set, but emitting both is rejected as a conflict.
      if (Array.isArray(node.serverPorts) && node.serverPorts.length) {
        outbound.server_ports = node.serverPorts;
        if (node.hopInterval) outbound.hop_interval = node.hopInterval;
      } else {
        outbound.server_port = node.port;
      }
      // QUIC traffic obfuscation. Both type and password are needed for it to
      // do anything; a server configured with obfs will reject clients without.
      // "gecko" only exists in 1.14+, and nodeRejectionReason already skips such
      // a node on an older core, so by here the type is safe to emit.
      if (node.obfsType && node.obfsPassword) {
        outbound.obfs = { type: node.obfsType, password: node.obfsPassword };
      }
      // Bandwidth hints. Omit entirely to let sing-box fall back to BBR.
      if (node.upMbps) outbound.up_mbps = node.upMbps;
      if (node.downMbps) outbound.down_mbps = node.downMbps;
      // sing-box 1.14 makes the QUIC handshake parrot Chrome by default, which
      // is good for censorship resistance but breaks one specific case: Chrome
      // does not advertise Ed25519, so a server presenting an Ed25519
      // certificate fails the handshake. That turns a node that worked on 1.13
      // into a dead node purely from upgrading the core, with nothing in the log
      // pointing at the cause — hence an explicit per-node escape hatch.
      if (node.disableChromeParrot && coreAtLeast(coreVersion, CORE_1_14)) {
        outbound.disable_chrome_parrot = true;
      }
      return outbound;
    }

    case 'tuic': {
      // TLS is REQUIRED for TUIC (it's QUIC-based).
      const outbound = {
        type: 'tuic',
        tag,
        server: node.server,
        server_port: node.port,
        uuid: node.uuid,
        tls: buildRequiredTls(node),
      };
      if (node.password) outbound.password = node.password;
      if (node.congestionControl) outbound.congestion_control = node.congestionControl;
      // `udp_relay_mode` conflicts with `udp_over_stream`; we only ever set the
      // former, so it's safe to pass through.
      if (node.udpRelayMode) outbound.udp_relay_mode = node.udpRelayMode;
      return outbound;
    }

    case 'anytls': {
      // TLS is REQUIRED for AnyTLS.
      return {
        type: 'anytls',
        tag,
        server: node.server,
        server_port: node.port,
        password: node.password,
        tls: buildRequiredTls(node),
      };
    }

    default:
      // Best-effort passthrough for unknown/unsupported types.
      return {
        type: node.type,
        tag,
        server: node.server,
        server_port: node.port,
      };
  }
}

/**
 * Generate a complete sing-box 1.13 configuration.
 *
 * @param {Array} nodes          List of ProxyNode objects.
 * @param {number} selectedIndex Index of the node selected as default.
 * @param {Object} settings      App settings (ports, mode, dns, routing).
 * @returns {Object} A sing-box configuration object.
 */
function generateSingboxConfig(nodes, selectedIndex, settings) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeSettings = settings || {};
  const tags = buildOutboundTags(safeNodes);
  // Version of the core this config will actually be handed to. See the Core
  // Version Gating notes at the top: unknown means "assume oldest".
  const coreVersion = safeSettings.coreVersion;

  // Materialize every node so the selector/urltest references always resolve
  // (previously only the selected node was emitted, leaving the selector
  // pointing at non-existent outbounds).
  //
  // Nodes split into two buckets by protocol: most become `outbounds`, but
  // WireGuard must become a top-level `endpoints` entry (the WireGuard
  // outbound was removed in sing-box 1.13). Endpoint tags are referenced from
  // selectors exactly like outbound tags, so `tags` stays a single flat list.
  // Nodes that would abort core startup are skipped rather than emitted. `tags`
  // is still built from the FULL list so it keeps matching the renderer's
  // buildOutboundTags (used for live selector switching); only the emitted
  // outbounds and the group memberships are filtered.
  // Resolved before the loop because the OpenVPN filter below depends on it.
  const selectedTag =
    selectedIndex >= 0 && selectedIndex < tags.length ? tags[selectedIndex] : null;

  const nodeOutbounds = [];
  const nodeEndpoints = [];
  const usableTags = [];
  const skipped = [];
  safeNodes.forEach((node, index) => {
    const reason = nodeRejectionReason(node, coreVersion);
    if (reason) {
      skipped.push({ tag: tags[index], reason });
      return;
    }
    // Valid, but must not be emitted alongside the current selection. See
    // nodeInactiveReason: an OpenVPN endpoint connects at startup regardless of
    // whether anything uses it, so every extra profile burns a session slot.
    const inactive = nodeInactiveReason(node, tags[index], selectedTag);
    if (inactive) {
      skipped.push({ tag: tags[index], reason: inactive });
      return;
    }
    if (isEndpointProtocol(node.type)) {
      nodeEndpoints.push(nodeToEndpoint(node, tags[index]));
    } else {
      nodeOutbounds.push(...nodeToOutbounds(node, tags[index], coreVersion));
    }
    usableTags.push(tags[index]);
  });

  const hasNodes = usableTags.length > 0;
  // Fall back to the first usable node when the selected one was skipped —
  // pointing a selector at a non-existent outbound is itself a fatal error.
  const defaultTag =
    selectedTag && usableTags.includes(selectedTag)
      ? selectedTag
      : hasNodes
      ? usableTags[0]
      : 'direct';

  const splitApps = Array.isArray(safeSettings.splitApps)
    ? safeSettings.splitApps.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const splitMode = safeSettings.splitMode === 'direct' ? 'direct' : 'proxy';
  const isSplit = safeSettings.proxyMode === 'split';

  // Local listener basics, shared by the mixed inbound and the optional
  // dedicated SOCKS/HTTP inbounds below.
  const listenAddress = safeSettings.allowLan ? '0.0.0.0' : '127.0.0.1';
  const mixedPort = toPort(safeSettings.mixedPort) || 7890;

  // IPv6 handling for TUN/Split. See AppSettings.ipv6Strategy for the rationale.
  //
  // Defaults to 'block': the TUN is dual-stack, so IPv6 ENTERS the tunnel and is
  // dealt with by the route rules (downgraded to IPv4, or refused as a backstop)
  // instead of escaping to the physical interface.
  //
  // The default has moved twice, so it is worth being explicit about why this is
  // where it lands.
  //
  // It was 'prefer-ipv4' — dual-stack TUN, IPv6 carried to the node. That broke
  // on IPv4-only nodes: the dual-stack TUN convinces Windows that IPv6 works, so
  // per RFC 6724 apps prefer IPv6 for nearly everything, and the node cannot
  // deliver it. Confirmed from a user's TUN log: every IPv6 destination logged
  // "inbound connection to [...]" and produced no outbound at all.
  //
  // It was then 'ipv4-only' — no IPv6 address on the TUN at all, which is what
  // mihomo/clash and v2rayN ship. That fixed the stall, but it does not capture
  // IPv6, so on a network with real IPv6 that traffic leaves via the physical
  // interface. Confirmed by a user: ip.sb in TUN mode reported their real IPv6
  // address. Fast and compatible, but it silently defeats the tunnel, which is
  // not an acceptable default for a proxy client.
  //
  // 'block' is the resolution, and it is only viable because of the IPv6→IPv4
  // downgrade added to the route rules below. Withholding AAAA via DNS never
  // worked (DoH browsers do not ask us) and rejecting outright made apps look
  // broken. Rewriting the destination to IPv4 at routing time fixes both: the
  // real address cannot leak because the packets are inside the tunnel, and the
  // request still completes over the IPv4-only node.
  //
  // 'ipv4-only' stays available: an IPv6-less TUN is the most compatible option
  // for virtual network stacks (WSL2 mirrored mode, Docker, Hyper-V), so it is
  // the fallback when the dual-stack TUN causes trouble there.
  const ipv6Strategy =
    safeSettings.ipv6Strategy === 'ipv4-only' || safeSettings.ipv6Strategy === 'prefer-ipv4'
      ? safeSettings.ipv6Strategy
      : 'block';

  // TCP/IP stack for the TUN inbound. See AppSettings.tunStack.
  //
  // This used to be hardcoded to 'gvisor' on the theory that a userspace
  // netstack is more resilient under sustained load. Measurement said the
  // opposite: video in TUN mode was extremely slow while the same node was fine
  // through the local mixed inbound, which points at the stack rather than the
  // node. gvisor reassembles every IP datagram into TCP streams in userspace,
  // so it is the most CPU-expensive of the three for bulk TCP.
  //
  // Nobody else forces it. sing-box's own default is 'mixed' when the gVisor
  // build tag is present (ours is), v2rayN ships 'system' in its TUN template,
  // and NekoRay exposes the choice as a user setting instead of picking one.
  // There are also reports of gvisor specifically misbehaving on Windows under
  // full-tunnel routing, so forcing it was the riskiest option available.
  //
  // Default is therefore 'mixed' — system TCP for throughput, gvisor UDP so
  // endpoint-independent NAT stays available — with the other two selectable
  // for anyone whose setup disagrees.
  const tunStack =
    safeSettings.tunStack === 'system' || safeSettings.tunStack === 'gvisor'
      ? safeSettings.tunStack
      : 'mixed';
  // `endpoint_independent_nat` is documented as gvisor-only; 'mixed' qualifies
  // because it uses the gvisor UDP stack, which is what this option governs.
  const stackSupportsEndpointIndependentNat = tunStack === 'gvisor' || tunStack === 'mixed';

  // Domain-based split rules (rule_set routing)
  const domainSplitRules = Array.isArray(safeSettings.splitRules)
    ? safeSettings.splitRules.filter((r) => r && r.enabled && Array.isArray(r.ruleSets) && r.ruleSets.length > 0)
    : [];

  // For each enabled domain split rule, create a selector outbound
  const splitSelectorOutbounds = [];
  const splitRouteRules = [];
  const usedRuleSetTags = new Set();

  if (isSplit && hasNodes && domainSplitRules.length > 0) {
    for (const rule of domainSplitRules) {
      const selectorTag = rule.name;
      // Determine the default for this selector
      let selectorDefault = rule.outbound || 'proxy';
      // The selector children: all node tags + auto + direct + proxy
      const selectorChildren = ['proxy', 'auto', 'direct', ...usableTags];
      // If the user's chosen outbound is a specific node tag, keep it as default
      if (!selectorChildren.includes(selectorDefault)) {
        selectorDefault = 'proxy';
      }

      splitSelectorOutbounds.push({
        type: 'selector',
        tag: selectorTag,
        outbounds: selectorChildren,
        default: selectorDefault,
      });

      splitRouteRules.push({
        rule_set: rule.ruleSets,
        outbound: selectorTag,
      });

      for (const rsTag of rule.ruleSets) {
        usedRuleSetTags.add(rsTag);
      }
    }
  }

  // Legacy per-app process_name rules (still supported alongside domain rules)
  const legacySplitRules =
    isSplit && hasNodes && splitApps.length > 0
      ? [{ process_name: splitApps, outbound: splitMode === 'proxy' ? 'proxy' : 'direct' }]
      : [];

  // Final/default outbound. When domain split rules exist, default to "proxy"
  // so unlisted traffic goes through the proxy. When only legacy app rules
  // exist, use the old flipped-default behavior.
  let finalOutbound;
  if (!hasNodes) {
    finalOutbound = 'direct';
  } else if (isSplit && domainSplitRules.length > 0) {
    finalOutbound = 'proxy';
  } else if (isSplit) {
    finalOutbound = splitMode === 'proxy' ? 'direct' : 'proxy';
  } else {
    finalOutbound = 'proxy';
  }

  const outbounds = [];

  if (hasNodes) {
    outbounds.push({
      type: 'selector',
      tag: 'proxy',
      outbounds: ['auto', 'direct', ...usableTags],
      default: defaultTag,
    });
    outbounds.push({
      type: 'urltest',
      tag: 'auto',
      outbounds: [...usableTags],
      // Cloudflare's captive-portal endpoint instead of Google's: it answers
      // 204 from anycast almost everywhere, whereas gstatic.com is blocked on
      // some networks — and a health-check URL the node can't reach makes a
      // perfectly good node look dead to the urltest group.
      url: 'https://cp.cloudflare.com/generate_204',
      interval: '3m',
      tolerance: 50,
    });
  }

  outbounds.push(...nodeOutbounds);
  outbounds.push(...splitSelectorOutbounds);
  outbounds.push({ type: 'direct', tag: 'direct' });

  // DNS detour rules (verified against sing-box 1.13.12 at runtime):
  //   - A DNS server may NOT detour through a bare `direct` outbound; sing-box
  //     rejects it ("detour to an empty direct outbound makes no sense").
  //     So `direct-dns` carries no detour and resolves directly.
  //   - DoH servers addressed by domain need a `domain_resolver` to bootstrap
  //     their own hostname. We use a `local` server (the OS resolver) which
  //     needs no detour and no bootstrap, breaking the chicken-and-egg cycle.
  //   - `remote-dns` only routes through `proxy` when proxy nodes exist;
  //     otherwise it resolves directly (no `proxy` outbound is present).
  // Cloudflare DoH, addressed by IP LITERAL rather than hostname.
  //
  // Two reasons for the literal. First it removes the bootstrap dependency
  // entirely: a hostname (dns.google, cloudflare-dns.com) has to be resolved by
  // local-dns first, and on a network where the local resolver is poisoned or
  // hijacked that lookup is exactly what fails — taking the encrypted resolver
  // down with it. Second, Cloudflare's certificate carries 1.1.1.1 as an IP SAN,
  // so TLS still verifies properly.
  const remoteDns = {
    tag: 'remote-dns',
    type: 'https',
    server: '1.1.1.1',
    path: '/dns-query',
  };
  if (hasNodes) remoteDns.detour = 'proxy';

  const config = {
    log: { level: safeSettings.logLevel || 'info', timestamp: true },
    dns: {
      servers: [
        // sing-box's `local` server does NOT resolve `localhost`: measured
        // against the bundled core, a lookup goes to the upstream resolver and
        // comes back NXDOMAIN, so a request naming localhost dies even when it
        // was correctly routed direct. Windows resolves it via the hosts file /
        // its own special-casing, which the core does not consult. Answering it
        // ourselves is the only way to make the name usable inside the tunnel.
        {
          tag: 'hosts-dns',
          type: 'hosts',
          predefined: { localhost: ['127.0.0.1', '::1'] },
        },
        { tag: 'local-dns', type: 'local' },
        remoteDns,
        // AliDNS for the China-direct split, also by IP literal (its cert
        // carries 223.5.5.5 as an IP SAN) so it needs no bootstrap either.
        { tag: 'direct-dns', type: 'https', server: '223.5.5.5', path: '/dns-query' },
      ],
      // CLIENT-facing resolution strategy. This is what the browser/OS sees.
      //
      // `prefer_ipv4` does NOT withhold AAAA — it only ORDERS the answers. In
      // TUN mode the client issues its own A and AAAA queries and sing-box
      // answers both, and because a dual-stack TUN makes Windows believe it has
      // real IPv6 connectivity, the OS then prefers IPv6 per RFC 6724. So
      // serving `prefer_ipv4` effectively means "use IPv6 for everything".
      //
      //   'prefer-ipv4' → `prefer_ipv4`. The UI calls this "Allow IPv6". The
      //     user has opted in to carrying IPv6 through the tunnel, so AAAA has
      //     to reach the client or nothing ever uses IPv6 and the option does
      //     nothing. Withholding it here was a real bug: the tunnel was
      //     dual-stack and ready, ip.sb still reported no IPv6, because every
      //     cooperating app was only ever handed an A record. Requires the
      //     node's server to have IPv6 egress.
      //
      //   'block' → `ipv4_only`. Clients never attempt IPv6, so there is
      //     nothing to stall on; the reject rule is then only a backstop for
      //     IPv6 literals that bypass DNS.
      //
      //   'ipv4-only' → `ipv4_only`. The TUN has no IPv6 route at all, so
      //     handing out AAAA would push traffic onto the physical interface,
      //     i.e. straight past the tunnel.
      //
      // Note this only governs apps that ask US. Browsers with built-in DoH
      // resolve AAAA themselves regardless, which is why the default keeps IPv6
      // off the TUN entirely rather than relying on DNS. See ipv6Strategy.
      strategy: ipv6Strategy === 'prefer-ipv4' ? 'prefer_ipv4' : 'ipv4_only',
      rules: [
        { domain_suffix: ['.cn', '.baidu.com', '.qq.com', '.taobao.com', '.jd.com', '.alipay.com'], server: 'direct-dns' },
      ],
      final: 'remote-dns',
    },
    // Only emitted when WireGuard nodes exist — an empty `endpoints` array is
    // accepted but pointless noise in the generated config.
    ...(nodeEndpoints.length ? { endpoints: nodeEndpoints } : {}),
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        // Binding 0.0.0.0 exposes this proxy to the whole local network, so it
        // is strictly opt-in. Note there is no inbound authentication here —
        // anyone who can reach the port can use the proxy.
        listen: listenAddress,
        listen_port: mixedPort,
      },
    ],
    outbounds,
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        // Turn `localhost` into an address before the IP rules run.
        //
        // `route.default_domain_resolver` pins outbound resolution to local-dns
        // and bypasses dns.rules entirely, so a dns rule cannot fix this — only
        // the resolve action, which takes its own `server`. Verified against the
        // bundled core: with this rule a request to http://localhost:PORT
        // reaches the local server; without it, it fails NXDOMAIN.
        { domain: ['localhost'], action: 'resolve', server: 'hosts-dns' },
        // Private ranges stay direct. Deliberately BEFORE the IPv6 reject so
        // link-local / ULA IPv6 (fe80::, fc00::) keeps working on the LAN.
        { ip_is_private: true, outbound: 'direct' },
        // Names that can only mean "this machine or this network".
        //
        // The rule above cannot catch these. It matches a RESOLVED IP, and
        // sing-box resolves a destination only when an explicit
        // `action: "resolve"` rule asks it to, so a request that names a host
        // falls straight through to `final` — the proxy. Measured through our
        // own inbound against a local web server: http://127.0.0.1:PORT
        // returned 200 while http://localhost:PORT was reset, because the
        // latter was sent out through the remote node.
        //
        // This matters most for clients that never see Windows' ProxyOverride:
        // WSL2 with http_proxy pointed at us is exactly that, and so is any app
        // given an explicit proxy. The `domain_regex` is the equivalent of
        // Windows' `<local>` token — a single-label name cannot be a public
        // site, so it belongs to the local network by definition.
        //
        // Two limits worth knowing, both of which the Windows bypass list
        // (ProxyOverride, set by the app when it enables the system proxy)
        // handles instead:
        //   - A SINGLE-LABEL name cannot be resolved by the core at all.
        //     Windows finds those via NetBIOS/mDNS, which sing-box does not
        //     speak; measured, this machine's own name returns NXDOMAIN through
        //     every DNS server we could point at it. Sending them direct is
        //     still right — it keeps an internal hostname from being handed to
        //     a remote proxy — but only Windows can actually connect them.
        //   - Intranet hosts that merely RESOLVE to a private IP under a
        //     public-looking name are not matched here; catching those would
        //     mean resolving every domain before routing.
        {
          domain: ['localhost'],
          domain_suffix: ['.localhost', '.local', '.internal', '.lan', '.home.arpa'],
          domain_regex: ['^[^.]+$'],
          outbound: 'direct',
        },
        // 'block' mode, TUN/Split only: IPv6 is captured by the dual-stack TUN
        // and handled here rather than escaping via the physical interface,
        // which is what would leak the real address.
        //
        // Two rules, in this order, and the order is the whole point:
        //
        //   1. DOWNGRADE. `resolve` with an explicit `ipv4_only` strategy takes
        //      the domain recovered by the `sniff` rule at the top and re-resolves
        //      it to an A record, rewriting the destination from IPv6 to IPv4.
        //      The connection then proceeds normally through the proxy. This is
        //      what makes the mode usable: a browser with its own DoH (Brave,
        //      Chrome Secure DNS, Firefox) resolves AAAA without ever asking us,
        //      so `dns.strategy: ipv4_only` cannot keep it on IPv4 — but we can
        //      still put it back on IPv4 here, at routing time. `strategy` has to
        //      be set explicitly: without it the resolve inherits
        //      `default_domain_resolver`'s `prefer_ipv4`, which happily returns
        //      the AAAA again and the rewrite accomplishes nothing.
        //
        //   2. REJECT, as a backstop only. Reached when step 1 had nothing to
        //      work with: a hardcoded IPv6 literal with no sniffable domain
        //      (Chrome's Secure DNS bootstrap does exactly this, e.g.
        //      2606:4700:4700::1111), or a domain that is genuinely IPv6-only.
        //      `resolve` is non-terminal, so anything step 1 rewrote is IPv4 by
        //      now and no longer matches `ip_version: 6`.
        //
        // Previously this was the reject alone. That leaked nothing but read as
        // "the app is broken": reject is silent and fires only after the gvisor
        // stack has already completed the TCP handshake, so every DoH-resolved
        // IPv6 destination saw an established connection and then a reset. The
        // downgrade removes that for everything carrying an SNI/Host, which is
        // effectively all web traffic.
        //
        // In System/Manual mode there is no TUN, so the browser's IPv6 (and
        // its leaky WebRTC UDP) never enters sing-box at all. Rejecting here
        // would buy no privacy while breaking IPv6-only sites that the proxy
        // could otherwise reach, so we leave IPv6 alone in those modes.
        ...(ipv6Strategy === 'block' && (safeSettings.proxyMode === 'tun' || isSplit)
          ? [
              { ip_version: 6, action: 'resolve', strategy: 'ipv4_only' },
              { ip_version: 6, action: 'reject' },
            ]
          : []),
        ...splitRouteRules,
        ...legacySplitRules,
        ...(safeSettings.bypassChina
          ? [{ domain_suffix: ['.cn', '.baidu.com', '.qq.com', '.taobao.com', '.jd.com', '.alipay.com'], outbound: 'direct' }]
          : []),
      ],
      // Rule-sets download over the DIRECT path, not through the proxy: the
      // proxy may not be up yet at startup, and a rule-set fetch that waits on
      // it delays every route decision.
      //
      // `download_detour` is deprecated in 1.14 (removed in 1.16) in favour of
      // `http_client`, but it is kept UNCONDITIONALLY here, because none of the
      // replacements is usable yet:
      //   - `http_client: { detour: 'direct' }` passes `check` and then dies at
      //     startup with "detour to an empty direct outbound makes no sense" —
      //     the same bare-`direct` restriction the DNS block below documents.
      //     `download_detour: 'direct'` is exempt from it; the new inline
      //     `http_client` is not.
      //   - `http_client: {}` or omitting it works, but then rule-sets download
      //     through the *default* outbound (the proxy) and it warns about the
      //     also-deprecated implicit default HTTP client.
      //   - a top-level `http_clients` tag plus `route.default_http_client` is
      //     the only fully clean 1.14 form, but 1.13 rejects `http_client` as an
      //     unknown field, which is fatal for the whole config.
      // So this stays on the one spelling both cores accept. The cost is a WARN
      // line; revisit when the supported floor moves past 1.13 or 1.16 nears.
      rule_set: [...usedRuleSetTags].map((tag) => ({
        type: 'remote',
        tag: tag,
        format: 'binary',
        url: RULE_SET_URLS[tag] || '',
        download_detour: 'direct',
      })).filter((rs) => rs.url),
      auto_detect_interface: true,
      // Resolution used for sing-box's OWN outbound dialing (i.e. resolving a
      // node's server domain). Deliberately `prefer_ipv4` even when the
      // client-facing dns.strategy is `ipv4_only`: that keeps AAAA away from
      // the browser while still allowing an IPv6-only proxy node to resolve,
      // which `ipv4_only` alone would make impossible to connect to.
      default_domain_resolver: { server: 'local-dns', strategy: 'prefer_ipv4' },
      final: finalOutbound,
    },
    experimental: {
      clash_api: { external_controller: '127.0.0.1:9090', external_ui: '' },
      // Persist downloaded rule-sets and selector selections across restarts so
      // remote rule-sets only download once (not every start), avoiding a
      // first-run delay/flicker in Split mode.
      //
      // `path` is set explicitly. Left empty, sing-box writes `cache.db`
      // relative to its own WORKING DIRECTORY, which for a packaged app is
      // wherever the core happened to be spawned from — so the file ends up
      // outside the app's data directory, cannot be found when something needs
      // clearing, and may sit in a location the process cannot even write.
      // Pinning it next to the generated config keeps it discoverable.
      //
      // Worth knowing what this file does to selections: sing-box has no
      // `store_selected` switch to turn off (see the cache-file docs — the only
      // fields are enabled/path/cache_id/store_fakeip/store_rdrc/store_dns), so
      // whenever the cache is on, every selector's last choice is restored on
      // the next start and OVERRIDES the `default` emitted here. That is why the
      // active node must always be re-asserted through the Clash API after the
      // core starts, and why `default` alone can never be trusted.
      cache_file: {
        enabled: true,
        ...(safeSettings.cacheFilePath ? { path: String(safeSettings.cacheFilePath) } : {}),
      },
    },
  };

  // Optional dedicated SOCKS / HTTP listeners.
  //
  // The mixed inbound above already accepts BOTH SOCKS5 and HTTP on one port,
  // so these exist purely for apps that insist on a particular port number.
  // They are opt-in because every extra listener is another chance to collide
  // with a port something else already holds — and a collision makes sing-box
  // refuse to start, which would look like "the app is broken".
  //
  // Ports that are invalid or duplicate an existing inbound are skipped rather
  // than emitted, for the same reason: sing-box treats a duplicate listener as
  // a fatal error.
  if (safeSettings.separatePorts) {
    const usedPorts = new Set([mixedPort]);
    const extras = [
      { type: 'socks', tag: 'socks-in', port: toPort(safeSettings.socksPort) },
      { type: 'http', tag: 'http-in', port: toPort(safeSettings.httpPort) },
    ];
    for (const extra of extras) {
      if (!extra.port || usedPorts.has(extra.port)) continue;
      usedPorts.add(extra.port);
      config.inbounds.push({
        type: extra.type,
        tag: extra.tag,
        listen: listenAddress,
        listen_port: extra.port,
      });
    }
  }

  // TUN inbound is required for both full-tunnel TUN mode and Split mode
  // (per-app routing needs the system-level capture that TUN provides).
  if (safeSettings.proxyMode === 'tun' || isSplit) {
    config.inbounds.push({
      type: 'tun',
      tag: 'tun-in',
      // Whether the TUN interface carries an IPv6 address decides whether an
      // IPv6 default route exists — i.e. whether IPv6 traffic ENTERS the
      // tunnel at all. This is independent of dns.strategy, which only affects
      // domain resolution and cannot stop the browser dialing a hardcoded IPv6
      // literal (Chrome's Secure DNS providers do exactly that, e.g.
      // Cloudflare 1.1.1.1 / 2606:4700:4700::1111).
      //
      // 'ipv4-only' leaves IPv6 uncaptured: it then escapes via the physical
      // interface, which both LEAKS the real address on IPv6-capable networks
      // and was the source of the original multi-minute stall.
      //
      // 'block' and 'prefer-ipv4' are dual-stack so IPv6 is captured and
      // handled by the route rules above (rejected fast, or proxied).
      // 198.18.0.1/30, NOT the 172.19.0.1/30 from sing-box's own examples.
      //
      // 172.16/12 is crowded on a typical Windows dev machine: Docker Desktop
      // and WSL NAT bridges sit in 172.17–172.20, and NekoRay's TUN adapter
      // uses 172.19.0.1 — the exact address we used to take. Two adapters
      // claiming one address gives Windows conflicting routes, which shows up as
      // "works, then randomly stops". 198.18.0.0/15 is the RFC 2544 benchmark
      // range, reserved for testing and used by mihomo/clash for the same
      // reason, so real networks and container bridges never occupy it.
      address:
        ipv6Strategy === 'ipv4-only'
          ? [TUN_IPV4]
          : [TUN_IPV4, TUN_IPV6],
      auto_route: true,
      // Always on, and no longer user-controllable.
      //
      // strict_route forces everything through the tunnel with extra firewall
      // rules. On Windows one of those rules is load-bearing for DNS, not just
      // for leak-proofing: since 1.14 the TUN's `dns_mode` defaults to `hijack`,
      // and the Windows half of `hijack` is a WFP filter blocking port 53 on
      // every interface except the TUN — which the docs gate explicitly on
      // strict_route. Drop it and Windows' Smart Multi-Homed Name Resolution
      // races the tunnel's resolver against the local network's, keeping the
      // first answer back. The local one wins on latency every time (single-digit
      // ms vs the 200ms+ visible in our own logs), so the network you are on
      // decides what every hostname resolves to. Measured symptom: the tunnel
      // carries traffic fine and no site loads.
      //
      // It was previously exposed as `tunStrictRoute` so users could unbreak
      // WSL2 mirrored mode / Docker / Hyper-V. Those need their private subnets
      // kept off the tunnel, not the firewall rules removed from the whole
      // machine, so that job moved to `route_exclude_address` below.
      strict_route: true,
      // Targeted escape hatch for virtual network stacks that share the host's.
      // Omitted entirely when off, so the default config is byte-for-byte what
      // it was before this option existed.
      ...(safeSettings.tunBypassLocalNetworks
        ? { route_exclude_address: [...LOCAL_NETWORK_RANGES] }
        : {}),
      // Named explicitly rather than left to sing-box's default, so the adapter
      // is identifiable in `ipconfig` / routing tables and in any firewall rule
      // a user needs to write. NekoRay does the same.
      interface_name: 'awesome-tun0',
      // sing-box's own default is also 9000. Stated explicitly because the
      // value matters for throughput and should be visible here rather than
      // inherited silently.
      mtu: 9000,
      ...(stackSupportsEndpointIndependentNat
        ? {
            // Required for UDP protocols that expect a single source port to
            // reach multiple peers — WebRTC, game netcode, some QUIC paths.
            // Only meaningful on gvisor; the docs note other stacks are
            // endpoint-independent already, so it is omitted for `system` to
            // avoid setting a field that stack does not implement.
            endpoint_independent_nat: true,
          }
        : {}),
      stack: tunStack,
    });
  }

  return config;
}

module.exports = {
  generateSingboxConfig,
  nodeRejectionReason,
  nodeInactiveReason,
  openvpnStaticKeyBytes,
  coreAtLeast,
  CORE_1_14,
  toPort,
  TUN_IPV4,
  TUN_IPV6,
  TUN_IPV4_PREFIX,
  LOCAL_NETWORK_RANGES,
  nodeToOutbound,
  nodeToOutbounds,
  nodeToEndpoint,
  isEndpointProtocol,
  buildTransport,
  buildOutboundTags,
};

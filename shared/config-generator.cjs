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
function nodeRejectionReason(node) {
  if (!node || typeof node !== 'object') return 'not an object';
  if (!node.type) return 'missing protocol';
  if (!node.server) return 'missing server address';
  if (!toPort(node.port)) return 'invalid port';

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
  return type === 'wireguard';
}

/**
 * Convert a WireGuard ProxyNode into a sing-box `endpoints` entry.
 */
function nodeToEndpoint(node, tag) {
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
function nodeToOutbounds(node, tag) {
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

  return [nodeToOutbound(node, tag)];
}

/**
 * Convert a single ProxyNode into a sing-box outbound object.
 */
function nodeToOutbound(node, tag) {
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
      if (node.obfsType && node.obfsPassword) {
        outbound.obfs = { type: node.obfsType, password: node.obfsPassword };
      }
      // Bandwidth hints. Omit entirely to let sing-box fall back to BBR.
      if (node.upMbps) outbound.up_mbps = node.upMbps;
      if (node.downMbps) outbound.down_mbps = node.downMbps;
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
  const nodeOutbounds = [];
  const nodeEndpoints = [];
  const usableTags = [];
  const skipped = [];
  safeNodes.forEach((node, index) => {
    const reason = nodeRejectionReason(node);
    if (reason) {
      skipped.push({ tag: tags[index], reason });
      return;
    }
    if (isEndpointProtocol(node.type)) {
      nodeEndpoints.push(nodeToEndpoint(node, tags[index]));
    } else {
      nodeOutbounds.push(...nodeToOutbounds(node, tags[index]));
    }
    usableTags.push(tags[index]);
  });

  const hasNodes = usableTags.length > 0;
  // Fall back to the first usable node when the selected one was skipped —
  // pointing a selector at a non-existent outbound is itself a fatal error.
  const selectedTag =
    selectedIndex >= 0 && selectedIndex < tags.length ? tags[selectedIndex] : null;
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
  // Defaults to 'prefer-ipv4': the TUN is dual-stack so IPv6 is captured by the
  // tunnel (it can never escape via the physical interface, so the real address
  // stays hidden) and is then actually proxied. IPv4 is still preferred for
  // dual-stack destinations.
  //
  // 'block' used to be the default. It is equally leak-safe but leaves the
  // machine with a black-holed IPv6 default route, which measurably degrades
  // behaviour on IPv6-capable networks (Windows connectivity probes retry, and
  // anything that insists on IPv6 fails instead of working). It stays available
  // for users who want IPv6 hard-off.
  const ipv6Strategy =
    safeSettings.ipv6Strategy === 'block' || safeSettings.ipv6Strategy === 'ipv4-only'
      ? safeSettings.ipv6Strategy
      : 'prefer-ipv4';

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
        { tag: 'local-dns', type: 'local' },
        remoteDns,
        // AliDNS for the China-direct split, also by IP literal (its cert
        // carries 223.5.5.5 as an IP SAN) so it needs no bootstrap either.
        { tag: 'direct-dns', type: 'https', server: '223.5.5.5', path: '/dns-query' },
      ],
      // CLIENT-facing resolution strategy. This is what the browser/OS sees.
      //
      // Critical subtlety learned the hard way: `prefer_ipv4` does NOT stop
      // AAAA records reaching the client. In TUN mode the client issues its
      // own A and AAAA queries and sing-box answers both. Combined with a
      // dual-stack TUN — which makes Windows believe it has real IPv6
      // connectivity — the OS then *prefers* IPv6 per RFC 6724. So
      // `prefer_ipv4` + reject-IPv6 meant "try IPv6 first, then get rejected",
      // i.e. broken browsing, the exact opposite of the intent.
      //
      // For 'block' we therefore use `ipv4_only`, which withholds AAAA from
      // the client entirely: it simply never attempts IPv6, so there is
      // nothing to stall on. The reject rule below then exists purely as a
      // backstop for hardcoded IPv6 literals (which bypass DNS), keeping them
      // captured-and-rejected instead of leaking.
      //
      // 'prefer-ipv4' intentionally keeps AAAA so IPv6 destinations remain
      // reachable *through the proxy*.
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
        // Private ranges stay direct. Deliberately BEFORE the IPv6 reject so
        // link-local / ULA IPv6 (fe80::, fc00::) keeps working on the LAN.
        { ip_is_private: true, outbound: 'direct' },
        // Backstop for 'block' mode, TUN/Split only.
        //
        // Normal traffic never gets here because dns.strategy is `ipv4_only`,
        // so the client is never handed an AAAA record and never tries IPv6.
        // This rule catches what DNS cannot: hardcoded IPv6 literals (e.g.
        // Chrome's Secure DNS providers dial 2606:4700:4700::1111 directly).
        // Those are captured by the dual-stack TUN and rejected here rather
        // than escaping via the physical interface, which is what would leak
        // the real address.
        //
        // In System/Manual mode there is no TUN, so the browser's IPv6 (and
        // its leaky WebRTC UDP) never enters sing-box at all. Rejecting here
        // would buy no privacy while breaking IPv6-only sites that the proxy
        // could otherwise reach, so we leave IPv6 alone in those modes.
        ...(ipv6Strategy === 'block' && (safeSettings.proxyMode === 'tun' || isSplit)
          ? [{ ip_version: 6, action: 'reject' }]
          : []),
        ...splitRouteRules,
        ...legacySplitRules,
        ...(safeSettings.bypassChina
          ? [{ domain_suffix: ['.cn', '.baidu.com', '.qq.com', '.taobao.com', '.jd.com', '.alipay.com'], outbound: 'direct' }]
          : []),
      ],
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
      cache_file: { enabled: true },
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
      address:
        ipv6Strategy === 'ipv4-only'
          ? ['172.19.0.1/30']
          : ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
      auto_route: true,
      strict_route: true,
      // gvisor is a userspace netstack and is more resilient than the
      // Windows "system" stack under sustained load/high connection churn,
      // which matches the "works for a while, then TUN stops passing
      // traffic" symptom. The bundled binary is built with the gvisor tag.
      stack: 'gvisor',
    });
  }

  return config;
}

module.exports = {
  generateSingboxConfig,
  nodeRejectionReason,
  toPort,
  nodeToOutbound,
  nodeToOutbounds,
  nodeToEndpoint,
  isEndpointProtocol,
  buildTransport,
  buildOutboundTags,
};

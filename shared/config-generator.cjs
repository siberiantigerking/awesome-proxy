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
      method: node.method || '2022-blake3-aes-128-gcm',
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
  const nodeOutbounds = [];
  const nodeEndpoints = [];
  safeNodes.forEach((node, index) => {
    if (isEndpointProtocol(node && node.type)) {
      nodeEndpoints.push(nodeToEndpoint(node, tags[index]));
    } else {
      nodeOutbounds.push(...nodeToOutbounds(node, tags[index]));
    }
  });

  const hasNodes = safeNodes.length > 0;
  const defaultTag =
    selectedIndex >= 0 && selectedIndex < tags.length ? tags[selectedIndex] : (hasNodes ? tags[0] : 'direct');

  const splitApps = Array.isArray(safeSettings.splitApps)
    ? safeSettings.splitApps.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const splitMode = safeSettings.splitMode === 'direct' ? 'direct' : 'proxy';
  const isSplit = safeSettings.proxyMode === 'split';

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
      const selectorChildren = ['proxy', 'auto', 'direct', ...tags];
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
      outbounds: ['auto', 'direct', ...tags],
      default: defaultTag,
    });
    outbounds.push({
      type: 'urltest',
      tag: 'auto',
      outbounds: [...tags],
      url: 'https://www.gstatic.com/generate_204',
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
  const remoteDns = {
    tag: 'remote-dns',
    type: 'https',
    server: 'dns.google',
    path: '/dns-query',
    domain_resolver: 'local-dns',
  };
  if (hasNodes) remoteDns.detour = 'proxy';

  const config = {
    log: { level: safeSettings.logLevel || 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'local-dns', type: 'local' },
        remoteDns,
        { tag: 'direct-dns', type: 'https', server: 'dns.alidns.com', path: '/dns-query', domain_resolver: 'local-dns' },
      ],
      // Force IPv4-only resolution. Under sustained load some networks/ISPs
      // (and the proxy server itself) become unreliable for the AAAA/IPv6
      // path while TCP/IPv4 keeps working, which presents as "TUN works for
      // a while, then every page stops loading" once the OS/browser keeps
      // retrying IPv6 first (happy-eyeballs) and each attempt has to time
      // out before falling back. Pinning DNS to ipv4_only removes that stall.
      strategy: 'ipv4_only',
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
        listen: safeSettings.allowLan ? '0.0.0.0' : '127.0.0.1',
        listen_port: safeSettings.mixedPort || 7890,
      },
    ],
    outbounds,
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
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
      default_domain_resolver: { server: 'local-dns' },
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

  // TUN inbound is required for both full-tunnel TUN mode and Split mode
  // (per-app routing needs the system-level capture that TUN provides).
  if (safeSettings.proxyMode === 'tun' || isSplit) {
    config.inbounds.push({
      type: 'tun',
      tag: 'tun-in',
      // IPv4-only on purpose. dns.strategy: ipv4_only (below) only affects
      // domains that go through sing-box's own DNS resolution — it does
      // NOT stop the browser from dialing hardcoded IPv6 literals directly
      // (e.g. Chrome's built-in Secure DNS providers use both an IPv4 and
      // an IPv6 literal for the same server, such as Cloudflare's
      // 1.1.1.1 / 2606:4700:4700::1111). Those literal connections were
      // observed hanging for 2+ minutes before timing out through this
      // proxy, which is what caused "TUN works, then browsing hangs/looks
      // disconnected". Without an IPv6 address on the TUN interface, no
      // IPv6 default route is installed, so IPv6 traffic never enters the
      // tunnel at all — it fails fast locally (or uses the real network
      // path) instead of hanging on the proxy, and browsers' Happy Eyeballs
      // falls back to IPv4 quickly.
      address: ['172.19.0.1/30'],
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
  nodeToOutbound,
  nodeToOutbounds,
  nodeToEndpoint,
  isEndpointProtocol,
  buildTransport,
  buildOutboundTags,
};

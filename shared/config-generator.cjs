/**
 * Shared sing-box config generator.
 *
 * This module is the SINGLE SOURCE OF TRUTH for translating ProxyNode objects
 * into a sing-box configuration. It is consumed by both:
 *   - server/index.js   (web mode backend)
 *   - electron/main.ts  (Electron main process, via require)
 *
 * Target core: sing-box 1.14.x (bundled: 1.14.4); 1.13.x gets the gated
 * fallback surface (see Core Version Gating).
 *
 * Schema notes (first verified against sing-box 1.13.12; every generated shape
 * is re-checked against the bundled core by npm run test:core):
 *   - The `dns` and `block` outbound TYPES were removed in 1.13.0.
 *     DNS hijacking is now done with a route rule action ("hijack-dns") and
 *     blocking with the "reject" rule action.
 *   - `transport` must NOT be emitted for plain TCP. Only ws/grpc/http/quic/
 *     httpupgrade are valid transport types. Emitting `{ type: "tcp" }` is a
 *     fatal error, and so is a type the core lacks (xhttp, kcp, ...), so such a
 *     node is skipped with a reason (see Transports).
 *   - The legacy `geoip`/`geosite` route rules were removed in 1.12.0. We use
 *     `ip_is_private` + domain_suffix offline rules so startup never depends on
 *     downloading remote rule-sets (the deployment network blocks GitHub).
 *   - `route.default_domain_resolver` is required as of 1.12.0 to resolve
 *     server domains for dial fields.
 */

'use strict';

// The clash_api block (controller address + secret) is built in one place.
const { buildClashApiBlock } = require('./clash-client.cjs');

// ==================== Transports ====================
//
// The V2Ray transport a VMess, VLESS or Trojan node asks for. sing-box has ws,
// grpc, http (HTTP/2), quic and httpupgrade; plain TCP is "no transport block".
// It has no TCP transport, no mKCP and no XHTTP, and a `transport.type` it
// lacks is FATAL ("unknown transport type: xhttp"), which would stop every
// node. Emitting such a node as plain TCP instead, as this generator used to,
// gives a node that can never connect. So nodeRejectionReason skips it with a
// reason that names the transport.
//
// src/services/node-parser.ts mirrors SUPPORTED_TRANSPORTS and
// normalizeTransportType line for line, because links and Clash YAML are stored
// through the renderer's copy and the node form marks a transport this
// generator skips. tests/unit/transports.test.ts enforces the parity.
const SUPPORTED_TRANSPORTS = new Set(['tcp', 'ws', 'grpc', 'http', 'quic', 'httpupgrade']);

/**
 * One spelling per transport, whatever a link, a YAML or a stored node says:
 * trimmed and lower-cased; empty, `raw` (Xray's newer name for TCP) and `none`
 * are `tcp`, so nodes stored with them keep working as the plain TCP they
 * always were; `h2` is the http (HTTP/2) transport. Any other name is kept, so
 * nodeRejectionReason can name it.
 */
function normalizeTransportType(value) {
  const type = String(value == null ? '' : value).trim().toLowerCase();
  if (type === '' || type === 'tcp' || type === 'raw' || type === 'none') return 'tcp';
  if (type === 'h2') return 'http';
  return type;
}

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

// ==================== Outbound Tags ====================
//
// sing-box refuses the WHOLE config when two outbounds or endpoints share a tag
// ("duplicate outbound/endpoint tag"). Node tags come from names the user or a
// subscription chose, so one awkward name used to stop the core for every node
// (audit P0-4): a node called `direct`, nodes `HK`, `HK`, `HK-1`, a Split rule
// named like a node, or a node called `<another node>-shadowtls`. Two rules
// keep the generator's own tags out of the nodes' way:
//   - Its fixed outbounds are reserved. A node named `proxy`, `auto` or
//     `direct` is numbered like a duplicate (`direct-1`).
//   - Its per-config internal outbounds live under prefixes that no node tag
//     can start with: Split-rule selectors are `split:<rule id>` and ShadowTLS
//     helpers `shadowtls:<node tag>`. A node whose name starts with one of the
//     prefixes is tagged `node-<name>` instead.
//
// src/services/outbound-tags.ts mirrors these constants, buildOutboundTags and
// splitSelectorTag line for line, because the renderer names the same tags in
// its Clash API calls. tests/unit/tags.test.ts enforces the parity.
const RESERVED_OUTBOUND_TAGS = ['proxy', 'auto', 'direct'];
const SPLIT_SELECTOR_TAG_PREFIX = 'split:';
const SHADOWTLS_HELPER_TAG_PREFIX = 'shadowtls:';
const INTERNAL_TAG_PREFIXES = [SPLIT_SELECTOR_TAG_PREFIX, SHADOWTLS_HELPER_TAG_PREFIX];

/**
 * Tag of the selector a Split rule routes through. Built from the rule's id,
 * not its display name: the id is stable and unique (Settings never adds a
 * preset twice), while a name can equal a node's.
 */
function splitSelectorTag(rule) {
  return SPLIT_SELECTOR_TAG_PREFIX + String(rule.id);
}

/**
 * Tag of the shadowtls helper that a ShadowTLS node's shadowsocks outbound
 * detours through. Unique because node tags are, and prefixed so that no node
 * name can equal it.
 */
function shadowtlsHelperTag(tag) {
  return SHADOWTLS_HELPER_TAG_PREFIX + tag;
}

/**
 * Build a deterministic, unique outbound tag for each node, in list order.
 *
 * The base is the node's tag or name, trimmed, or `node-<index>` when that is
 * empty. A base that starts with an internal prefix gets `node-` in front (see
 * Outbound Tags above). A base that is reserved or already taken gets the first
 * free `-N` suffix, so `HK`, `HK`, `HK-1` become `HK`, `HK-1`, `HK-1-1`.
 *
 * Every tag handed out is registered, suffixed ones included; registering only
 * the bases is what let a suffix repeat another node's real name. A list whose
 * tags were already unique, unreserved and unprefixed keeps exactly the tags
 * it had, so no working setup loses a cached selector choice.
 */
function buildOutboundTags(nodes) {
  const tags = [];
  // Every tag handed out so far, plus the generator's own.
  const taken = new Set(RESERVED_OUTBOUND_TAGS);
  // Next suffix to try per base, so HK, HK, HK still gives HK, HK-1, HK-2.
  const nextSuffix = new Map();
  nodes.forEach((node, index) => {
    let base = (node && (node.tag || node.name)) || `node-${index}`;
    base = String(base).trim() || `node-${index}`;
    // Keep nodes out of the internal namespace.
    if (INTERNAL_TAG_PREFIXES.some((p) => base.startsWith(p))) base = `node-${base}`;
    let tag = base;
    if (taken.has(tag)) {
      let n = nextSuffix.get(base) || 1;
      while (taken.has(`${base}-${n}`)) n += 1;
      tag = `${base}-${n}`;
      nextSuffix.set(base, n + 1);
    }
    taken.add(tag);
    tags.push(tag);
  });
  return tags;
}

// ==================== DNS Servers ====================
//
// Settings → DNS names two servers: Remote DNS, which answers through the proxy
// (`dns.final`), and Direct DNS, which answers the mainland-China domains of
// `dns.rules`. Both settings used to be ignored here, so whatever the user typed
// had no effect while the Dashboard showed it as in use (audit P0-8).
//
// src/services/dns-servers.ts mirrors the defaults and parseDnsServer (with
// isIPv4, isIPv6 and isHostName) line for line, because Settings validates the
// fields as the user types and the Dashboard shows the server actually used.
// tests/unit/dns-parity.test.ts enforces the parity.

// What this generator emitted before it read the settings: Cloudflare and
// AliDNS DoH by IP literal (the DNS block in generateSingboxConfig says why
// literals). They are the defaults too, and the renderer's settings v6
// migration moves the old, never-used dns.google / dns.alidns.com defaults to
// them, so nobody's DNS changes unless they edit it.
const DEFAULT_REMOTE_DNS = 'https://1.1.1.1/dns-query';
const DEFAULT_DIRECT_DNS = 'https://223.5.5.5/dns-query';

// Accepted schemes. Each is also the sing-box DNS server `type` it maps to.
const DNS_SERVER_TYPES = ['https', 'h3', 'tls', 'quic', 'udp'];

const DNS_HOST_ERROR = 'The server must be an IP address or a host name.';
const DNS_PORT_ERROR = 'The port must be a number from 1 to 65535.';
const DNS_ESCAPE_ERROR = 'A % in the path must be followed by two hex digits, e.g. %2F.';

/** Dotted-quad IPv4: four decimal octets of 0-255, without leading zeros. */
function isIPv4(text) {
  return (
    typeof text === 'string' &&
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(text)
  );
}

/**
 * IPv6 in text form, without brackets and without a zone id: hex groups of
 * 1-4 digits, exactly 8 of them, or fewer with one `::` standing for the rest.
 * A dotted IPv4 part may end the address and counts as two groups.
 */
function isIPv6(text) {
  if (typeof text !== 'string' || !/^[0-9A-Fa-f:.]+$/.test(text) || !text.includes(':')) return false;
  const halves = text.split('::');
  if (halves.length > 2) return false;
  let groups = 0;
  for (let h = 0; h < halves.length; h++) {
    if (halves[h] === '') continue;
    const parts = halves[h].split(':');
    for (let i = 0; i < parts.length; i++) {
      // Only the address's very last part may be dotted IPv4.
      const last = h === halves.length - 1 && i === parts.length - 1;
      if (last && parts[i].includes('.')) {
        if (!isIPv4(parts[i])) return false;
        groups += 2;
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(parts[i])) {
        groups += 1;
      } else {
        return false;
      }
    }
  }
  return halves.length === 2 ? groups < 8 : groups === 8;
}

/**
 * A DNS host name: dot-separated labels of 1-63 letters, digits and hyphens,
 * none starting or ending with a hyphen, no trailing dot, 253 characters at most.
 */
function isHostName(text) {
  return (
    text.length <= 253 &&
    text.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

/**
 * Parse a Remote/Direct DNS setting into a sing-box DNS server.
 *
 * Accepted forms (the scheme is case-insensitive):
 *   https://host[:port][/path]  DNS over HTTPS; no path, or "/", means /dns-query
 *   h3://host[:port][/path]     DNS over HTTP/3, with the same path rule
 *   tls://host[:port]           DNS over TLS
 *   quic://host[:port]          DNS over QUIC
 *   udp://host[:port]           plain DNS
 *   1.1.1.1, [2606:4700::1111]  a bare IPv4 or IPv6 address (brackets optional): plain DNS
 * where host is an IPv4 address, an IPv6 address in brackets, or a host name.
 *
 * Returns `{ ok: true, server: { type, server, server_port?, path? }, hostname }`,
 * where `hostname` says the server is a name the core must look up first, or
 * `{ ok: false, error }` with one of these texts, which Settings shows as is:
 *   Enter a DNS server.
 *   Use https://, h3://, tls://, quic:// or udp://, or a bare IP address.
 *   <scheme>:// is not supported. Use https://, h3://, tls://, quic:// or udp://.
 *   Only a host and an optional port may come before the path.
 *   A ? or # part is not supported.
 *   A % in the path must be followed by two hex digits, e.g. %2F.
 *   Put an IPv6 address in brackets, e.g. https://[2606:4700:4700::1111]/dns-query.
 *   The server must be an IP address or a host name.
 *   The port must be a number from 1 to 65535.
 *   <scheme>:// takes no path.
 *
 * Hand-written instead of `new URL()`: Node and Chromium (the renderer's copy
 * runs in Electron's) parse non-special schemes such as tls:// differently,
 * and the two copies must agree on every input.
 */
function parseDnsServer(input) {
  const fail = (error) => ({ ok: false, error });
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return fail('Enter a DNS server.');

  // A bare address is plain DNS.
  if (isIPv4(text) || isIPv6(text)) {
    return { ok: true, server: { type: 'udp', server: text }, hostname: false };
  }
  if (text.startsWith('[') && text.endsWith(']') && isIPv6(text.slice(1, -1))) {
    return { ok: true, server: { type: 'udp', server: text.slice(1, -1) }, hostname: false };
  }

  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (!match) return fail('Use https://, h3://, tls://, quic:// or udp://, or a bare IP address.');
  const scheme = match[1].toLowerCase();
  if (!DNS_SERVER_TYPES.includes(scheme)) {
    return fail(`${scheme}:// is not supported. Use https://, h3://, tls://, quic:// or udp://.`);
  }

  const rest = match[2];
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);
  if (/[@?#\s]/.test(authority)) return fail('Only a host and an optional port may come before the path.');
  if (/[?#]/.test(path)) return fail('A ? or # part is not supported.');
  // The core unescapes a DoH/DoH3 path when it builds the server, and a % not
  // followed by two hex digits fails that ("invalid URL escape"), which stops
  // the whole config and with it every node. Any other path it takes, a byte
  // that isn't UTF-8 (%C3) included, so this is the only escape check.
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return fail(DNS_ESCAPE_ERROR);

  let host;
  let portText = null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    host = close < 0 ? '' : authority.slice(1, close);
    const after = close < 0 ? '' : authority.slice(close + 1);
    if (close < 0 || !isIPv6(host) || (after !== '' && !after.startsWith(':'))) return fail(DNS_HOST_ERROR);
    if (after !== '') portText = after.slice(1);
  } else {
    const colon = authority.indexOf(':');
    if (colon !== authority.lastIndexOf(':')) {
      return fail('Put an IPv6 address in brackets, e.g. https://[2606:4700:4700::1111]/dns-query.');
    }
    host = colon < 0 ? authority : authority.slice(0, colon);
    if (colon >= 0) portText = authority.slice(colon + 1);
    // Only digits and dots is a mistyped IPv4 address (1.1.1, 256.1.1.1), not a name.
    if (!isIPv4(host) && (/^[0-9.]*$/.test(host) || !isHostName(host))) return fail(DNS_HOST_ERROR);
  }

  let port;
  if (portText !== null) {
    port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
    if (port < 1 || port > 65535) return fail(DNS_PORT_ERROR);
  }

  const takesPath = scheme === 'https' || scheme === 'h3';
  if (!takesPath && path !== '' && path !== '/') return fail(`${scheme}:// takes no path.`);

  const server = { type: scheme, server: host };
  if (port !== undefined) server.server_port = port;
  if (takesPath) server.path = path === '' || path === '/' ? '/dns-query' : path;
  return { ok: true, server, hostname: !isIPv4(host) && !isIPv6(host) };
}

/**
 * One `dns.servers` entry from a setting: `{ tag, type, server, server_port?,
 * path?, domain_resolver? }`. A server given by name gets
 * `domain_resolver: 'local-dns'`, the OS resolver, to look up its own address;
 * the DNS block in generateSingboxConfig points Remote DNS at its bootstrap
 * through the proxy instead when there are nodes. A value that does not parse
 * is replaced by `fallback`, a default that always parses: sing-box refuses a
 * malformed DNS server, and that would stop every node.
 */
function dnsServerEntry(tag, value, fallback) {
  let parsed = parseDnsServer(value);
  if (!parsed.ok) parsed = parseDnsServer(fallback);
  const entry = { tag, ...parsed.server };
  if (parsed.hostname) entry.domain_resolver = 'local-dns';
  return entry;
}

/**
 * Build the transport object for a node, or undefined for plain TCP.
 * Emitting a transport block for "tcp" is invalid in sing-box and is the
 * main reason vmess/vless nodes previously failed to start. The stored type is
 * normalised first, so `h2` and `raw` from older imports still work. A type the
 * core lacks gets no block either, but nodeRejectionReason has already left
 * such a node out of the config (see Transports).
 */
function buildTransport(node) {
  const type = normalizeTransportType(node.transportType);
  if (type === 'tcp' || !SUPPORTED_TRANSPORTS.has(type)) {
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
    case 'httpupgrade': {
      // `host` is one string here, unlike the http transport's list.
      const transport = { type: 'httpupgrade' };
      if (node.transportPath) transport.path = node.transportPath;
      if (node.transportHost) transport.host = node.transportHost;
      return transport;
    }
    default:
      return undefined;
  }
}

// The uTLS fingerprints sing-box knows (its TLS docs; the five chrome_* names
// are legacy ones it still accepts and maps to chrome). Any other value is
// FATAL at startup ("unknown uTLS fingerprint: none"), and links carry such
// values (`fp=none`), so buildOptionalTls treats one as absent rather than let
// a single node stop every node. All 15 were checked against the bundled 1.14.4.
const UTLS_FINGERPRINTS = new Set([
  'chrome',
  'firefox',
  'edge',
  'safari',
  '360',
  'qq',
  'ios',
  'android',
  'random',
  'randomized',
  'chrome_psk',
  'chrome_psk_shuffle',
  'chrome_padding_psk_shuffle',
  'chrome_pq',
  'chrome_pq_psk',
]);

/**
 * Build a TLS block for protocols where TLS is optional (vmess/vless).
 * Returns undefined when TLS is disabled. Supports Reality and uTLS
 * fingerprint for VLESS+Reality nodes. Only a fingerprint in
 * UTLS_FINGERPRINTS is emitted; any other counts as none.
 */
function buildOptionalTls(node) {
  if (!node.tls) return undefined;
  const tls = { enabled: true, server_name: node.sni || node.server };
  if (node.allowInsecure) tls.insecure = true;
  if (node.realityPublicKey) {
    tls.reality = { enabled: true, public_key: node.realityPublicKey };
    if (node.realityShortId) tls.reality.short_id = node.realityShortId;
  }
  if (UTLS_FINGERPRINTS.has(node.fingerprint)) {
    tls.utls = { enabled: true, fingerprint: node.fingerprint };
  } else if (tls.reality) {
    // uTLS is MANDATORY for a Reality client in sing-box: without it the core
    // refuses to start at all with
    //   "create service: initialize outbound[N]: uTLS is required by reality
    //    client"
    // which surfaces to the user as the whole app failing to connect, not as a
    // problem with one node. Reality links normally carry `fp`, but not all
    // generators include it (and some write one the core doesn't know), so
    // default to chrome rather than emit a config the core rejects.
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

// Shadowsocks SIP003 plugins. sing-box runs only these two itself ("Only
// obfs-local and v2ray-plugin are supported"). Any other plugin name is FATAL
// at startup ("plugin not found"), and so are options it refuses (an unknown
// obfs mode, a certificate file it cannot read, a mux that is not a number), so
// one such node would stop every node. shadowsocksPluginReason keeps it out of
// the config instead; its rules were measured against the bundled 1.14.4 with
// `sing-box check`.
const SS_PLUGINS = new Set(['obfs-local', 'v2ray-plugin']);

/**
 * Split SIP003 plugin options (SS_PLUGIN_OPTIONS) the way sing-box does:
 * `key=value` pairs separated by `;`; `\` makes the next character literal
 * (`\;`, `\=`, `\\`), in keys as in values; a key without `=` gets the value
 * `1`; an empty text has no options, and one trailing `;` is allowed.
 * Returns `{ ok: true, options }` with `[key, value]` pairs in order (a key may
 * repeat), or `{ ok: false, error }` for the two texts the core refuses to
 * parse, which are FATAL at startup: an option without a name, and a `\` at
 * the very end.
 */
function parseSip003Options(text) {
  const s = typeof text === 'string' ? text : '';
  const options = [];
  // The unescaped text from `from` up to the first unescaped character in
  // `stops`, and where that is; null when the text ends right after a `\`.
  const read = (from, stops) => {
    let value = '';
    let i = from;
    for (; i < s.length; i++) {
      let c = s[i];
      if (stops.includes(c)) break;
      if (c === '\\') {
        i += 1;
        if (i >= s.length) return null;
        c = s[i];
      }
      value += c;
    }
    return { value, end: i };
  };
  const danglingEscape = { ok: false, error: 'Shadowsocks plugin options end with a backslash that escapes nothing' };
  let i = 0;
  while (i < s.length) {
    const key = read(i, '=;');
    if (!key) return danglingEscape;
    if (!key.value) return { ok: false, error: 'Shadowsocks plugin options have an option without a name' };
    if (key.end >= s.length || s[key.end] !== '=') {
      options.push([key.value, '1']);
      i = key.end + 1; // past the `;`
      continue;
    }
    const value = read(key.end + 1, ';');
    if (!value) return danglingEscape;
    options.push([key.value, value.value]);
    i = value.end + 1; // past the `;`
  }
  return { ok: true, options };
}

/**
 * Why sing-box would refuse this Shadowsocks node's plugin at startup, or null
 * when the node has no plugin or the core accepts it (see SS_PLUGINS).
 */
function shadowsocksPluginReason(node) {
  if (!node.plugin) return null;
  if (!SS_PLUGINS.has(node.plugin)) {
    return `Shadowsocks plugin "${node.plugin}" is not supported by sing-box (only obfs-local and v2ray-plugin)`;
  }
  const parsed = parseSip003Options(node.pluginOpts);
  if (!parsed.ok) return parsed.error;
  // The core reads only a key's first value. Checking every value also refuses
  // option text that contradicts itself, which no client reads the same way.
  const values = (key) => parsed.options.filter(([k]) => k === key).map(([, v]) => v);
  if (node.plugin === 'obfs-local') {
    // Case-sensitive, as in the core (`obfs=HTTP` is FATAL); without `obfs` it uses http.
    if (values('obfs').some((v) => v !== 'http' && v !== 'tls')) return 'obfs-local needs obfs=http or obfs=tls';
    return null;
  }
  // v2ray-plugin. QUIC mode needs TLS, which any `tls` option turns on.
  const modes = values('mode');
  if (modes.some((m) => m !== 'websocket' && m !== 'quic') || (modes.includes('quic') && !values('tls').length)) {
    return 'v2ray-plugin mode must be websocket, or quic with tls';
  }
  // The core reads that certificate file or text at startup, and a missing or
  // bad one is FATAL. A shared link must not make the app read a local file.
  if (values('cert').length || values('certRaw').length) {
    return 'v2ray-plugin cert and certRaw options are not supported';
  }
  // 18 digits always fit the core's 64-bit int; a longer number is FATAL too
  // ("value out of range").
  if (values('mux').some((v) => !/^-?\d{1,18}$/.test(v))) return 'v2ray-plugin mux must be a number';
  return null;
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
  if (node.type === 'shadowsocks') {
    const reason = shadowsocksPluginReason(node);
    if (reason) return reason;
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
  if (node.type === 'vmess' || node.type === 'vless' || node.type === 'trojan') {
    // A transport the core lacks is fatal, and as plain TCP the node could
    // never connect (see Transports).
    const transport = normalizeTransportType(node.transportType);
    if (!SUPPORTED_TRANSPORTS.has(transport)) {
      // The name comes from a link or a YAML and this reason is logged as it
      // is, so only a short plain word is quoted.
      return /^[a-z0-9_-]{1,32}$/.test(transport)
        ? `transport "${transport}" is not supported by sing-box`
        : 'transport of an unknown type is not supported by sing-box';
    }
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
 * 1.14.0 core:
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
    const helperTag = shadowtlsHelperTag(tag);
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

    case 'shadowsocks': {
      const outbound = {
        type: 'shadowsocks',
        tag,
        server: node.server,
        server_port: node.port,
        method: node.method || 'aes-256-gcm',
        password: node.password,
      };
      // A SIP003 plugin the core runs itself. nodeRejectionReason has already
      // skipped a node whose plugin or options the core would refuse.
      if (SS_PLUGINS.has(node.plugin)) {
        outbound.plugin = node.plugin;
        if (typeof node.pluginOpts === 'string' && node.pluginOpts) outbound.plugin_opts = node.pluginOpts;
      }
      return outbound;
    }

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
 * Generate a complete, version-gated sing-box configuration (1.13.x and 1.14.x).
 *
 * @param {Array} nodes          List of ProxyNode objects.
 * @param {number} selectedIndex Index of the node selected as default.
 * @param {Object} settings      App settings (ports, mode, dns, routing), plus
 *   fields only the backend (electron/main.ts, server/index.js) fills in:
 *   - `coreVersion`   version of the core that will run this config (see Core
 *                     Version Gating above).
 *   - `cacheFilePath` absolute path for `experimental.cache_file`.
 *   - `clashApi`      `{ port, secret }` for `experimental.clash_api`. Backend
 *                     only and deliberately NOT part of the renderer's
 *                     AppSettings: the backends pass `clashApi: undefined` over
 *                     whatever the renderer sent, so the renderer-facing config
 *                     has no controller at all, and inject the real per-start
 *                     credentials into the file right before spawning the core
 *                     (shared/clash-client.cjs).
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
  // Default is therefore 'mixed' — system TCP for throughput and gVisor for
  // UDP, sing-box's own default — with the other two selectable for anyone
  // whose setup disagrees. Upstream documents `endpoint_independent_nat` as
  // having had no effect since 1.11 (commit 378f151c75) and UDP NAT as
  // endpoint-independent on every stack, so the stack choice is about TCP
  // throughput and CPU, not NAT, and the TUN inbound below leaves the field
  // out.
  const tunStack =
    safeSettings.tunStack === 'system' || safeSettings.tunStack === 'gvisor'
      ? safeSettings.tunStack
      : 'mixed';

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
      // By rule id, in the internal namespace: a rule named like a node used to
      // collide with it. connection.ts and Settings.tsx address it by the same
      // helper's renderer copy.
      const selectorTag = splitSelectorTag(rule);
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
        // Picking another target for a rule moves the rule's open connections
        // too, for the reasons given on the `proxy` selector below.
        interrupt_exist_connections: true,
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
      // Switching nodes moves existing connections; the user decided this. A
      // switch closes the connections open at that moment, so a download or a
      // playing video continues through the new node after a brief
      // interruption, instead of staying on the old node until it ends.
      //
      // Not on the `auto` urltest below: it re-picks the fastest node on its
      // own every few minutes, and each re-pick would drop every open
      // connection. Re-selecting the node that is already active interrupts
      // nothing, so the re-assert after every start is harmless.
      //
      // The field exists since sing-box 1.5.0, so the 1.13 floor accepts it and
      // it needs no version gate. It is reliable since 1.14.1: commit
      // 515a73e4ee routes connections through the selector itself, so they
      // join the interrupt group a switch triggers.
      interrupt_exist_connections: true,
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
  //   - A DNS server addressed by domain needs a `domain_resolver` to bootstrap
  //     its own hostname. Direct DNS uses a `local` server (the OS resolver),
  //     which needs no detour and no bootstrap, breaking the chicken-and-egg
  //     cycle; Remote DNS uses a bootstrap of its own when there are nodes
  //     (below).
  //   - `remote-dns` only routes through `proxy` when proxy nodes exist;
  //     otherwise it resolves directly (no `proxy` outbound is present).
  //
  // Both servers come from Settings (see DNS Servers above): Remote DNS is
  // `remote-dns`, Direct DNS `direct-dns`.
  //
  // The defaults are DoH addressed by IP LITERAL rather than hostname:
  // Cloudflare 1.1.1.1 and AliDNS 223.5.5.5. Two reasons for the literal. First
  // it removes the bootstrap dependency entirely: a hostname (dns.google,
  // cloudflare-dns.com) has to be looked up first, and on a network where the
  // local resolver is poisoned or hijacked a lookup through it is exactly what
  // fails — taking the encrypted resolver down with it. Second, both
  // certificates carry the address as an IP SAN, so TLS still verifies properly.
  //
  // What the user typed is honoured as typed, and a server given by name is
  // looked up the way its queries travel (Round 2 follow-up N2):
  //   - Remote DNS, when there are nodes, through `remote-dns-bootstrap`:
  //     Cloudflare DoH by IP literal, through the proxy. Its queries go through
  //     the proxy anyway, so this adds no new dependency, and Windows' resolver
  //     never sees the name. A poisoned answer there for a name such as
  //     dns.google would break every non-China name in TUN and Split mode.
  //   - Direct DNS, and Remote DNS without nodes (no proxy to go through),
  //     through `local-dns`, the OS resolver. That lookup is the only traffic
  //     these settings can add to local-dns, and typing a name is what asks
  //     for it.
  // No lookup loop. The core looks a DNS server's name up through its
  // domain_resolver BEFORE it hands the connection to the detour, and the
  // bootstrap is an IP literal, so the proxy is only ever given an address.
  // That matters because a WireGuard endpoint looks a destination NAME up
  // through dns.rules, which would lead back to Remote DNS. Measured on the
  // bundled 1.14.4 core with a WireGuard node selected: drop the resolver and
  // `check` still passes, but the core hands dns.google to the node as a name
  // and every Remote DNS lookup fails with "DNS query loopback in
  // transport[remote-dns]". A node's own server name goes through
  // `route.default_domain_resolver`, local-dns.
  //
  // A value that does not parse falls back to the default instead of being
  // emitted, so a typo can never stop the core. Settings flags it inline.
  const remoteDns = dnsServerEntry('remote-dns', safeSettings.remoteDns, DEFAULT_REMOTE_DNS);
  const remoteDnsBootstrap =
    hasNodes && remoteDns.domain_resolver
      ? { tag: 'remote-dns-bootstrap', type: 'https', server: '1.1.1.1', detour: 'proxy' }
      : null;
  // Assigned in place, so the key keeps its position in the emitted entry.
  if (remoteDnsBootstrap) remoteDns.domain_resolver = remoteDnsBootstrap.tag;
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
        // Looks up a Remote DNS server given by name, through the proxy (see
        // above).
        ...(remoteDnsBootstrap ? [remoteDnsBootstrap] : []),
        remoteDns,
        // The China-direct split (dns.rules below). No detour: see the DNS
        // detour rules above.
        dnsServerEntry('direct-dns', safeSettings.directDns, DEFAULT_DIRECT_DNS),
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
      // The Clash API is emitted only from backend-supplied credentials (a
      // random loopback port plus a per-start secret; audit P0-1). It used to
      // be a fixed, unauthenticated loopback port that any local program or
      // web page could use to read connections and switch the selector.
      ...(safeSettings.clashApi ? { clash_api: buildClashApiBlock(safeSettings.clashApi) } : {}),
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
      // for leak-proofing: since 1.14 the TUN's `dns_mode` defaults to `hijack`
      // when `auto_route` is enabled (it always is here; since 1.14.3 it
      // defaults to `disabled` without it), and the Windows half of `hijack`
      // is a WFP filter blocking port 53 on every interface except the TUN —
      // which the docs gate explicitly on strict_route. Drop it and Windows'
      // Smart Multi-Homed Name Resolution races the tunnel's resolver against
      // the local network's, keeping the first answer back. The local one wins
      // on latency every time (single-digit ms vs the 200ms+ visible in our own
      // logs), so the network you are on decides what every hostname resolves
      // to. Measured symptom: the tunnel carries traffic fine and no site loads.
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
      stack: tunStack,
    });
  }

  return config;
}

module.exports = {
  generateSingboxConfig,
  nodeRejectionReason,
  shadowsocksPluginReason,
  parseSip003Options,
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
  normalizeTransportType,
  SUPPORTED_TRANSPORTS,
  buildOutboundTags,
  RESERVED_OUTBOUND_TAGS,
  INTERNAL_TAG_PREFIXES,
  SPLIT_SELECTOR_TAG_PREFIX,
  SHADOWTLS_HELPER_TAG_PREFIX,
  splitSelectorTag,
  shadowtlsHelperTag,
  parseDnsServer,
  DEFAULT_REMOTE_DNS,
  DEFAULT_DIRECT_DNS,
};

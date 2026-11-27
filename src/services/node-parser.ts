import type { KnownTransport, ProxyNode, ProxyProtocol } from '../types';
import { decodeBase64Utf8 } from './node-link';

/**
 * Parse proxy link strings into ProxyNode objects.
 * Supports: vmess://, vless://, trojan://, ss://, hysteria2://, tuic://, anytls://
 *
 * Note: WireGuard and ShadowTLS have no widely-agreed share-link format, so
 * they're supported via manual entry / Clash YAML subscriptions instead.
 */
export function parseProxyLink(link: string): ProxyNode | null {
  link = link.trim();
  if (!link) return null;

  try {
    if (link.startsWith('vmess://')) return parseVmess(link);
    if (link.startsWith('vless://')) return parseVless(link);
    if (link.startsWith('trojan://')) return parseTrojan(link);
    if (link.startsWith('ss://')) return parseShadowsocks(link);
    if (link.startsWith('hysteria2://') || link.startsWith('hy2://')) return parseHysteria2(link);
    if (link.startsWith('tuic://')) return parseTuic(link);
    if (link.startsWith('anytls://')) return parseAnytls(link);
    return null;
  } catch (err) {
    // Never log the link: a share link is a credential, and so is an error
    // message that quotes it (V8's JSON.parse errors quote their input). The
    // scheme and the error's name are enough to tell what failed.
    const scheme = link.slice(0, link.indexOf('://'));
    console.error(`Failed to parse a ${scheme}:// link (${err instanceof Error ? err.name : typeof err}).`);
    return null;
  }
}

/**
 * Parse multiple proxy links (one per line or separated by newlines after base64 decode)
 */
export function parseProxyLinks(text: string): ProxyNode[] {
  // Try base64 decode first. UTF-8 aware, and tolerant of the URL-safe
  // alphabet / missing padding that subscription servers often use.
  let decoded = text;
  try {
    decoded = decodeBase64Utf8(text.trim());
  } catch {
    // Not base64, use as-is
  }

  const lines = decoded
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && SUPPORTED_LINK_PREFIXES.some((p) => l.startsWith(p)));

  const nodes: ProxyNode[] = [];
  for (const line of lines) {
    const node = parseProxyLink(line);
    if (node) nodes.push(node);
  }
  return nodes;
}

const SUPPORTED_LINK_PREFIXES = [
  'vmess://',
  'vless://',
  'trojan://',
  'ss://',
  'hysteria2://',
  'hy2://',
  'tuic://',
  'anytls://',
];

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// ==================== Transports ====================
/*
 * The renderer's copy of the transport rules in shared/config-generator.cjs.
 * Links and Clash YAML are stored through normalizeTransportType, and the node
 * form uses SUPPORTED_TRANSPORTS to mark a transport the generator will skip,
 * while the generator normalises every node again with its own copy before it
 * builds or rejects a transport. So both copies MUST agree on every value.
 * tests/unit/transports.test.ts enforces the parity; change both copies
 * together.
 */

/** The transports sing-box has for VMess, VLESS and Trojan (`tcp` = no transport block). */
export const SUPPORTED_TRANSPORTS: ReadonlySet<string> = new Set<KnownTransport>([
  'tcp',
  'ws',
  'grpc',
  'http',
  'quic',
  'httpupgrade',
]);

/**
 * One spelling per transport, whatever the link, the YAML or a stored node says:
 * trimmed and lower-cased; empty, `raw` (Xray's newer name for TCP) and `none`
 * are `tcp`, so nodes stored with them keep working as the plain TCP they
 * always were; `h2` is the http (HTTP/2) transport. Any other name is kept: it
 * is a transport sing-box lacks (xhttp, kcp, ...), and the generator skips such
 * a node with a reason instead of emitting plain TCP that can never connect.
 */
export function normalizeTransportType(value: unknown): KnownTransport | (string & {}) {
  const type = String(value ?? '').trim().toLowerCase();
  if (type === '' || type === 'tcp' || type === 'raw' || type === 'none') return 'tcp';
  if (type === 'h2') return 'http';
  return type;
}

// ==================== VMess ====================
function parseVmess(link: string): ProxyNode | null {
  // vmess://base64(json)
  const base64 = link.replace('vmess://', '');
  let json: any;
  try {
    // Must decode as UTF-8, not latin1. `atob` alone turns a name like
    // "香港 01" into mojibake, which then shows up as garbage in the node list
    // and in any link we re-emit.
    json = JSON.parse(decodeBase64Utf8(base64));
  } catch {
    return null;
  }

  return {
    id: generateId(),
    name: json.ps || `${json.add}:${json.port}`,
    type: 'vmess',
    server: json.add || '',
    port: parseInt(json.port) || 443,
    uuid: json.id || '',
    alterId: parseInt(json.aid) || 0,
    security: json.scy || 'auto',
    tls: json.tls === 'tls',
    sni: json.sni || json.host || '',
    // uTLS fingerprint, which buildProxyLink writes as `fp` too. Left out, not
    // '', when the link has none: a refresh compares nodes as JSON
    // (subscription-merge), so a new '' on every node would count as a change.
    fingerprint: json.fp ? String(json.fp) : undefined,
    // Through the normaliser, so httpupgrade, quic, kcp or xhttp are no longer
    // all silently stored as tcp.
    transportType: normalizeTransportType(json.net),
    transportPath: json.path || '',
    transportHost: json.host || '',
    country: extractCountryFromName(json.ps),
  };
}

// ==================== URI authority parser ====================
/**
 * Parse a proxy URI of the form:
 *   scheme://[userinfo@]host[:port][?query][#fragment]
 *
 * We deliberately DO NOT use `new URL()` here. The WHATWG URL parser treats
 * non-special schemes (vless, trojan, hysteria2, ...) inconsistently across
 * engines: Chromium (Electron renderer) leaves `.hostname` and `.username`
 * EMPTY for these schemes, while Node populates them. That discrepancy is the
 * reason imported nodes showed a blank Server and UUID in the app even though
 * Node-based tests passed. Manual parsing is engine-independent and reliable.
 */
interface UriParts {
  userinfo: string;
  host: string;
  port: number;
  params: URLSearchParams;
  fragment: string;
}

function parseUri(link: string, defaultPort = 443): UriParts | null {
  // Strip scheme.
  const schemeIdx = link.indexOf('://');
  if (schemeIdx === -1) return null;
  let rest = link.slice(schemeIdx + 3);

  // Fragment (#name) — everything after the first '#'.
  let fragment = '';
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }

  // Query (?a=b) — everything after the first '?'.
  let query = '';
  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  // Userinfo (uuid/password) — everything before the LAST '@'
  // (passwords can technically contain '@', so split on the last one).
  let authority = rest;
  let userinfo = '';
  const atIdx = authority.lastIndexOf('@');
  if (atIdx !== -1) {
    userinfo = authority.slice(0, atIdx);
    authority = authority.slice(atIdx + 1);
  }

  // Trim any leftover path (e.g. trailing '/').
  const slashIdx = authority.indexOf('/');
  if (slashIdx !== -1) authority = authority.slice(0, slashIdx);

  // Host + port, IPv6 literals included: [2606:4700::1]:443
  const address = splitHostPort(authority, defaultPort);
  if (!address || !address.host) return null;
  const { host, port } = address;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    params = new URLSearchParams();
  }

  return { userinfo, host, port, params, fragment };
}

/**
 * Split `host[:port]` or `[ipv6][:port]`. An IPv6 host comes back WITHOUT its
 * brackets, the bare address a node holds when it comes from a vmess payload,
 * Clash YAML or the node form; formatHost (node-link.ts) puts them back when it
 * builds a link. Links used to keep them, so such a node came back from its own
 * link with a different server. Returns null for an unclosed bracket.
 */
function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  let host = authority;
  let port = defaultPort;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return null;
    host = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after.startsWith(':')) {
      const p = parseInt(after.slice(1));
      if (p) port = p;
    }
  } else {
    const colonIdx = authority.lastIndexOf(':');
    if (colonIdx !== -1) {
      host = authority.slice(0, colonIdx);
      const p = parseInt(authority.slice(colonIdx + 1));
      if (p) port = p;
    }
  }
  return { host, port };
}

/**
 * The name of a node whose link has none: `host:port`, with an IPv6 host in
 * brackets as the link wrote it, so that name reads as it did before hosts
 * lost their brackets (a refresh pairs nodes by name first).
 */
function hostPortLabel(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Percent-decode a secret carried in the userinfo position.
 *
 * Required, not cosmetic: a password containing `@`, `#`, `?` or `/` has to be
 * encoded to keep the URI parseable, so skipping the decode silently imports a
 * literally wrong password and the node just fails to connect.
 */
function decodeSecret(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeName(fragment: string, fallback: string): string {
  if (!fragment) return fallback;
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

// ==================== VLess ====================
function parseVless(link: string): ProxyNode | null {
  // vless://uuid@server:port?params#name
  const uri = parseUri(link);
  if (!uri || !uri.userinfo) return null;
  const { host: server, port, params } = uri;
  const uuid = decodeSecret(uri.userinfo);
  const name = decodeName(uri.fragment, hostPortLabel(server, port));

  const security = params.get('security');
  const isReality = security === 'reality';

  return {
    id: generateId(),
    name,
    type: 'vless',
    server,
    port,
    uuid,
    flow: params.get('flow') || '',
    tls: security === 'tls' || security === 'reality',
    sni: params.get('sni') || params.get('host') || '',
    fingerprint: params.get('fp') || '',
    realityPublicKey: isReality ? (params.get('pbk') || '') : undefined,
    realityShortId: isReality ? (params.get('sid') || '') : undefined,
    // Only when set, like vmess's fingerprint: a new `false` on every node
    // would make the next refresh report them all as changed.
    allowInsecure: params.get('allowInsecure') === '1' || params.get('insecure') === '1' ? true : undefined,
    transportType: normalizeTransportType(params.get('type')),
    transportPath: params.get('path') || params.get('serviceName') || '',
    transportHost: params.get('host') || '',
    country: extractCountryFromName(name),
  };
}

// ==================== Trojan ====================
function parseTrojan(link: string): ProxyNode | null {
  // trojan://password@server:port?params#name
  const uri = parseUri(link);
  if (!uri || !uri.userinfo) return null;
  const { host: server, port, params } = uri;
  const password = decodeSecret(uri.userinfo);
  const name = decodeName(uri.fragment, hostPortLabel(server, port));

  return {
    id: generateId(),
    name,
    type: 'trojan',
    server,
    port,
    password,
    tls: true,
    sni: params.get('sni') || params.get('host') || server,
    transportType: normalizeTransportType(params.get('type')),
    // As for VMess and VLESS: the path, or gRPC's service name, which links
    // carry as `serviceName`.
    transportPath: params.get('path') || params.get('serviceName') || '',
    // The ws / httpupgrade Host header (it also stands in for a missing sni,
    // above). Left out when the link has no host, like vmess's fingerprint.
    transportHost: params.get('host') || undefined,
    allowInsecure: params.get('allowInsecure') === '1' || params.get('insecure') === '1',
    country: extractCountryFromName(name),
  };
}

// ==================== Shadowsocks ====================
function parseShadowsocks(link: string): ProxyNode | null {
  // SIP002: ss://base64(method:password)@server:port[/][?plugin=...][#name]
  // Legacy: ss://base64(method:password@server:port)[#name]
  // The name and the query come off first, in both forms, so neither can be
  // mistaken for part of the address. Splitting the rest at ':' used to break
  // an IPv6 host and drop `?plugin=`.
  const rest = link.slice('ss://'.length);
  const hashIdx = rest.indexOf('#');
  const fragment = hashIdx === -1 ? '' : rest.slice(hashIdx + 1);
  const beforeHash = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const qIdx = beforeHash.indexOf('?');
  const params = new URLSearchParams(qIdx === -1 ? '' : beforeHash.slice(qIdx + 1));
  const body = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);

  let methodPass: string, server: string, port: number;

  if (body.includes('@')) {
    // SIP002, through the URI parser the other schemes use, so an IPv6 host
    // ([2001:db8::1]:8388) parses. The userinfo is base64 and holds no '@'.
    const uri = parseUri(link);
    if (!uri || !uri.userinfo) return null;
    try {
      // SIP002 links commonly use the URL-safe alphabet with no padding, which
      // plain `atob` refuses — those links used to fail to import at all.
      methodPass = decodeBase64Utf8(uri.userinfo);
    } catch {
      return null;
    }
    server = uri.host;
    port = uri.port;
  } else {
    // Legacy: everything before the name and query is base64.
    let decoded: string;
    try {
      decoded = decodeBase64Utf8(body);
    } catch {
      return null;
    }
    // method:password@server:port, split at the last '@' (a password may hold one).
    const atIdx = decoded.lastIndexOf('@');
    if (atIdx === -1) return null;
    const address = splitHostPort(decoded.slice(atIdx + 1), 443);
    if (!address) return null;
    methodPass = decoded.slice(0, atIdx);
    server = address.host;
    port = address.port;
  }

  const colonIdx = methodPass.indexOf(':');
  const method = methodPass.slice(0, colonIdx);
  const password = methodPass.slice(colonIdx + 1);
  const name = decodeName(fragment, '');

  return {
    id: generateId(),
    name: name || hostPortLabel(server, port),
    type: 'shadowsocks',
    server,
    port,
    method,
    password,
    ...parseSsPlugin(params.get('plugin')),
    country: extractCountryFromName(name),
  };
}

/**
 * The SIP003 plugin of a SIP002 link: `plugin=<name>[;<options>]`, as in
 * `obfs-local;obfs=http;obfs-host=example.com`. Only the two plugins sing-box
 * has are kept (its docs: "Only obfs-local and v2ray-plugin are supported");
 * a link naming another one imports without a plugin, as it always did. Both
 * fields are left out when the link has none, like vmess's fingerprint.
 */
function parseSsPlugin(value: string | null): Pick<ProxyNode, 'plugin' | 'pluginOpts'> {
  if (!value) return {};
  const semi = value.indexOf(';');
  const plugin = semi === -1 ? value : value.slice(0, semi);
  if (plugin !== 'obfs-local' && plugin !== 'v2ray-plugin') return {};
  const pluginOpts = semi === -1 ? '' : value.slice(semi + 1);
  return pluginOpts ? { plugin, pluginOpts } : { plugin };
}

// ==================== Hysteria2 ====================
function parseHysteria2(link: string): ProxyNode | null {
  // hysteria2://password@server:port?params#name
  const uri = parseUri(link);
  if (!uri || !uri.userinfo) return null;
  const { host: server, port, params } = uri;
  const password = decodeSecret(uri.userinfo);
  const name = decodeName(uri.fragment, hostPortLabel(server, port));

  // QUIC obfuscation. The official hysteria2 URI scheme uses `obfs` for the
  // type and `obfs-password` for the secret; some generators use `obfsParam`.
  const obfs = (params.get('obfs') || '').toLowerCase();
  const obfsPassword =
    params.get('obfs-password') || params.get('obfs_password') || params.get('obfsParam') || '';

  // Port hopping. Clients spell this `mport` (nekoray/v2rayN) or `ports`.
  // Accepts "1000-2000,3000-4000" or "1000:2000"; sing-box wants "start:end".
  const rawPorts = params.get('mport') || params.get('ports') || '';
  const serverPorts = rawPorts
    ? rawPorts
        .split(',')
        .map((r) => r.trim().replace('-', ':'))
        .filter(Boolean)
    : undefined;

  const up = parseInt(params.get('upmbps') || params.get('up') || '');
  const down = parseInt(params.get('downmbps') || params.get('down') || '');

  return {
    id: generateId(),
    name,
    type: 'hysteria2',
    server,
    port,
    password,
    tls: true,
    sni: params.get('sni') || params.get('peer') || server,
    allowInsecure: params.get('insecure') === '1',
    // Only "salamander" (any core) and "gecko" (1.14+) exist; ignore anything
    // else so we never carry an obfs type no core understands. A gecko node on
    // an older core is skipped later, with the reason logged.
    obfsType: obfs === 'salamander' || obfs === 'gecko' ? obfs : undefined,
    obfsPassword: (obfs === 'salamander' || obfs === 'gecko') && obfsPassword ? obfsPassword : undefined,
    serverPorts: serverPorts && serverPorts.length ? serverPorts : undefined,
    hopInterval: params.get('hop_interval') || params.get('hopInterval') || undefined,
    upMbps: Number.isFinite(up) && up > 0 ? up : undefined,
    downMbps: Number.isFinite(down) && down > 0 ? down : undefined,
    country: extractCountryFromName(name),
  };
}

// ==================== TUIC ====================
function parseTuic(link: string): ProxyNode | null {
  // tuic://uuid:password@server:port?params#name
  // TUIC v5 carries BOTH a uuid and a password in the userinfo, separated by a
  // colon (unlike trojan/hysteria2 which only carry one secret).
  const uri = parseUri(link);
  if (!uri || !uri.userinfo) return null;
  const { host: server, port, params } = uri;
  const name = decodeName(uri.fragment, hostPortLabel(server, port));

  const colonIdx = uri.userinfo.indexOf(':');
  let uuid = uri.userinfo;
  let password = '';
  if (colonIdx !== -1) {
    uuid = uri.userinfo.slice(0, colonIdx);
    password = uri.userinfo.slice(colonIdx + 1);
  }
  try {
    uuid = decodeURIComponent(uuid);
    password = decodeURIComponent(password);
  } catch {
    /* keep raw values */
  }

  const cc = params.get('congestion_control') || params.get('congestion') || '';
  const urm = params.get('udp_relay_mode') || '';

  return {
    id: generateId(),
    name,
    type: 'tuic',
    server,
    port,
    uuid,
    password,
    // TUIC is QUIC-based, so TLS is always on.
    tls: true,
    sni: params.get('sni') || params.get('peer') || server,
    allowInsecure: params.get('allow_insecure') === '1' || params.get('insecure') === '1',
    congestionControl: (['cubic', 'new_reno', 'bbr'] as const).includes(cc as any)
      ? (cc as ProxyNode['congestionControl'])
      : undefined,
    udpRelayMode: (['native', 'quic'] as const).includes(urm as any)
      ? (urm as ProxyNode['udpRelayMode'])
      : undefined,
    country: extractCountryFromName(name),
  };
}

// ==================== AnyTLS ====================
function parseAnytls(link: string): ProxyNode | null {
  // anytls://password@server:port?params#name
  const uri = parseUri(link);
  if (!uri || !uri.userinfo) return null;
  const { host: server, port, params } = uri;
  const name = decodeName(uri.fragment, hostPortLabel(server, port));

  let password = uri.userinfo;
  try {
    password = decodeURIComponent(password);
  } catch {
    /* keep raw value */
  }

  return {
    id: generateId(),
    name,
    type: 'anytls',
    server,
    port,
    password,
    // AnyTLS always runs over TLS.
    tls: true,
    sni: params.get('sni') || params.get('peer') || server,
    allowInsecure: params.get('allow_insecure') === '1' || params.get('insecure') === '1',
    country: extractCountryFromName(name),
  };
}

// ==================== Utilities ====================

const countryKeywords: Record<string, string> = {
  '美国': 'US', 'US': 'US', 'USA': 'US', 'United States': 'US',
  '日本': 'JP', 'Japan': 'JP', 'JP': 'JP',
  '香港': 'HK', 'Hong Kong': 'HK', 'HK': 'HK',
  '新加坡': 'SG', 'Singapore': 'SG', 'SG': 'SG',
  '台湾': 'TW', 'Taiwan': 'TW', 'TW': 'TW',
  '韩国': 'KR', 'Korea': 'KR', 'KR': 'KR',
  '英国': 'UK', 'UK': 'UK', 'United Kingdom': 'UK', 'Britain': 'UK',
  '德国': 'DE', 'Germany': 'DE', 'DE': 'DE',
  '法国': 'FR', 'France': 'FR', 'FR': 'FR',
  '澳大利亚': 'AU', 'Australia': 'AU', 'AU': 'AU',
  '加拿大': 'CA', 'Canada': 'CA', 'CA': 'CA',
  '印度': 'IN', 'India': 'IN', 'IN': 'IN',
  '荷兰': 'NL', 'Netherlands': 'NL', 'NL': 'NL',
  '俄罗斯': 'RU', 'Russia': 'RU', 'RU': 'RU',
  '巴西': 'BR', 'Brazil': 'BR', 'BR': 'BR',
  '土耳其': 'TR', 'Turkey': 'TR', 'TR': 'TR',
  '印度尼西亚': 'ID', 'Indonesia': 'ID', 'ID': 'ID',
  '菲律宾': 'PH', 'Philippines': 'PH', 'PH': 'PH',
  '泰国': 'TH', 'Thailand': 'TH', 'TH': 'TH',
  '越南': 'VN', 'Vietnam': 'VN', 'VN': 'VN',
  '马来西亚': 'MY', 'Malaysia': 'MY', 'MY': 'MY',
};

function extractCountryFromName(name: string): string | undefined {
  if (!name) return undefined;
  for (const [keyword, code] of Object.entries(countryKeywords)) {
    if (name.includes(keyword)) return code;
  }
  return undefined;
}

/**
 * Get country flag emoji from country code
 */
export function getCountryFlag(code?: string): string {
  if (!code) return '🌐';
  const codeMap: Record<string, string> = {
    'US': '🇺🇸', 'JP': '🇯🇵', 'HK': '🇭🇰', 'SG': '🇸🇬', 'TW': '🇹🇼',
    'KR': '🇰🇷', 'UK': '🇬🇧', 'DE': '🇩🇪', 'FR': '🇫🇷', 'AU': '🇦🇺',
    'CA': '🇨🇦', 'IN': '🇮🇳', 'NL': '🇳🇱', 'RU': '🇷🇺', 'BR': '🇧🇷',
    'TR': '🇹🇷', 'ID': '🇮🇩', 'PH': '🇵🇭', 'TH': '🇹🇭', 'VN': '🇻🇳',
    'MY': '🇲🇾',
  };
  return codeMap[code?.toUpperCase()] || '🌐';
}

/**
 * Get protocol display color
 */
export function getProtocolColor(type: ProxyProtocol): string {
  const colors: Record<ProxyProtocol, string> = {
    vmess: '#3b82f6',     // blue
    vless: '#8b5cf6',     // purple
    trojan: '#f59e0b',    // amber
    shadowsocks: '#22c55e', // green
    hysteria2: '#ef4444', // red
    wireguard: '#06b6d4', // cyan
    tuic: '#ec4899',      // pink
    anytls: '#14b8a6',    // teal
    shadowtls: '#a855f7', // violet
    openvpn: '#f97316',   // orange
  };
  return colors[type] || '#64748b';
}
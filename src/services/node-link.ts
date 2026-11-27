import type { ProxyNode } from '../types';

/**
 * Build share links (vmess://, vless://, ...) from a ProxyNode.
 *
 * This replaces an inline builder that produced links other clients rejected.
 * The defects it had, all of which this module fixes:
 *
 *   - `btoa()` THREW on any node whose name contained non-Latin1 characters,
 *     which is most of them ("🇯🇵 JP3", "香港 01"). Copy silently produced
 *     nothing. Base64 now goes through UTF-8 encoding first.
 *   - TUIC, AnyTLS, ShadowTLS and WireGuard had no branch at all, so copying
 *     one of those nodes yielded an EMPTY string. AnyTLS in particular is most
 *     of a typical subscription now.
 *   - VLESS omitted the ws `host` (Host header) and used `path` for gRPC where
 *     other clients expect `serviceName`, so ws/grpc nodes imported elsewhere
 *     were subtly wrong rather than obviously broken.
 *   - Trojan omitted transport (`type`/`path`/`host`) and `allowInsecure`.
 *   - Hysteria2 omitted obfs, port hopping and bandwidth entirely.
 *   - Secrets were interpolated raw, so a password containing `@`, `#`, `?` or
 *     `/` produced an unparseable URI.
 *   - VLESS omitted `allowInsecure`, Hysteria2 the hop interval, httpupgrade
 *     the `path` and `host`, and Shadowsocks its SIP003 plugin, so those nodes
 *     came back from their own link without them (audit P1-8).
 *
 * Field names follow what v2rayN / nekoray / mihomo actually read, and every
 * link this module emits is round-trip tested against our own parser.
 */

/** Base64 of a UTF-8 string. `btoa` alone throws above U+00FF. */
export function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode base64 that may contain UTF-8 multi-byte sequences. */
export function decodeBase64Utf8(input: string): string {
  // Tolerate URL-safe alphabet and missing padding, both common in the wild.
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/').trim();
  const remainder = normalized.length % 4;
  if (remainder) normalized += '='.repeat(4 - remainder);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Wrap IPv6 literals in brackets so `host:port` stays unambiguous. */
function formatHost(server: string): string {
  if (!server) return '';
  if (server.includes(':') && !server.startsWith('[')) return `[${server}]`;
  return server;
}

function fragment(name: string): string {
  return name ? `#${encodeURIComponent(name)}` : '';
}

/** Append a param only when it has a meaningful value. */
function setIf(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  const text = String(value);
  if (!text) return;
  params.set(key, text);
}

/**
 * Transport params shared by VLESS and Trojan.
 * gRPC uses `serviceName`; ws/httpupgrade/http use `path` + `host`.
 *
 * `transportType` is used as stored: the parser and the YAML import have
 * already normalised it (normalizeTransportType in node-parser.ts, which can't
 * be imported here because node-parser imports this module).
 */
function addTransportParams(params: URLSearchParams, node: ProxyNode): void {
  const type = node.transportType || 'tcp';
  params.set('type', type);
  if (type === 'grpc') {
    setIf(params, 'serviceName', node.transportPath);
    return;
  }
  if (type === 'ws' || type === 'httpupgrade' || type === 'http') {
    setIf(params, 'path', node.transportPath);
    setIf(params, 'host', node.transportHost);
  }
}

function buildVmess(node: ProxyNode): string {
  // v2rayN's JSON payload. Numbers are stringified because several clients
  // (including older nekoray builds) assume strings here.
  const payload = {
    v: '2',
    ps: node.name || '',
    add: node.server,
    port: String(node.port),
    id: node.uuid || '',
    aid: String(node.alterId || 0),
    scy: node.security || 'auto',
    net: node.transportType === 'http' ? 'h2' : node.transportType || 'tcp',
    type: 'none',
    host: node.transportHost || '',
    path: node.transportPath || '',
    tls: node.tls ? 'tls' : '',
    sni: node.tls ? node.sni || '' : '',
    fp: node.fingerprint || '',
  };
  return `vmess://${base64Utf8(JSON.stringify(payload))}`;
}

function buildVless(node: ProxyNode): string {
  const params = new URLSearchParams();
  // VLESS has no encryption layer of its own; the field is mandatory and is
  // always "none". Some clients reject the link without it.
  params.set('encryption', 'none');
  if (node.realityPublicKey) {
    params.set('security', 'reality');
    setIf(params, 'pbk', node.realityPublicKey);
    setIf(params, 'sid', node.realityShortId);
  } else {
    params.set('security', node.tls ? 'tls' : 'none');
  }
  setIf(params, 'sni', node.sni);
  setIf(params, 'fp', node.fingerprint);
  setIf(params, 'flow', node.flow);
  addTransportParams(params, node);
  // Spelled as Trojan's; the parser reads it (or `insecure=1`) for both.
  if (node.allowInsecure) params.set('allowInsecure', '1');
  const secret = encodeURIComponent(node.uuid || '');
  return `vless://${secret}@${formatHost(node.server)}:${node.port}?${params}${fragment(node.name)}`;
}

function buildTrojan(node: ProxyNode): string {
  const params = new URLSearchParams();
  params.set('security', 'tls');
  setIf(params, 'sni', node.sni);
  addTransportParams(params, node);
  if (node.allowInsecure) params.set('allowInsecure', '1');
  const secret = encodeURIComponent(node.password || '');
  return `trojan://${secret}@${formatHost(node.server)}:${node.port}?${params}${fragment(node.name)}`;
}

function buildShadowsocks(node: ProxyNode): string {
  // SIP002: ss://base64(method:password)@host:port[/?plugin=...]#name
  const userinfo = base64Utf8(`${node.method || 'aes-256-gcm'}:${node.password || ''}`);
  const address = `${formatHost(node.server)}:${node.port}`;
  if (!node.plugin) return `ss://${userinfo}@${address}${fragment(node.name)}`;
  // SIP002 carries the SIP003 plugin and its options as ONE parameter,
  // `<plugin>;<options>`, after a '/'. URLSearchParams percent-encodes the
  // ';' and '=' in it (plugin=obfs-local%3Bobfs%3Dhttp), as the spec's own
  // examples do.
  const params = new URLSearchParams();
  params.set('plugin', node.pluginOpts ? `${node.plugin};${node.pluginOpts}` : node.plugin);
  return `ss://${userinfo}@${address}/?${params}${fragment(node.name)}`;
}

function buildHysteria2(node: ProxyNode): string {
  const params = new URLSearchParams();
  setIf(params, 'sni', node.sni);
  if (node.allowInsecure) params.set('insecure', '1');
  if (node.obfsType && node.obfsPassword) {
    params.set('obfs', node.obfsType);
    params.set('obfs-password', node.obfsPassword);
  }
  if (Array.isArray(node.serverPorts) && node.serverPorts.length) {
    // Port hopping is spelled `mport` by nekoray/v2rayN, with ranges as a-b.
    params.set('mport', node.serverPorts.map((r) => r.replace(':', '-')).join(','));
  }
  // The hop interval, e.g. 30s. The parser reads `hop_interval` and `hopInterval`.
  setIf(params, 'hop_interval', node.hopInterval);
  setIf(params, 'upmbps', node.upMbps);
  setIf(params, 'downmbps', node.downMbps);
  const secret = encodeURIComponent(node.password || '');
  return `hysteria2://${secret}@${formatHost(node.server)}:${node.port}?${params}${fragment(node.name)}`;
}

function buildTuic(node: ProxyNode): string {
  const params = new URLSearchParams();
  setIf(params, 'sni', node.sni);
  setIf(params, 'congestion_control', node.congestionControl);
  setIf(params, 'udp_relay_mode', node.udpRelayMode);
  if (node.allowInsecure) params.set('allow_insecure', '1');
  // TUIC v5 carries uuid AND password, colon-separated.
  const userinfo = `${encodeURIComponent(node.uuid || '')}:${encodeURIComponent(node.password || '')}`;
  return `tuic://${userinfo}@${formatHost(node.server)}:${node.port}?${params}${fragment(node.name)}`;
}

function buildAnytls(node: ProxyNode): string {
  const params = new URLSearchParams();
  setIf(params, 'sni', node.sni);
  if (node.allowInsecure) params.set('insecure', '1');
  const secret = encodeURIComponent(node.password || '');
  return `anytls://${secret}@${formatHost(node.server)}:${node.port}?${params}${fragment(node.name)}`;
}

/** Protocols with no widely-agreed share-link format. */
const NO_LINK_FORMAT: Record<string, string> = {
  wireguard: 'WireGuard has no share-link format — use Share → Copy as WireGuard config, or a Clash subscription.',
  shadowtls: 'ShadowTLS has no share-link format — it is only carried by Clash/Mihomo subscriptions.',
  openvpn: 'OpenVPN has no share-link format — share the .ovpn profile file instead.',
};

export interface LinkResult {
  link?: string;
  /** Set when this protocol genuinely cannot be represented as a link. */
  error?: string;
}

/**
 * Build a share link for `node`, or explain why it can't be done.
 * Never throws — a copy button is not worth crashing a page over.
 */
export function buildProxyLink(node: ProxyNode): LinkResult {
  const unsupported = NO_LINK_FORMAT[node.type];
  if (unsupported) return { error: unsupported };

  try {
    switch (node.type) {
      case 'vmess':
        return { link: buildVmess(node) };
      case 'vless':
        return { link: buildVless(node) };
      case 'trojan':
        return { link: buildTrojan(node) };
      case 'shadowsocks':
        return { link: buildShadowsocks(node) };
      case 'hysteria2':
        return { link: buildHysteria2(node) };
      case 'tuic':
        return { link: buildTuic(node) };
      case 'anytls':
        return { link: buildAnytls(node) };
      default:
        return { error: `Copying a ${node.type} link is not supported yet.` };
    }
  } catch (err: any) {
    return { error: err?.message || 'Could not build a link for this node.' };
  }
}

export interface ShareBundle {
  /** One link per shareable node, in list order. */
  links: string[];
  /** The nodes behind `links`, in the same order (the QR pager names them). */
  shared: ProxyNode[];
  /** The nodes that have no link, each with buildProxyLink's reason. */
  skipped: { name: string; reason: string }[];
  /** The links, one per line: what Copy all links and Save .txt hand over. */
  text: string;
  /**
   * `text` as base64 of its UTF-8: a plain subscription body, the format our
   * own importer (parseProxyLinks) and v2rayN / NekoBox read.
   */
  base64: string;
}

/**
 * Share several nodes at once (Share (N) on the Nodes page). Never throws: a
 * node that can't become a link goes to `skipped` with the reason, and the
 * rest are still shared, so one WireGuard node doesn't block the others.
 */
export function buildShareBundle(nodes: readonly ProxyNode[]): ShareBundle {
  const links: string[] = [];
  const shared: ProxyNode[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const node of nodes) {
    const result = buildProxyLink(node);
    if (result.link) {
      links.push(result.link);
      shared.push(node);
    } else {
      skipped.push({ name: node.name, reason: result.error || 'Could not build a link for this node.' });
    }
  }
  const text = links.join('\n');
  return { links, shared, skipped, text, base64: base64Utf8(text) };
}

export interface WireguardConfigResult {
  /** The config text, in the format the official WireGuard apps import from a file or a QR code. */
  config?: string;
  /** Something the node has that the format can't carry. The config is still built. */
  warning?: string;
  /** Set instead of `config` when the node lacks a key every config needs. */
  error?: string;
}

/**
 * Export a WireGuard node in the standard config format. WireGuard has no
 * share-link format, so this text (or its QR code) is how such a node is
 * shared with the official apps and most other clients.
 *
 * It describes the tunnel the generator builds: the same fallback address,
 * and AllowedIPs covering everything, because the generator's endpoint routes
 * all traffic through the peer. Errors name the missing key, never a value.
 */
export function buildWireguardConfig(node: ProxyNode): WireguardConfigResult {
  if (!node.privateKey) {
    return { error: 'This WireGuard node has no private key, so there is no config to export.' };
  }
  if (!node.peerPublicKey) {
    return { error: 'This WireGuard node has no peer public key, so there is no config to export.' };
  }

  const address =
    Array.isArray(node.localAddress) && node.localAddress.length ? node.localAddress : ['10.0.0.2/32'];
  const lines = ['[Interface]', `PrivateKey = ${node.privateKey}`, `Address = ${address.join(', ')}`];
  if (node.mtu) lines.push(`MTU = ${node.mtu}`);
  lines.push('', '[Peer]', `PublicKey = ${node.peerPublicKey}`);
  if (node.preSharedKey) lines.push(`PresharedKey = ${node.preSharedKey}`);
  lines.push(`Endpoint = ${formatHost(node.server)}:${node.port}`, 'AllowedIPs = 0.0.0.0/0, ::/0');
  if (node.persistentKeepalive) lines.push(`PersistentKeepalive = ${node.persistentKeepalive}`);

  const result: WireguardConfigResult = { config: `${lines.join('\n')}\n` };
  // Same condition as the generator's for emitting `reserved`. The standard
  // format has no field for it, so the exported config lacks those bytes.
  if (Array.isArray(node.reserved) && node.reserved.length === 3) {
    result.warning =
      "This node sets WireGuard reserved bytes, which the standard config format can't carry. " +
      'A client connecting to a server that needs them (WARP-style servers) may fail with this config.';
  }
  return result;
}

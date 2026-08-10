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
 * gRPC uses `serviceName`; ws/http use `path` + `host`.
 */
function addTransportParams(params: URLSearchParams, node: ProxyNode): void {
  const type = node.transportType || 'tcp';
  params.set('type', type);
  if (type === 'grpc') {
    setIf(params, 'serviceName', node.transportPath);
    return;
  }
  if (type === 'ws' || type === 'http') {
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
  // SIP002: ss://base64(method:password)@host:port#name
  const userinfo = base64Utf8(`${node.method || 'aes-256-gcm'}:${node.password || ''}`);
  return `ss://${userinfo}@${formatHost(node.server)}:${node.port}${fragment(node.name)}`;
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
  wireguard: 'WireGuard has no share-link format — export the peer config or use a Clash subscription.',
  shadowtls: 'ShadowTLS has no share-link format — it is only carried by Clash/Mihomo subscriptions.',
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

import yaml from 'js-yaml';
import type { Subscription, ProxyNode } from '../types';
import { parseProxyLinks } from './node-parser';

/**
 * Fetch and parse a subscription URL into proxy nodes
 */
export async function fetchSubscription(sub: Subscription): Promise<{
  nodes: ProxyNode[];
  error?: string;
}> {
  try {
    const response = await window.api.network.fetchUrl(sub.url, 15000);
    if (!response) {
      return { nodes: [], error: 'Empty response from subscription URL' };
    }

    // Subscriptions come in two common shapes:
    //   1. A (often base64-encoded) list of vmess://, vless://, ... links.
    //   2. A Clash/Mihomo YAML document with a `proxies:` array.
    // Try the link-list form first, then fall back to YAML.
    let nodes = parseProxyLinks(response);

    if (nodes.length === 0) {
      const yamlNodes = parseClashYaml(response);
      if (yamlNodes.length > 0) {
        nodes = yamlNodes;
      } else {
        return { nodes: [], error: 'No valid proxy nodes found in subscription' };
      }
    }

    // Tag nodes with subscription ID
    for (const node of nodes) {
      node.subscriptionId = sub.id;
    }

    return { nodes, error: undefined };
  } catch (err: any) {
    return { nodes: [], error: err.message || 'Failed to fetch subscription' };
  }
}

/**
 * Parse a Clash / Mihomo YAML document into ProxyNode objects.
 *
 * Uses a real YAML parser (js-yaml) rather than regex. The previous
 * regex-based approach silently dropped fields (server, uuid, ...) whenever a
 * proxy entry contained nested maps such as `reality-opts: { ... }` or
 * `ws-opts: { ... }`, because the brace matcher stopped at the first `}`.
 */
export function parseClashYaml(content: string): ProxyNode[] {
  let doc: any;
  try {
    doc = yaml.load(content);
  } catch (err) {
    console.error('Failed to parse Clash YAML:', err);
    return [];
  }

  const proxies = doc && Array.isArray(doc.proxies) ? doc.proxies : null;
  if (!proxies) return [];

  const nodes: ProxyNode[] = [];
  for (const proxy of proxies) {
    const node = clashProxyToNode(proxy);
    if (node) nodes.push(node);
  }
  return nodes;
}

/**
 * Convert a single parsed Clash proxy object into a ProxyNode.
 */
function clashProxyToNode(proxy: any): ProxyNode | null {
  if (!proxy || typeof proxy !== 'object') return null;

  const rawType = String(proxy.type || '').toLowerCase();
  const type = normalizeType(rawType);
  const server = proxy.server ? String(proxy.server) : '';
  const port = parseInt(proxy.port) || 0;

  if (!type || !server || !port) return null;

  const node: ProxyNode = {
    id: generateId(),
    name: proxy.name ? String(proxy.name) : `${server}:${port}`,
    type,
    server,
    port,
    country: undefined,
  };

  // Credentials
  if (proxy.uuid) node.uuid = String(proxy.uuid);
  if (proxy.password) node.password = String(proxy.password);
  // Shadowsocks uses `cipher`; some formats use `method`.
  const cipher = proxy.cipher || proxy.method;
  if (cipher) node.method = String(cipher);

  // TLS / SNI
  const tls = proxy.tls;
  if (tls === true || tls === 'true') node.tls = true;
  const sni = proxy.servername || proxy.sni;
  if (sni) node.sni = String(sni);
  if (proxy['skip-cert-verify'] === true) node.allowInsecure = true;
  const fp = proxy['client-fingerprint'];
  if (fp) node.fingerprint = String(fp);

  // Transport
  if (proxy.network) node.transportType = String(proxy.network) as ProxyNode['transportType'];
  const wsOpts = proxy['ws-opts'];
  if (wsOpts && typeof wsOpts === 'object') {
    if (wsOpts.path) node.transportPath = String(wsOpts.path);
    if (wsOpts.headers && wsOpts.headers.Host) node.transportHost = String(wsOpts.headers.Host);
  } else if (proxy['ws-path']) {
    node.transportPath = String(proxy['ws-path']);
  }
  const grpcOpts = proxy['grpc-opts'];
  if (grpcOpts && typeof grpcOpts === 'object' && grpcOpts['grpc-service-name']) {
    node.transportPath = String(grpcOpts['grpc-service-name']);
  }

  // Protocol specifics
  if (type === 'vmess') {
    const aid = proxy.alterId ?? proxy.aid;
    if (aid !== undefined) node.alterId = parseInt(aid) || 0;
    if (cipher) node.security = String(cipher);
  }

  if (type === 'vless') {
    if (proxy.flow) node.flow = String(proxy.flow);
    // Reality support
    const reality = proxy['reality-opts'];
    if (reality && typeof reality === 'object') {
      node.tls = true;
      if (reality['public-key']) node.realityPublicKey = String(reality['public-key']);
      if (reality['short-id'] !== undefined && reality['short-id'] !== null) {
        node.realityShortId = String(reality['short-id']);
      }
    }
  }

  node.country = extractCountryFromName(node.name);
  return node;
}

function normalizeType(type: string): ProxyNode['type'] | null {
  const map: Record<string, ProxyNode['type']> = {
    vmess: 'vmess',
    vless: 'vless',
    trojan: 'trojan',
    ss: 'shadowsocks',
    shadowsocks: 'shadowsocks',
    hysteria2: 'hysteria2',
    hy2: 'hysteria2',
    wireguard: 'wireguard',
    wg: 'wireguard',
    tuic: 'tuic',
  };
  return map[type] || null;
}

// Lightweight country detection mirroring node-parser (avoids exporting it).
function extractCountryFromName(name: string): string | undefined {
  if (!name) return undefined;
  const keywords: Record<string, string> = {
    '美国': 'US', 'US': 'US', 'USA': 'US', '日本': 'JP', 'Japan': 'JP', 'JP': 'JP',
    '香港': 'HK', 'Hong Kong': 'HK', 'HK': 'HK', '新加坡': 'SG', 'Singapore': 'SG', 'SG': 'SG',
    '台湾': 'TW', 'Taiwan': 'TW', 'TW': 'TW', '韩国': 'KR', 'Korea': 'KR', 'KR': 'KR',
    '英国': 'UK', 'UK': 'UK', '德国': 'DE', 'Germany': 'DE', 'DE': 'DE',
    '法国': 'FR', 'France': 'FR', 'FR': 'FR',
  };
  for (const [k, code] of Object.entries(keywords)) {
    if (name.includes(k)) return code;
  }
  return undefined;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Update all subscriptions and return merged results
 */
export async function updateAllSubscriptions(
  subscriptions: Subscription[]
): Promise<Map<string, { nodes: ProxyNode[]; error?: string }>> {
  const results = new Map();

  const enabledSubs = subscriptions.filter((s) => s.enabled);

  await Promise.allSettled(
    enabledSubs.map(async (sub) => {
      const result = await fetchSubscription(sub);
      results.set(sub.id, result);
    })
  );

  return results;
}

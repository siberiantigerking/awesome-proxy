import { expect } from 'vitest';
import type { ProxyNode } from '../../src/types';
import { generator } from './generator';

/** Every tag a route, group or detour can point at: outbounds plus endpoints. */
export function outboundTags(config: any): string[] {
  return [...(config.outbounds || []), ...(config.endpoints || [])].map((o: any) => o.tag);
}

/**
 * Tags of the nodes that are plain TCP and so must never carry a `transport`
 * block (`{ type: "tcp" }` is fatal to sing-box): Shadowsocks and ShadowTLS
 * always (a SIP003 plugin is `plugin`, not a transport), VMess/VLESS/Trojan
 * whose transport the generator normalises to `tcp` (no transport, `tcp`,
 * `raw` or `none`).
 */
export function plainTcpTags(nodes: ProxyNode[]): string[] {
  const tags: string[] = generator.buildOutboundTags(nodes);
  return nodes
    .map((node, i) => ({ node, tag: tags[i] }))
    .filter(({ node }) => {
      if (!node) return false;
      if (node.type === 'shadowsocks' || node.type === 'shadowtls') return true;
      if (node.type === 'vmess' || node.type === 'vless' || node.type === 'trojan') {
        return generator.normalizeTransportType(node.transportType) === 'tcp';
      }
      return false;
    })
    .map(({ tag }) => tag);
}

export interface InvariantOptions {
  /** True when the case supplied settings.clashApi. */
  expectClashApi: boolean;
  /** From plainTcpTags(case nodes). */
  plainTcpTags?: string[];
}

/**
 * Structural rules every generated config must satisfy. Each one is a way the
 * core refuses to start (or, for the Clash API, a way it would start exposed):
 *   - outbound/endpoint tags are unique ("duplicate outbound/endpoint tag");
 *   - every selector/urltest member, selector default, outbound detour, route
 *     rule outbound, route.final, DNS server detour and rule-set download
 *     detour names a tag that exists;
 *   - every `domain_resolver` (of a DNS server, an outbound or endpoint, and
 *     `route.default_domain_resolver`) names a DNS server that exists
 *     ("dependency[…] not found for server[…]", "domain resolver not found");
 *   - no `transport` of type tcp, and none at all on a plain-TCP node;
 *   - every `transport.type` is one the core has (SUPPORTED_TRANSPORTS;
 *     another is "unknown transport type");
 *   - `experimental.clash_api` with a non-empty secret exactly when the
 *     backend supplied credentials, and no controller otherwise.
 */
export function assertConfigInvariants(config: any, options: InvariantOptions): void {
  const tags = outboundTags(config);
  const duplicates = tags.filter((tag, i) => tags.indexOf(tag) !== i);
  expect(duplicates, 'duplicate outbound/endpoint tags').toEqual([]);

  const known = new Set(tags);
  const dangling: string[] = [];
  const mustExist = (where: string, tag: unknown) => {
    if (typeof tag !== 'string' || !known.has(tag)) dangling.push(`${where} -> ${String(tag)}`);
  };
  const all = [...(config.outbounds || []), ...(config.endpoints || [])];
  for (const o of all) {
    if (o.type === 'selector' || o.type === 'urltest') {
      for (const member of o.outbounds || []) mustExist(`${o.tag} member`, member);
      if ('default' in o) mustExist(`${o.tag} default`, o.default);
    }
    if ('detour' in o) mustExist(`${o.tag} detour`, o.detour);
  }
  (config.route?.rules || []).forEach((rule: any, i: number) => {
    if ('outbound' in rule) mustExist(`route.rules[${i}].outbound`, rule.outbound);
  });
  if (config.route && 'final' in config.route) mustExist('route.final', config.route.final);
  for (const server of config.dns?.servers || []) {
    if ('detour' in server) mustExist(`dns server ${server.tag} detour`, server.detour);
  }
  for (const rs of config.route?.rule_set || []) {
    if ('download_detour' in rs) mustExist(`rule_set ${rs.tag} download_detour`, rs.download_detour);
  }
  expect(dangling, 'references to tags that do not exist').toEqual([]);

  // A Remote DNS server given by name points at remote-dns-bootstrap, so a
  // bootstrap left out of dns.servers must fail here rather than at start.
  const dnsTags = new Set((config.dns?.servers || []).map((s: any) => s.tag));
  const unknownResolvers: string[] = [];
  const resolverMustExist = (where: string, resolver: any) => {
    // A string, or the object form `{ server, strategy? }`.
    const tag = typeof resolver === 'string' ? resolver : resolver?.server;
    if (typeof tag !== 'string' || !dnsTags.has(tag)) unknownResolvers.push(`${where} -> ${String(tag)}`);
  };
  for (const server of config.dns?.servers || []) {
    if ('domain_resolver' in server) resolverMustExist(`dns server ${server.tag} domain_resolver`, server.domain_resolver);
  }
  for (const o of all) {
    if ('domain_resolver' in o) resolverMustExist(`${o.tag} domain_resolver`, o.domain_resolver);
  }
  if (config.route && 'default_domain_resolver' in config.route) {
    resolverMustExist('route.default_domain_resolver', config.route.default_domain_resolver);
  }
  expect(unknownResolvers, 'domain resolvers that name no DNS server').toEqual([]);

  const tcpTransports = all.filter((o: any) => o.transport && o.transport.type === 'tcp').map((o: any) => o.tag);
  expect(tcpTransports, 'transport blocks of type tcp').toEqual([]);
  const unknownTransports = all
    .filter((o: any) => o.transport && !generator.SUPPORTED_TRANSPORTS.has(o.transport.type))
    .map((o: any) => `${o.tag}: ${String(o.transport.type)}`);
  expect(unknownTransports, 'transport types the core does not have').toEqual([]);
  const plain = new Set(options.plainTcpTags || []);
  const plainWithTransport = all.filter((o: any) => plain.has(o.tag) && o.transport).map((o: any) => o.tag);
  expect(plainWithTransport, 'plain-TCP nodes carrying a transport').toEqual([]);

  const clashApi = config.experimental?.clash_api;
  if (options.expectClashApi) {
    expect(clashApi, 'experimental.clash_api').toBeTruthy();
    expect(typeof clashApi.secret === 'string' && clashApi.secret.length > 0, 'clash_api secret').toBe(true);
  } else {
    expect(clashApi, 'experimental.clash_api without backend credentials').toBeUndefined();
  }
}

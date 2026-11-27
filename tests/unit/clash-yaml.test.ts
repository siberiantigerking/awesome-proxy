import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Utf8, buildProxyLink } from '../../src/services/node-link';
import { fetchSubscription, parseClashYaml } from '../../src/services/subscription-fetcher';
import type { Subscription } from '../../src/types';
import { LINK_FIXTURES } from '../fixtures/links';
import { installMockApi } from '../helpers/mock-api';

const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), 'utf-8');
const MIHOMO_BASIC = read('../fixtures/clash/mihomo-basic.yaml');
const MIHOMO_ROUND3 = read('../fixtures/clash/mihomo-round3.yaml');

const UUID = '2420e4a1-e97c-4780-a7a0-f47b2a402ba7';

describe('parseClashYaml: mihomo-basic.yaml', () => {
  const nodes = parseClashYaml(MIHOMO_BASIC);
  const byName = (name: string) => {
    const node = nodes.find((n) => n.name === name);
    if (!node) throw new Error(`no node named ${name}`);
    return node;
  };

  it('keeps every supported proxy, in order, and skips the unsupported type and the entry without a server', () => {
    expect(nodes.map((n) => [n.type, n.name])).toEqual([
      ['vmess', '日本 JP vmess ws'],
      ['vless', 'vless reality vision'],
      ['vless', 'vless grpc'],
      ['trojan', 'trojan'],
      ['shadowsocks', 'ss'],
      ['hysteria2', 'hysteria2'],
      ['tuic', 'tuic'],
      ['anytls', 'anytls'],
      ['shadowtls', 'shadowtls'],
      ['wireguard', 'wireguard'],
    ]);
    // Every node gets its own id.
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it('vmess: ws-opts path and Host header, alterId, cipher as security, tls and servername', () => {
    expect(byName('日本 JP vmess ws')).toMatchObject({
      server: 'vmess.example.com',
      port: 443,
      uuid: UUID,
      alterId: 0,
      security: 'auto',
      tls: true,
      sni: 'sni.example.com',
      transportType: 'ws',
      transportPath: '/vmess',
      transportHost: 'cdn.example.com',
      country: 'JP',
    });
  });

  it('vless: reality-opts, flow and client-fingerprint; grpc-opts service name', () => {
    expect(byName('vless reality vision')).toMatchObject({
      uuid: UUID,
      flow: 'xtls-rprx-vision',
      tls: true,
      sni: 'www.example.com',
      fingerprint: 'chrome',
      realityPublicKey: 'WtyFbF5JOHxY52iYnUbP15Zy4t_AdUGN0Nu5S5t9JEo',
      realityShortId: '0123abcd',
      transportType: 'tcp',
    });
    expect(byName('vless grpc')).toMatchObject({
      tls: true,
      sni: 'sni.example.com',
      transportType: 'grpc',
      transportPath: 'vless-grpc',
    });
  });

  it('trojan: sni and skip-cert-verify', () => {
    expect(byName('trojan')).toMatchObject({
      password: 'trojan-password',
      sni: 'sni.example.com',
      allowInsecure: true,
    });
  });

  it('ss: cipher becomes method', () => {
    expect(byName('ss')).toMatchObject({ server: 'ss.example.com', port: 8388, method: 'aes-256-gcm', password: 'ss-password' });
  });

  it('hysteria2: salamander obfs, port ranges, a numeric hop-interval, bandwidth', () => {
    expect(byName('hysteria2')).toMatchObject({
      password: 'hy2-password',
      sni: 'sni.example.com',
      obfsType: 'salamander',
      obfsPassword: 'obfs-password',
      serverPorts: ['19196:19197', '19198'],
      hopInterval: '30s',
      upMbps: 50,
      downMbps: 200,
    });
  });

  it('tuic: congestion-controller and udp-relay-mode, always TLS', () => {
    expect(byName('tuic')).toMatchObject({
      uuid: UUID,
      password: 'tuic-password',
      tls: true,
      congestionControl: 'bbr',
      udpRelayMode: 'native',
    });
  });

  it('anytls: always TLS', () => {
    expect(byName('anytls')).toMatchObject({ password: 'anytls-password', tls: true, sni: 'sni.example.com', allowInsecure: true });
  });

  it('shadowtls: version and shadowtls-password, inner Shadowsocks credentials', () => {
    expect(byName('shadowtls')).toMatchObject({
      tls: true,
      shadowTlsVersion: 3,
      shadowTlsPassword: 'shadowtls-password',
      method: 'aes-128-gcm',
      password: 'inner-ss-password',
      sni: 'www.example.com',
    });
  });

  it('wireguard: keys, ip/ipv6 as local addresses, mtu, reserved', () => {
    expect(byName('wireguard')).toMatchObject({
      server: 'wg.example.com',
      port: 51820,
      privateKey: 'iIGbFKdo9vdiXQQRQCtAdstbfI7edqrHIn8XgE0X0EI=',
      peerPublicKey: 'ZKw+L8OgzvCHV9VGZCBdPNqernMi0E+aRp2m177c1lQ=',
      preSharedKey: 'AMa/l+dkp3gwvM3rFsm8ZKzpBbfJJWGbdRA22wrSFjs=',
      localAddress: ['10.0.0.2/32', 'fd00::2/128'],
      mtu: 1408,
      reserved: [1, 2, 3],
    });
  });
});

describe('parseClashYaml: bad input', () => {
  it('invalid YAML gives no nodes', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseClashYaml('proxies: [unclosed')).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a document without proxies gives no nodes', () => {
    expect(parseClashYaml('port: 7890\nmode: rule\n')).toEqual([]);
    expect(parseClashYaml('proxies: not-a-list\n')).toEqual([]);
    expect(parseClashYaml('')).toEqual([]);
  });
});

describe('fetchSubscription', () => {
  const sub: Subscription = {
    id: 'sub-1',
    name: 'Test subscription',
    url: 'https://subscription.example.com/token',
    nodeCount: 0,
    autoUpdate: false,
    updateInterval: 24,
    enabled: true,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a base64 link list and stamps the subscription id', async () => {
    const links = LINK_FIXTURES.slice(0, 3).map((n) => buildProxyLink(n).link!);
    const { api } = installMockApi({}, { network: { fetchUrl: vi.fn(async () => base64Utf8(links.join('\n'))) } });
    const result = await fetchSubscription(sub);
    expect(api.network.fetchUrl).toHaveBeenCalledWith(sub.url, 15000);
    expect(result.error).toBeUndefined();
    expect(result.nodes.map((n) => n.name)).toEqual(LINK_FIXTURES.slice(0, 3).map((n) => n.name));
    expect(result.nodes.every((n) => n.subscriptionId === 'sub-1')).toBe(true);
  });

  it('falls back to Clash YAML when the body holds no links', async () => {
    installMockApi({}, { network: { fetchUrl: vi.fn(async () => MIHOMO_BASIC) } });
    const result = await fetchSubscription(sub);
    expect(result.error).toBeUndefined();
    expect(result.nodes).toHaveLength(10);
    expect(result.nodes.every((n) => n.subscriptionId === 'sub-1')).toBe(true);
  });

  it('reports an empty body', async () => {
    installMockApi({}, { network: { fetchUrl: vi.fn(async () => '') } });
    expect(await fetchSubscription(sub)).toEqual({ nodes: [], error: 'Empty response from subscription URL' });
  });

  it('reports a body with no nodes', async () => {
    installMockApi({}, { network: { fetchUrl: vi.fn(async () => 'hello: world\n') } });
    expect(await fetchSubscription(sub)).toEqual({ nodes: [], error: 'No valid proxy nodes found in subscription' });
  });

  it('reports a failed fetch', async () => {
    installMockApi({}, { network: { fetchUrl: vi.fn(async () => Promise.reject(new Error('HTTP 503'))) } });
    expect(await fetchSubscription(sub)).toEqual({ nodes: [], error: 'HTTP 503' });
  });
});

describe('mihomo fidelity (audit P1-8)', () => {
  const nodes = parseClashYaml(MIHOMO_ROUND3);
  const byName = (name: string) => {
    const node = nodes.find((n) => n.name === name);
    if (!node) throw new Error(`no node named ${name}`);
    return node;
  };

  it('mihomo `type: ss` + `plugin: shadow-tls` + plugin-opts imports as a ShadowTLS node, not plain Shadowsocks', () => {
    const node = byName('ss shadow-tls v3');
    expect(node).toMatchObject({
      type: 'shadowtls',
      server: 'stls.example.com',
      port: 443,
      // The proxy's own cipher and password are the inner Shadowsocks credentials.
      method: 'aes-128-gcm',
      password: 'inner-ss-password',
      tls: true,
      sni: 'www.example.com',
      shadowTlsPassword: 'shadowtls-password',
      shadowTlsVersion: 3,
    });
    expect(node.allowInsecure).toBeUndefined();
  });

  it("a shadow-tls plugin without a version gets mihomo's default, 2; skip-cert-verify comes from plugin-opts", () => {
    expect(byName('ss shadow-tls default version')).toMatchObject({
      type: 'shadowtls',
      port: 8443,
      method: 'chacha20-ietf-poly1305',
      password: 'inner-ss-password-2',
      tls: true,
      sni: 'cloud.example.com',
      shadowTlsPassword: 'shadowtls-password-2',
      shadowTlsVersion: 2,
      allowInsecure: true,
    });
  });

  it('`ws-opts.v2ray-http-upgrade: true` maps to the httpupgrade transport', () => {
    expect(byName('vmess httpupgrade')).toMatchObject({
      type: 'vmess',
      tls: true,
      sni: 'sni.example.com',
      transportType: 'httpupgrade',
      transportPath: '/upgrade',
      transportHost: 'cdn.example.com',
    });
  });

  it('`h2-opts` (host, path) maps to the http (h2) transport', () => {
    expect(byName('vless h2')).toMatchObject({
      type: 'vless',
      tls: true,
      transportType: 'http',
      // A node holds one host: the first of mihomo's list.
      transportHost: 'h2.example.com',
      transportPath: '/h2',
    });
  });

  it('a transport sing-box lacks (xhttp) keeps its name, so the generator can skip the node with a reason', () => {
    expect(byName('vless xhttp')).toMatchObject({ type: 'vless', transportType: 'xhttp' });
  });
});

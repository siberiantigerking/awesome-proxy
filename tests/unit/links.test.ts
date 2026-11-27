import { describe, expect, it } from 'vitest';
import type { ProxyNode } from '../../src/types';
import { base64Utf8, buildProxyLink } from '../../src/services/node-link';
import { parseProxyLink, parseProxyLinks } from '../../src/services/node-parser';
import { ENCODED_SECRET_FIXTURES, FIDELITY_FIXTURES, LINK_FIXTURES, NO_LINK_NODES } from '../fixtures/links';

/** The fixture as the parser should hand it back: everything but the fresh id and the derived country. */
function expected(node: ProxyNode): Partial<ProxyNode> {
  const { id: _id, country: _country, ...rest } = node;
  return rest;
}

function roundTrip(node: ProxyNode): ProxyNode | null {
  const built = buildProxyLink(node);
  expect(built.error, `buildProxyLink(${node.name}) error`).toBeUndefined();
  return parseProxyLink(built.link!);
}

describe('share-link round trips (build, then parse)', () => {
  for (const node of LINK_FIXTURES) {
    it(`${node.type}: ${node.name}`, () => {
      expect(roundTrip(node)).toMatchObject(expected(node));
    });
  }

  for (const node of ENCODED_SECRET_FIXTURES) {
    it(`percent-encoded secret survives: ${node.name}`, () => {
      expect(roundTrip(node)).toMatchObject(expected(node));
    });
  }

  it('vmess: an IPv6 server survives (it travels inside the JSON payload)', () => {
    const node: ProxyNode = { ...LINK_FIXTURES[0], server: '2001:db8::1' };
    expect(roundTrip(node)).toMatchObject(expected(node));
  });
});

describe('protocols without a link format', () => {
  for (const node of NO_LINK_NODES) {
    it(`${node.type} explains instead of emitting a link`, () => {
      const result = buildProxyLink(node);
      expect(result.link).toBeUndefined();
      expect(result.error).toMatch(/has no share-link format/);
    });
  }
});

describe('parseProxyLinks', () => {
  it('decodes a base64 multi-link subscription body', () => {
    const links = LINK_FIXTURES.map((n) => buildProxyLink(n).link!);
    const body = base64Utf8(links.join('\n'));
    const nodes = parseProxyLinks(body);
    expect(nodes.map((n) => n.name)).toEqual(LINK_FIXTURES.map((n) => n.name));
    nodes.forEach((n, i) => expect(n).toMatchObject(expected(LINK_FIXTURES[i])));
  });

  it('accepts the hy2:// alias', () => {
    const hy2 = LINK_FIXTURES.find((n) => n.type === 'hysteria2')!;
    const link = buildProxyLink(hy2).link!.replace(/^hysteria2:\/\//, 'hy2://');
    expect(link.startsWith('hy2://')).toBe(true);
    expect(parseProxyLinks(link)).toEqual([expect.objectContaining(expected(hy2))]);
    expect(parseProxyLink(link)).toMatchObject(expected(hy2));
  });

  it('skips lines that are not links', () => {
    const vless = buildProxyLink(LINK_FIXTURES.find((n) => n.type === 'vless')!).link!;
    expect(parseProxyLinks(`# comment\n\n${vless}\nhttp://example.com\n`).map((n) => n.type)).toEqual(['vless']);
  });
});

describe('share-link fidelity (audit P1-8)', () => {
  const fidelity = (id: string): ProxyNode => {
    const node = FIDELITY_FIXTURES.find((n) => n.id === id);
    if (!node) throw new Error(`no fidelity fixture ${id}`);
    return node;
  };
  const query = (link: string) => new URLSearchParams(link.slice(link.indexOf('?') + 1).split('#')[0]);
  /** Base64url without padding, the userinfo form SIP002 recommends (our builder writes plain base64). */
  const b64url = (text: string) => base64Utf8(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const UUID = fidelity('f-vless-ws-insecure').uuid!;
  // A third-party SIP002 link: base64url userinfo, IPv6 host, obfs-local plugin with options.
  const SIP002_IPV6_OBFS = `ss://${b64url('aes-256-gcm:ss-password')}@[2001:db8::1]:8388/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dexample.com#x`;

  for (const node of FIDELITY_FIXTURES) {
    it(`round trip: ${node.type}: ${node.name}`, () => {
      expect(roundTrip(node)).toMatchObject(expected(node));
    });
  }

  it('Trojan ws host is read into transportHost (and still feeds the SNI when no sni is given)', () => {
    const link = buildProxyLink(fidelity('f-trojan-ws-host')).link!;
    expect(query(link).get('host')).toBe('cdn.example.com');
    expect(parseProxyLink(link)).toMatchObject({ sni: 'sni.example.com', transportType: 'ws', transportHost: 'cdn.example.com' });

    const noSni = parseProxyLink('trojan://pw@trojan.example.com:443?type=ws&path=%2Fws&host=cdn.example.com#t');
    expect(noSni).toMatchObject({ sni: 'cdn.example.com', transportType: 'ws', transportPath: '/ws', transportHost: 'cdn.example.com' });
    // Without a host it stays out of the node, so a refresh doesn't see a change.
    expect(parseProxyLink('trojan://pw@trojan.example.com:443?security=tls#t')?.transportHost).toBeUndefined();
  });

  it('Trojan grpc `serviceName` is read into transportPath', () => {
    const link = buildProxyLink(fidelity('f-trojan-grpc')).link!;
    expect(query(link).get('serviceName')).toBe('trojan-grpc');
    expect(parseProxyLink(link)).toMatchObject({ transportType: 'grpc', transportPath: 'trojan-grpc' });
    expect(parseProxyLink('trojan://pw@trojan.example.com:443?type=grpc&serviceName=svc#t')).toMatchObject({
      transportType: 'grpc',
      transportPath: 'svc',
    });
  });

  it('VLESS allowInsecure is emitted and parsed', () => {
    const node = fidelity('f-vless-ws-insecure');
    const link = buildProxyLink(node).link!;
    expect(query(link).get('allowInsecure')).toBe('1');
    expect(parseProxyLink(link)?.allowInsecure).toBe(true);
    expect(parseProxyLink(`vless://${UUID}@vless.example.com:443?security=tls&insecure=1#v`)?.allowInsecure).toBe(true);
    // Unset: no parameter, and nothing parsed (left out rather than false).
    const { allowInsecure: _allowInsecure, ...secure } = node;
    expect(query(buildProxyLink(secure).link!).has('allowInsecure')).toBe(false);
    expect(parseProxyLink(`vless://${UUID}@vless.example.com:443?security=tls#v`)?.allowInsecure).toBeUndefined();
  });

  it('SIP002 ss:// with an IPv6 host ([2001:db8::1]:8388) parses host and port', () => {
    expect(parseProxyLink(SIP002_IPV6_OBFS)).toMatchObject({
      type: 'shadowsocks',
      name: 'x',
      server: '2001:db8::1',
      port: 8388,
      method: 'aes-256-gcm',
      password: 'ss-password',
    });
    expect(buildProxyLink(fidelity('f-ss-ipv6')).link).toContain('@[2001:db8::1]:8388#');
    // The legacy all-base64 form too.
    const legacy = `ss://${base64Utf8('aes-256-gcm:ss-password@[2001:db8::1]:8388')}#legacy`;
    expect(parseProxyLink(legacy)).toMatchObject({ server: '2001:db8::1', port: 8388, method: 'aes-256-gcm', password: 'ss-password' });
  });

  it('SIP002 ss:// ?plugin= (obfs-local, v2ray-plugin) is kept and re-emitted', () => {
    const parsed = parseProxyLink(SIP002_IPV6_OBFS)!;
    expect(parsed).toMatchObject({ plugin: 'obfs-local', pluginOpts: 'obfs=http;obfs-host=example.com' });
    // Re-emitted as SIP002 writes it: one `plugin` parameter after a '/', `;` and `=` percent-encoded.
    expect(buildProxyLink(parsed).link).toBe(
      `ss://${base64Utf8('aes-256-gcm:ss-password')}@[2001:db8::1]:8388/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dexample.com#x`
    );
    for (const node of [fidelity('f-ss-obfs-local'), fidelity('f-ss-v2ray-plugin')]) {
      expect(roundTrip(node)).toMatchObject({ plugin: node.plugin, pluginOpts: node.pluginOpts });
    }
    const userinfo = b64url('aes-256-gcm:ss-password');
    const noOptions = parseProxyLink(`ss://${userinfo}@ss.example.com:8388/?plugin=v2ray-plugin#n`)!;
    expect(noOptions.plugin).toBe('v2ray-plugin');
    expect(noOptions.pluginOpts).toBeUndefined();
    // A plugin sing-box doesn't have imports without one, as before.
    const kcptun = parseProxyLink(`ss://${userinfo}@ss.example.com:8388/?plugin=kcptun%3Bkey%3Dk#k`)!;
    expect(kcptun).toMatchObject({ type: 'shadowsocks', server: 'ss.example.com', port: 8388, password: 'ss-password' });
    expect(kcptun.plugin).toBeUndefined();
    expect(kcptun.pluginOpts).toBeUndefined();
  });

  it('`type=httpupgrade` maps to an httpupgrade transport', () => {
    for (const id of ['f-vless-httpupgrade', 'f-trojan-httpupgrade', 'f-vmess-httpupgrade']) {
      const node = fidelity(id);
      expect(roundTrip(node), id).toMatchObject({
        transportType: 'httpupgrade',
        transportPath: '/upgrade',
        transportHost: 'cdn.example.com',
      });
    }
    const vless = buildProxyLink(fidelity('f-vless-httpupgrade')).link!;
    expect([...query(vless)].filter(([key]) => ['type', 'path', 'host'].includes(key))).toEqual([
      ['type', 'httpupgrade'],
      ['path', '/upgrade'],
      ['host', 'cdn.example.com'],
    ]);
    expect(parseProxyLink(`vless://${UUID}@vless.example.com:443?security=tls&type=httpupgrade&path=%2Fup&host=cdn.example.com#u`)).toMatchObject({
      transportType: 'httpupgrade',
      transportPath: '/up',
      transportHost: 'cdn.example.com',
    });
  });

  it('`type=h2` maps to the http (h2) transport', () => {
    expect(parseProxyLink(`vless://${UUID}@vless.example.com:443?security=tls&type=h2&path=%2Fh2&host=h2.example.com#h`)).toMatchObject({
      transportType: 'http',
      transportPath: '/h2',
      transportHost: 'h2.example.com',
    });
    expect(parseProxyLink('trojan://pw@trojan.example.com:443?sni=sni.example.com&type=h2&path=%2Fh2&host=h2.example.com#h')).toMatchObject({
      transportType: 'http',
      transportPath: '/h2',
      transportHost: 'h2.example.com',
    });
    // Our own links write `type=http`, the share-link standard's name, and read back the same.
    const link = buildProxyLink(fidelity('f-vless-h2')).link!;
    expect(query(link).get('type')).toBe('http');
    expect(parseProxyLink(link)).toMatchObject({ transportType: 'http', transportPath: '/h2', transportHost: 'h2.example.com' });
  });

  it('other transport names: raw is tcp, case is ignored, one sing-box lacks (xhttp, kcp) is kept by name', () => {
    expect(parseProxyLink(`vless://${UUID}@vless.example.com:443?type=raw#r`)?.transportType).toBe('tcp');
    expect(parseProxyLink(`vless://${UUID}@vless.example.com:443?type=xhttp&path=%2Fx#x`)?.transportType).toBe('xhttp');
    expect(parseProxyLink('trojan://pw@trojan.example.com:443?type=WS#w')?.transportType).toBe('ws');
    // vmess `net` goes through the same rules instead of turning every unknown into tcp.
    const vmess = (net?: string) =>
      parseProxyLink(`vmess://${base64Utf8(JSON.stringify({ v: '2', ps: 'm', add: 'vmess.example.com', port: '443', id: UUID, net }))}`)
        ?.transportType;
    expect([vmess('kcp'), vmess('httpupgrade'), vmess('h2'), vmess('ws'), vmess(undefined)]).toEqual([
      'kcp',
      'httpupgrade',
      'http',
      'ws',
      'tcp',
    ]);
  });

  it('vmess fp round-trips into fingerprint', () => {
    expect(roundTrip(fidelity('f-vmess-ws-tls-fp'))?.fingerprint).toBe('chrome');
    // A vmess link without one (`fp: ""`) leaves it out rather than storing ''.
    expect(roundTrip(LINK_FIXTURES[0])?.fingerprint).toBeUndefined();
  });

  it('hysteria2 hopInterval round-trips (emitted as hop_interval)', () => {
    const link = buildProxyLink(fidelity('f-hysteria2-hop-interval')).link!;
    expect(query(link).get('hop_interval')).toBe('30s');
    expect(parseProxyLink(link)).toMatchObject({ serverPorts: ['20000:30000'], hopInterval: '30s' });
  });

  it('an IPv6 server in vless/trojan/hysteria2/tuic/anytls links parses back without its brackets', () => {
    const nodes = FIDELITY_FIXTURES.filter((n) => n.server === '2001:db8::1' && n.type !== 'shadowsocks');
    expect(nodes.map((n) => n.type)).toEqual(['vless', 'trojan', 'hysteria2', 'tuic', 'anytls']);
    for (const node of nodes) {
      const link = buildProxyLink(node).link!;
      expect(link, node.type).toContain('@[2001:db8::1]:8443?');
      expect(parseProxyLink(link), node.type).toMatchObject({ server: '2001:db8::1', port: 8443 });
    }
    // A link without a name is still named after its address, brackets included.
    expect(parseProxyLink('trojan://pw@[2001:db8::1]:8443?security=tls')?.name).toBe('[2001:db8::1]:8443');
  });
});

import { describe, expect, it } from 'vitest';
import type { ProxyNode } from '../../src/types';
import { buildProxyLink, buildShareBundle, buildWireguardConfig } from '../../src/services/node-link';
import { parseProxyLinks } from '../../src/services/node-parser';
import { LINK_FIXTURES, NO_LINK_NODES } from '../fixtures/links';
import { nodeFixtures } from '../fixtures/nodes';

/** The fixture as the parser should hand it back: everything but the fresh id and the derived country. */
function expected(node: ProxyNode): Partial<ProxyNode> {
  const { id: _id, country: _country, ...rest } = node;
  return rest;
}

describe('buildShareBundle (Share (N) on the Nodes page)', () => {
  // The nodes without a link are spread through the list, so both lists' order is tested.
  const input = [
    NO_LINK_NODES[0],
    ...LINK_FIXTURES.slice(0, 6),
    NO_LINK_NODES[1],
    ...LINK_FIXTURES.slice(6),
    NO_LINK_NODES[2],
  ];
  const bundle = buildShareBundle(input);

  it('shares every node that has a link, in list order, one link per line', () => {
    expect(bundle.shared).toEqual(LINK_FIXTURES);
    expect(bundle.links).toEqual(LINK_FIXTURES.map((n) => buildProxyLink(n).link));
    expect(bundle.text).toBe(bundle.links.join('\n'));
  });

  it('the base64 subscription body imports back through our own parser', () => {
    const nodes = parseProxyLinks(bundle.base64);
    expect(nodes.map((n) => n.name)).toEqual(LINK_FIXTURES.map((n) => n.name));
    nodes.forEach((n, i) => expect(n).toMatchObject(expected(LINK_FIXTURES[i])));
  });

  it('lists the nodes without a link, with the reason buildProxyLink gives', () => {
    expect(bundle.skipped).toEqual(
      NO_LINK_NODES.map((n) => ({ name: n.name, reason: buildProxyLink(n).error }))
    );
    expect(bundle.skipped[0].reason).toMatch(/Copy as WireGuard config/);
  });

  it('with nothing shareable, there is nothing to copy', () => {
    expect(buildShareBundle(NO_LINK_NODES)).toMatchObject({ links: [], shared: [], text: '', base64: '' });
  });
});

describe('buildWireguardConfig', () => {
  const [wireguard] = nodeFixtures(['wireguard']);

  it('writes the standard config for a node shaped like the wireguard fixture', () => {
    const result = buildWireguardConfig(wireguard);
    expect(result.error).toBeUndefined();
    expect(result.config).toBe(
      [
        '[Interface]',
        'PrivateKey = iIGbFKdo9vdiXQQRQCtAdstbfI7edqrHIn8XgE0X0EI=',
        'Address = 10.0.0.2/32, fd00::2/128',
        'MTU = 1408',
        '',
        '[Peer]',
        'PublicKey = ZKw+L8OgzvCHV9VGZCBdPNqernMi0E+aRp2m177c1lQ=',
        'PresharedKey = AMa/l+dkp3gwvM3rFsm8ZKzpBbfJJWGbdRA22wrSFjs=',
        'Endpoint = 127.0.0.1:19194',
        'AllowedIPs = 0.0.0.0/0, ::/0',
        'PersistentKeepalive = 25',
        '',
      ].join('\n')
    );
  });

  it('warns when reserved is set, because the standard format cannot carry it', () => {
    expect(wireguard.reserved).toEqual([1, 2, 3]);
    expect(buildWireguardConfig(wireguard).warning).toMatch(/reserved/);
    const { reserved: _reserved, ...withoutReserved } = wireguard;
    expect(buildWireguardConfig(withoutReserved).warning).toBeUndefined();
  });

  it("omits MTU, PresharedKey and PersistentKeepalive when unset, and uses the generator's fallback address", () => {
    const minimal: ProxyNode = {
      id: 'wg-minimal',
      name: 'wg minimal',
      type: 'wireguard',
      server: 'wg.example.com',
      port: 51820,
      privateKey: wireguard.privateKey,
      peerPublicKey: wireguard.peerPublicKey,
    };
    expect(buildWireguardConfig(minimal)).toEqual({
      config: [
        '[Interface]',
        `PrivateKey = ${wireguard.privateKey}`,
        'Address = 10.0.0.2/32',
        '',
        '[Peer]',
        `PublicKey = ${wireguard.peerPublicKey}`,
        'Endpoint = wg.example.com:51820',
        'AllowedIPs = 0.0.0.0/0, ::/0',
        '',
      ].join('\n'),
    });
  });

  it('brackets an IPv6 endpoint', () => {
    const result = buildWireguardConfig({ ...wireguard, server: '2001:db8::1', port: 51820 });
    expect(result.config).toContain('\nEndpoint = [2001:db8::1]:51820\n');
  });

  it('refuses without the private key or the peer public key, naming the key and no value', () => {
    const noPrivateKey = buildWireguardConfig({ ...wireguard, privateKey: undefined });
    expect(noPrivateKey.config).toBeUndefined();
    expect(noPrivateKey.error).toMatch(/no private key/);
    expect(noPrivateKey.error).not.toContain(wireguard.peerPublicKey!);

    const noPeerKey = buildWireguardConfig({ ...wireguard, peerPublicKey: '' });
    expect(noPeerKey.config).toBeUndefined();
    expect(noPeerKey.error).toMatch(/no peer public key/);
    expect(noPeerKey.error).not.toContain(wireguard.privateKey!);
  });
});

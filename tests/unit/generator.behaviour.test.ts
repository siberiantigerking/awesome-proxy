import { describe, expect, it } from 'vitest';
import type { ProxyNode } from '../../src/types';
import {
  allCases,
  BACKEND_FIELDS,
  indexOfNode,
  makeCase,
  MATRIX_CASES,
  NAMED_CASES,
  TRANSPORT_CASES,
} from '../fixtures/matrix';
import { nodeFixtures } from '../fixtures/nodes';
import { generate, generator } from '../helpers/generator';
import { outboundTags } from '../helpers/invariants';

/**
 * Targeted assertions on what the generator does today. The snapshots record
 * every byte; these name the rules behind them, so a snapshot diff that breaks
 * one of them fails with a reason instead of just a diff.
 */

const named = (id: string) => {
  const c = NAMED_CASES.find((n) => n.id === id);
  if (!c) throw new Error(`no named case ${id}`);
  return c;
};
const outbound = (config: any, tag: string) => config.outbounds.find((o: any) => o.tag === tag);
const groupMembers = (config: any): string[] =>
  config.outbounds
    .filter((o: any) => o.type === 'selector' || o.type === 'urltest')
    .flatMap((o: any) => o.outbounds);
const isTunMode = (mode: unknown) => mode === 'tun' || mode === 'split';
const CHINA_SUFFIXES = ['.cn', '.baidu.com', '.qq.com', '.taobao.com', '.jd.com', '.alipay.com'];
const ss = (name: string, port = 19199): ProxyNode => ({
  id: name,
  name,
  type: 'shadowsocks',
  server: '127.0.0.1',
  port,
  method: 'aes-128-gcm',
  password: 'x',
});

describe('nodes and groups', () => {
  it('rejected nodes never appear in outbounds, endpoints or groups', () => {
    for (const c of [...MATRIX_CASES, named('named-defaults-system')]) {
      const config = generate(c);
      for (const tag of ['invalid-ss2022-key', 'invalid-vmess-no-uuid']) {
        expect(outboundTags(config), `${c.id}: ${tag}`).not.toContain(tag);
        expect(groupMembers(config), `${c.id}: ${tag}`).not.toContain(tag);
      }
    }
  });

  it('the proxy selector and auto urltest list exactly the usable nodes, in order', () => {
    const config = generate(named('named-defaults-system'));
    const usable = [
      'vmess-ws-tls',
      'vmess-grpc-utls',
      'vmess-tcp',
      'vless-reality-vision',
      'trojan-tls',
      'ss-aes-256-gcm',
      'ss-2022-blake3-aes-128-gcm',
      'hy2-salamander-hop',
      'hy2-gecko',
      'tuic-v5',
      'anytls',
      'shadowtls-v3',
      'wireguard',
      'dup',
      'dup-1',
    ];
    expect(outbound(config, 'proxy')).toEqual({
      type: 'selector',
      tag: 'proxy',
      outbounds: ['auto', 'direct', ...usable],
      default: 'vmess-ws-tls',
      interrupt_exist_connections: true,
    });
    expect(outbound(config, 'auto').outbounds).toEqual(usable);
  });

  it('a switch moves open connections: every selector interrupts them, the auto urltest never does', () => {
    // The user's decision: picking another node (or Split target) closes the
    // connections open at that moment so they continue through the new one.
    // `auto` must not, or each periodic re-pick would drop every connection.
    const seen = { proxy: 0, split: 0, auto: 0 };
    for (const c of allCases()) {
      for (const o of generate(c).outbounds) {
        if (o.type === 'selector') {
          expect(o.interrupt_exist_connections, `${c.id}: ${o.tag}`).toBe(true);
          if (o.tag === 'proxy') seen.proxy++;
          else seen.split++;
        }
        if (o.type === 'urltest') {
          expect(o, `${c.id}: ${o.tag}`).not.toHaveProperty('interrupt_exist_connections');
          seen.auto++;
        }
      }
    }
    // Not vacuous: the cases include both kinds of selector and the urltest.
    expect(seen.proxy).toBeGreaterThan(0);
    expect(seen.split).toBeGreaterThan(0);
    expect(seen.auto).toBe(seen.proxy);
  });

  it('rejected nodes still take their tag position, so later tags match the renderer', () => {
    // Tags are built from the FULL list, so the valid second "X" stays "X-1"
    // even though the first one (no uuid) is left out.
    const nodes: ProxyNode[] = [
      { id: 'a', name: 'X', type: 'vmess', server: '127.0.0.1', port: 19193 },
      ss('X'),
    ];
    const config = generate(makeCase('t', { nodes }));
    expect(generator.buildOutboundTags(nodes)).toEqual(['X', 'X-1']);
    expect(outboundTags(config)).toEqual(['proxy', 'auto', 'X-1', 'direct']);
    // The selected node was the rejected one: fall back to the first usable.
    expect(outbound(config, 'proxy').default).toBe('X-1');
    expect(generate(named('named-selected-invalid')).outbounds[0].default).toBe('vmess-ws-tls');
  });

  it('OpenVPN is emitted only while it is the selected node', () => {
    for (const c of MATRIX_CASES) {
      const config = generate(c);
      expect(config.endpoints.map((e: any) => [e.type, e.tag]), c.id).toEqual([
        ['wireguard', 'wireguard'],
        ['openvpn-client', 'ovpn-tls-auth'],
      ]);
      expect(outbound(config, 'proxy').default, c.id).toBe('ovpn-tls-auth');
    }
    const config = generate(named('named-defaults-system'));
    expect(config.endpoints.map((e: any) => e.tag)).toEqual(['wireguard']);
    expect(groupMembers(config)).not.toContain('ovpn-tls-auth');
  });

  it('an old or unknown core gets the pre-1.14 surface', () => {
    const old = generate(named('named-oldest-core'));
    expect(outboundTags(old)).not.toContain('ovpn-tls-auth');
    expect(outboundTags(old)).not.toContain('hy2-gecko');
    expect(outbound(old, 'hy2-salamander-hop')).not.toHaveProperty('disable_chrome_parrot');
    // The selected OpenVPN node was skipped: the first usable node takes over.
    expect(outbound(old, 'proxy').default).toBe('vmess-ws-tls');

    const unknown = generate(makeCase('t', { settings: { coreVersion: undefined } }));
    expect(outboundTags(unknown)).not.toContain('hy2-gecko');

    const current = generate(makeCase('t', { selectedIndex: indexOfNode('ovpn-tls-auth'), settings: { proxyMode: 'tun' } }));
    expect(outbound(current, 'hy2-gecko').obfs).toEqual({ type: 'gecko', password: 'gecko-password' });
    expect(outbound(current, 'hy2-salamander-hop').disable_chrome_parrot).toBe(true);
    expect(current.endpoints.map((e: any) => e.tag)).toContain('ovpn-tls-auth');
  });

  it('with no nodes there is only direct, and remote DNS has no detour', () => {
    const config = generate(named('named-no-nodes'));
    expect(config.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(config).not.toHaveProperty('endpoints');
    expect(config.route.final).toBe('direct');
    expect(config.dns.servers.find((s: any) => s.tag === 'remote-dns')).not.toHaveProperty('detour');

    const withNodes = generate(named('named-defaults-system'));
    expect(withNodes.dns.servers.find((s: any) => s.tag === 'remote-dns').detour).toBe('proxy');
  });

  it('with only unusable nodes Split falls back to direct with no selectors or rule-sets', () => {
    const config = generate(named('named-split-no-usable-nodes'));
    expect(config.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(config.route.final).toBe('direct');
    expect(config.route.rule_set).toEqual([]);
    expect(config.route.rules.filter((r: any) => r.rule_set || r.process_name)).toEqual([]);
  });
});

describe('inbounds', () => {
  it('allowLan binds every listener to 0.0.0.0, otherwise 127.0.0.1', () => {
    for (const c of MATRIX_CASES) {
      const listeners = generate(c).inbounds.filter((i: any) => i.type !== 'tun');
      expect(listeners.length, c.id).toBeGreaterThan(0);
      for (const inbound of listeners) {
        expect(inbound.listen, `${c.id} ${inbound.tag}`).toBe(c.settings.allowLan ? '0.0.0.0' : '127.0.0.1');
      }
    }
  });

  it('SOCKS/HTTP inbounds exist only with separatePorts', () => {
    for (const c of MATRIX_CASES) {
      const ports = generate(c)
        .inbounds.filter((i: any) => i.type !== 'tun')
        .map((i: any) => [i.tag, i.listen_port]);
      expect(ports, c.id).toEqual(
        c.settings.separatePorts
          ? [
              ['mixed-in', 7890],
              ['socks-in', 1080],
              ['http-in', 8080],
            ]
          : [['mixed-in', 7890]]
      );
    }
  });

  it('a SOCKS/HTTP port that duplicates another inbound, or is invalid, is skipped', () => {
    const ports = (c: any) => generate(c).inbounds.map((i: any) => [i.tag, i.listen_port]);
    expect(ports(named('named-port-collision'))).toEqual([
      ['mixed-in', 7890],
      ['http-in', 8080],
    ]);
    expect(ports(makeCase('t', { settings: { separatePorts: true, socksPort: 1080, httpPort: 1080 } }))).toEqual([
      ['mixed-in', 7890],
      ['socks-in', 1080],
    ]);
    expect(ports(makeCase('t', { settings: { separatePorts: true, socksPort: 0, httpPort: 70000 } }))).toEqual([
      ['mixed-in', 7890],
    ]);
  });

  it('the TUN inbound exists only in TUN/Split and follows the IPv6, bypass and stack settings', () => {
    for (const c of MATRIX_CASES) {
      const s = c.settings;
      const tun = generate(c).inbounds.find((i: any) => i.type === 'tun');
      if (!isTunMode(s.proxyMode)) {
        expect(tun, c.id).toBeUndefined();
        continue;
      }
      expect(tun.address, c.id).toEqual(
        s.ipv6Strategy === 'ipv4-only' ? [generator.TUN_IPV4] : [generator.TUN_IPV4, generator.TUN_IPV6]
      );
      if (s.tunBypassLocalNetworks) {
        expect(tun.route_exclude_address, c.id).toEqual(generator.LOCAL_NETWORK_RANGES);
      } else {
        expect(tun, c.id).not.toHaveProperty('route_exclude_address');
      }
      expect(tun.stack, c.id).toBe(s.tunStack);
      expect(tun.auto_route, c.id).toBe(true);
      expect(tun.strict_route, c.id).toBe(true);
    }
  });

  it('no TUN inbound sets endpoint_independent_nat, on any stack', () => {
    // Compat R3: upstream documents it as having had no effect since 1.11.
    const stacks = new Set<string>();
    for (const c of allCases()) {
      for (const tun of generate(c).inbounds.filter((i: any) => i.type === 'tun')) {
        expect(tun, c.id).not.toHaveProperty('endpoint_independent_nat');
        stacks.add(tun.stack);
      }
    }
    expect([...stacks].sort()).toEqual(['gvisor', 'mixed', 'system']);
  });
});

describe('routing and DNS', () => {
  it('the IPv6 downgrade and reject rules appear only for block in TUN/Split', () => {
    for (const c of MATRIX_CASES) {
      const rules = generate(c).route.rules.filter((r: any) => r.ip_version === 6);
      const expected = c.settings.ipv6Strategy === 'block' && isTunMode(c.settings.proxyMode);
      expect(rules, c.id).toEqual(
        expected
          ? [
              { ip_version: 6, action: 'resolve', strategy: 'ipv4_only' },
              { ip_version: 6, action: 'reject' },
            ]
          : []
      );
    }
  });

  it('dns.strategy is prefer_ipv4 only for prefer-ipv4', () => {
    for (const c of MATRIX_CASES) {
      expect(generate(c).dns.strategy, c.id).toBe(c.settings.ipv6Strategy === 'prefer-ipv4' ? 'prefer_ipv4' : 'ipv4_only');
    }
  });

  it('bypassChina adds the six-suffix direct route; the direct-dns rule is always there', () => {
    for (const c of MATRIX_CASES) {
      const config = generate(c);
      const chinaRoute = config.route.rules.filter(
        (r: any) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('.cn')
      );
      expect(chinaRoute, c.id).toEqual(c.settings.bypassChina ? [{ domain_suffix: CHINA_SUFFIXES, outbound: 'direct' }] : []);
      expect(config.dns.rules, c.id).toEqual([{ domain_suffix: CHINA_SUFFIXES, server: 'direct-dns' }]);
    }
  });
});

describe('Split mode', () => {
  const splitCases = MATRIX_CASES.filter((c) => c.settings.proxyMode === 'split');

  it('one selector per enabled rule with rule-sets, defaulting to the rule outbound when it is a member', () => {
    expect(splitCases.length).toBe(3);
    for (const c of splitCases) {
      const config = generate(c);
      const selectors = config.outbounds.filter((o: any) => o.type === 'selector' && o.tag !== 'proxy');
      // BiliBili is disabled, so it gets nothing. Selectors are tagged by rule
      // id in the internal namespace, never by the display name (audit P0-4).
      expect(selectors.map((s: any) => [s.tag, s.default]), c.id).toEqual([
        ['split:openai', 'proxy'],
        ['split:google', 'vless-reality-vision'],
      ]);
      const usable = outbound(config, 'auto').outbounds;
      for (const s of selectors) expect(s.outbounds, c.id).toEqual(['proxy', 'auto', 'direct', ...usable]);
      expect(config.route.rules.filter((r: any) => r.rule_set), c.id).toEqual([
        { rule_set: ['geosite-openai'], outbound: 'split:openai' },
        { rule_set: ['geosite-youtube', 'geoip-google'], outbound: 'split:google' },
      ]);
    }
  });

  it('a rule pointing at something that is not a member falls back to proxy', () => {
    const rule = (outboundTag: string) => ({ id: 'x', name: 'X rule', outbound: outboundTag, ruleSets: ['geosite-github'], enabled: true });
    for (const target of ['no-such-node', 'invalid-vmess-no-uuid', 'ovpn-tls-auth']) {
      const config = generate(makeCase('t', { settings: { proxyMode: 'split', splitRules: [rule(target)] } }));
      expect(outbound(config, 'split:x').default, target).toBe('proxy');
    }
  });

  it('rule-sets download over direct from the mapped URLs', () => {
    const config = generate(splitCases[0]);
    expect(config.route.rule_set.map((rs: any) => rs.tag)).toEqual(['geosite-openai', 'geosite-youtube', 'geoip-google']);
    for (const rs of config.route.rule_set) {
      expect(rs).toEqual({
        type: 'remote',
        tag: rs.tag,
        format: 'binary',
        url: expect.stringMatching(/^https:\/\/testingcf\.jsdelivr\.net\/gh\/.+\.srs$/),
        download_detour: 'direct',
      });
    }
  });

  it('rule-sets and Split selectors exist only in Split mode', () => {
    for (const proxyMode of ['system', 'tun', 'manual']) {
      const config = generate(makeCase('t', { settings: { proxyMode, splitRules: splitCases[0].settings.splitRules } }));
      expect(config.route.rule_set, proxyMode).toEqual([]);
      expect(config.outbounds.filter((o: any) => o.type === 'selector').map((o: any) => o.tag), proxyMode).toEqual(['proxy']);
    }
  });

  it('the legacy per-app rule follows splitMode', () => {
    for (const c of splitCases) {
      expect(generate(c).route.rules.filter((r: any) => r.process_name), c.id).toEqual([
        { process_name: ['chrome.exe'], outbound: 'proxy' },
      ]);
    }
    expect(generate(named('named-split-direct-apps')).route.rules.filter((r: any) => r.process_name)).toEqual([
      { process_name: ['chrome.exe', 'Telegram.exe'], outbound: 'direct' },
    ]);
  });

  it('route.final per mode', () => {
    const final = (c: any) => generate(c).route.final;
    for (const c of splitCases) expect(final(c), c.id).toBe('proxy');
    // App rules only: the listed apps take splitMode, everything else the opposite.
    expect(final(named('named-split-direct-apps'))).toBe('proxy');
    expect(final(makeCase('t', { settings: { proxyMode: 'split', splitApps: ['chrome.exe'], splitMode: 'proxy' } }))).toBe('direct');
    for (const proxyMode of ['system', 'tun', 'manual']) {
      expect(final(makeCase('t', { settings: { proxyMode } })), proxyMode).toBe('proxy');
    }
  });
});

describe('experimental', () => {
  it('clash_api carries the backend credentials, and bad credentials throw', () => {
    expect(generate(named('named-defaults-system')).experimental.clash_api).toEqual({
      external_controller: '127.0.0.1:19191',
      external_ui: '',
      secret: BACKEND_FIELDS.clashApi.secret,
    });
    expect(generate(named('named-no-clash-api')).experimental).not.toHaveProperty('clash_api');
    expect(() => generate(makeCase('t', { settings: { clashApi: { port: 19191, secret: '' } } }))).toThrow(
      'Missing Clash API secret'
    );
    expect(() => generate(makeCase('t', { settings: { clashApi: { port: 0, secret: 'x' } } }))).toThrow(
      'Invalid Clash API port'
    );
  });

  it('cache_file.path is present exactly when cacheFilePath is', () => {
    expect(generate(named('named-defaults-system')).experimental.cache_file).toEqual({
      enabled: true,
      path: 'C:\\awesome-proxy-test\\cache.db',
    });
    expect(generate(named('named-web-mode')).experimental.cache_file).toEqual({ enabled: true });
  });
});

describe('nodeRejectionReason', () => {
  const reason = (node: unknown, core: string | undefined = '1.14.4') => generator.nodeRejectionReason(node, core);
  const fixture = (name: string) => nodeFixtures([name])[0];

  it('basic shape', () => {
    expect(reason(null)).toBe('not an object');
    expect(reason({ server: 'a', port: 1 })).toBe('missing protocol');
    expect(reason({ ...ss('a'), server: '' })).toBe('missing server address');
    for (const port of [0, 70000, 'abc', 1.5]) expect(reason({ ...ss('a'), port }), String(port)).toBe('invalid port');
    for (const type of ['vmess', 'vless', 'tuic']) {
      expect(reason({ type, server: '127.0.0.1', port: 1 }), type).toBe('missing uuid');
    }
    for (const name of ['vmess-ws-tls', 'vless-reality-vision', 'trojan-tls', 'tuic-v5', 'anytls', 'shadowtls-v3']) {
      expect(reason(fixture(name)), name).toBeNull();
    }
  });

  it('Shadowsocks 2022 needs a base64 key of the exact size', () => {
    expect(reason(fixture('invalid-ss2022-key'))).toBe('method 2022-blake3-aes-256-gcm needs a base64 key of 32 bytes');
    // A valid 16-byte key is still the wrong size for the 256-bit method.
    expect(reason({ ...fixture('ss-2022-blake3-aes-128-gcm'), method: '2022-blake3-aes-256-gcm' })).toBe(
      'method 2022-blake3-aes-256-gcm needs a base64 key of 32 bytes'
    );
    expect(reason({ ...fixture('shadowtls-v3'), method: '2022-blake3-aes-128-gcm' })).toBe(
      'method 2022-blake3-aes-128-gcm needs a base64 key of 16 bytes'
    );
    expect(reason(fixture('ss-2022-blake3-aes-128-gcm'))).toBeNull();
    expect(reason(fixture('ss-aes-256-gcm'))).toBeNull();
  });

  it('WireGuard keys must be 32 bytes of base64', () => {
    const wg = fixture('wireguard');
    expect(reason(wg)).toBeNull();
    expect(reason({ ...wg, privateKey: '' })).toBe('missing WireGuard private key');
    expect(reason({ ...wg, privateKey: 'abc' })).toBe('WireGuard private key must be 32 bytes of base64');
    expect(reason({ ...wg, peerPublicKey: undefined })).toBe('missing WireGuard peer public key');
    expect(reason({ ...wg, peerPublicKey: 'abc=' })).toBe('WireGuard peer public key must be 32 bytes of base64');
    expect(reason({ ...wg, preSharedKey: 'abc' })).toBe('WireGuard pre-shared key must be 32 bytes of base64');
  });

  it('gecko obfs needs core 1.14 (a pre-release counts as its release)', () => {
    const gecko = fixture('hy2-gecko');
    const message = 'obfs "gecko" requires sing-box 1.14.0 or newer (Settings → About → Upgrade Core)';
    expect(reason(gecko, '1.13.18')).toBe(message);
    // Called directly: an explicit undefined would pick up `reason`'s default (1.14.4).
    expect(generator.nodeRejectionReason(gecko, undefined)).toBe(message);
    expect(reason(gecko, 'unknown')).toBe(message);
    expect(reason(gecko, '1.14.0-rc.5')).toBeNull();
    expect(reason(gecko, '1.14.4')).toBeNull();
    expect(reason(fixture('hy2-salamander-hop'), '1.13.18')).toBeNull();
  });

  it('OpenVPN', () => {
    const ovpn = fixture('ovpn-tls-auth');
    const key128 = `-----BEGIN OpenVPN Static key V1-----\n${'ab'.repeat(128)}\n-----END OpenVPN Static key V1-----\n`;
    expect(reason(ovpn)).toBeNull();
    expect(reason({ ...ovpn, ovpnControlWrapType: 'tls_crypt' })).toBeNull();
    expect(reason({ ...ovpn, ovpnControlWrapType: undefined, ovpnControlWrapKey: undefined })).toBeNull();
    expect(reason(ovpn, '1.13.18')).toBe('OpenVPN requires sing-box 1.14.0 or newer (Settings → About → Upgrade Core)');
    expect(reason({ ...ovpn, ovpnCa: undefined })).toBe('missing OpenVPN CA certificate (the <ca> block of the .ovpn file)');
    expect(reason({ ...ovpn, ovpnCa: 'not a pem' })).toBe('missing OpenVPN CA certificate (the <ca> block of the .ovpn file)');
    expect(reason({ ...ovpn, ovpnClientCert: ovpn.ovpnCa })).toBe(
      'OpenVPN client certificate and key must both be present or both absent'
    );
    expect(reason({ ...ovpn, ovpnControlWrapType: 'tls_crypt_v2' })).toBe(
      'tls-crypt-v2 is not supported yet: sing-box 1.14.0 crashes on it, which would take every other node down'
    );
    expect(reason({ ...ovpn, ovpnControlWrapType: 'tls_foo' })).toBe('unknown OpenVPN control channel wrapping "tls_foo"');
    expect(reason({ ...ovpn, ovpnControlWrapKey: 'not a key' })).toBe(
      'OpenVPN tls-auth/tls-crypt key is not a valid OpenVPN Static key V1'
    );
    expect(reason({ ...ovpn, ovpnControlWrapKey: key128 })).toBe(
      'OpenVPN tls-auth/tls-crypt key must be 256 bytes, got 128 (a wrong size crashes the core)'
    );
  });

  it('httpupgrade and h2 map to sing-box transports; unsupported transports (xhttp, kcp/mkcp) are rejected with a reason instead of emitted as plain TCP', () => {
    const uuid = fixture('vmess-tcp').uuid;
    const node = (type: string, transportType: unknown, extra: Record<string, unknown> = {}): any => ({
      id: 'n',
      name: 'n',
      type,
      server: '127.0.0.1',
      port: 19193,
      ...(type === 'trojan' ? { password: 'x', tls: true } : { uuid }),
      transportType,
      ...extra,
    });
    const transport = (n: unknown) => generator.nodeToOutbound(n, 'n').transport;
    const PATH_AND_HOST = { transportPath: '/p', transportHost: 'cdn.example.com' };

    for (const type of ['vmess', 'vless', 'trojan']) {
      // httpupgrade takes ONE host string.
      expect(transport(node(type, 'httpupgrade', PATH_AND_HOST)), type).toEqual({
        type: 'httpupgrade',
        path: '/p',
        host: 'cdn.example.com',
      });
      expect(transport(node(type, 'httpupgrade')), type).toEqual({ type: 'httpupgrade' });
      // h2, as older imports stored it, in any case: the http transport, whose host is a list.
      for (const h2 of ['h2', 'H2', ' h2 ', 'http']) {
        expect(transport(node(type, h2, PATH_AND_HOST)), `${type} ${h2}`).toEqual({
          type: 'http',
          path: '/p',
          host: ['cdn.example.com'],
        });
      }
      // Plain TCP under any of its names: no transport block, and not skipped.
      for (const tcp of [undefined, '', 'tcp', 'TCP', 'raw', 'none']) {
        expect(transport(node(type, tcp)), `${type} ${String(tcp)}`).toBeUndefined();
        expect(reason(node(type, tcp)), `${type} ${String(tcp)}`).toBeNull();
      }
      for (const supported of ['ws', 'grpc', 'quic', 'httpupgrade', 'h2']) {
        expect(reason(node(type, supported)), `${type} ${supported}`).toBeNull();
      }
      // A transport sing-box lacks is skipped with its name...
      for (const missing of ['xhttp', 'kcp', 'mkcp', 'splithttp', 'XHTTP', ' kcp ']) {
        expect(reason(node(type, missing)), `${type} ${missing}`).toBe(
          `transport "${missing.trim().toLowerCase()}" is not supported by sing-box`
        );
      }
      expect(reason(node(type, 'a'.repeat(32))), type).toBe(`transport "${'a'.repeat(32)}" is not supported by sing-box`);
      // ...and one whose name is not a short plain word without it, since the reason is logged as it is.
      for (const odd of ['x http', 'a'.repeat(33), 'kcp"', 'é', 'kcp\nxhttp']) {
        expect(reason(node(type, odd)), `${type} ${JSON.stringify(odd)}`).toBe(
          'transport of an unknown type is not supported by sing-box'
        );
      }
    }
    // Other protocols ignore transportType, as before.
    expect(reason({ ...ss('a'), transportType: 'xhttp' })).toBeNull();

    // In a whole config the skipped nodes are in neither outbounds nor groups.
    const config = generate(TRANSPORT_CASES[0]);
    for (const tag of ['vless-xhttp', 'vmess-kcp']) {
      expect(outboundTags(config), tag).not.toContain(tag);
      expect(groupMembers(config), tag).not.toContain(tag);
    }
    expect(outbound(config, 'vless-httpupgrade').transport).toEqual({
      type: 'httpupgrade',
      path: '/upgrade',
      host: 'cdn.example.com',
    });
    expect(outbound(config, 'vless-stored-h2').transport).toEqual({ type: 'http', path: '/h2', host: ['h2.example.com'] });
    expect(outbound(config, 'vless-stored-raw')).not.toHaveProperty('transport');
  });
});

describe('Shadowsocks SIP003 plugins', () => {
  const reason = (node: unknown) => generator.nodeRejectionReason(node, '1.14.4');
  const withPlugin = (plugin: unknown, pluginOpts?: unknown): any => ({ ...ss('p'), plugin, pluginOpts });
  const NO_NAME = 'Shadowsocks plugin options have an option without a name';
  const DANGLING = 'Shadowsocks plugin options end with a backslash that escapes nothing';
  const OBFS = 'obfs-local needs obfs=http or obfs=tls';
  const MODE = 'v2ray-plugin mode must be websocket, or quic with tls';
  const CERT = 'v2ray-plugin cert and certRaw options are not supported';
  const MUX = 'v2ray-plugin mux must be a number';
  const notSupported = (name: string) =>
    `Shadowsocks plugin "${name}" is not supported by sing-box (only obfs-local and v2ray-plugin)`;

  it('obfs-local and v2ray-plugin are emitted as plugin and plugin_opts; empty options are left out', () => {
    const plain = {
      type: 'shadowsocks',
      tag: 'p',
      server: '127.0.0.1',
      server_port: 19199,
      method: 'aes-128-gcm',
      password: 'x',
    };
    expect(generator.nodeToOutbound(ss('p'), 'p')).toEqual(plain);
    expect(generator.nodeToOutbound(withPlugin('obfs-local', 'obfs=http;obfs-host=www.bing.com'), 'p')).toEqual({
      ...plain,
      plugin: 'obfs-local',
      plugin_opts: 'obfs=http;obfs-host=www.bing.com',
    });
    expect(generator.nodeToOutbound(withPlugin('v2ray-plugin', 'mode=websocket;host=cdn.example.com;path=/ws;tls'), 'p')).toEqual({
      ...plain,
      plugin: 'v2ray-plugin',
      plugin_opts: 'mode=websocket;host=cdn.example.com;path=/ws;tls',
    });
    for (const opts of [undefined, '']) {
      expect(generator.nodeToOutbound(withPlugin('obfs-local', opts), 'p'), String(opts)).toEqual({ ...plain, plugin: 'obfs-local' });
      expect(generator.nodeToOutbound(withPlugin('v2ray-plugin', opts), 'p'), String(opts)).toEqual({ ...plain, plugin: 'v2ray-plugin' });
    }
    // No plugin name: plain Shadowsocks, whatever the options say.
    expect(generator.nodeToOutbound(withPlugin('', 'obfs=http'), 'p')).toEqual(plain);

    const config = generate(TRANSPORT_CASES[0]);
    expect(outbound(config, 'ss-v2ray-plugin-quic-tls')).toMatchObject({
      plugin: 'v2ray-plugin',
      plugin_opts: 'mode=quic;tls;host=cdn.example.com',
    });
    for (const tag of ['ss-obfs-foo', 'ss-v2ray-plugin-cert', 'ss-plugin-simple-obfs']) {
      expect(outboundTags(config), tag).not.toContain(tag);
      expect(groupMembers(config), tag).not.toContain(tag);
    }
  });

  it('options are split the way sing-box reads SS_PLUGIN_OPTIONS', () => {
    const parse = (text: unknown) => generator.parseSip003Options(text);
    const options = (text: string) => {
      const result = parse(text);
      expect(result.ok, text).toBe(true);
      return result.options;
    };
    expect(parse('')).toEqual({ ok: true, options: [] });
    expect(parse(undefined)).toEqual({ ok: true, options: [] });
    expect(options('obfs=http;obfs-host=www.bing.com')).toEqual([
      ['obfs', 'http'],
      ['obfs-host', 'www.bing.com'],
    ]);
    // A bare key is "1", one trailing ; is fine, and an = after the first belongs to the value.
    expect(options('mode=websocket;tls;')).toEqual([
      ['mode', 'websocket'],
      ['tls', '1'],
    ]);
    expect(options('path=/a=b')).toEqual([['path', '/a=b']]);
    // \ makes the next character literal, in keys as in values.
    expect(options('obfs-host=a\\;b;p\\=q=\\\\;ob\\fs=tls')).toEqual([
      ['obfs-host', 'a;b'],
      ['p=q', '\\'],
      ['obfs', 'tls'],
    ]);
    // Spaces are kept, an empty value is a value, and a key may repeat.
    expect(options('obfs = http;host=;obfs=tls')).toEqual([
      ['obfs ', ' http'],
      ['host', ''],
      ['obfs', 'tls'],
    ]);
    for (const text of [';', ';obfs=http', 'obfs=http;;obfs-host=x', '=x', 'tls;;']) {
      expect(parse(text), text).toEqual({ ok: false, error: NO_NAME });
    }
    for (const text of ['\\', 'obfs=http\\', 'obfs\\', 'a=b\\\\\\']) {
      expect(parse(text), text).toEqual({ ok: false, error: DANGLING });
    }
  });

  it('a plugin or options the core refuses at startup skip the node with a reason', () => {
    // Each passes `sing-box check` (planning probe P-3 and the B3 probe).
    const accepted: [string, string | undefined][] = [
      ['obfs-local', 'obfs=http;obfs-host=www.bing.com'],
      ['obfs-local', 'obfs=tls'],
      ['obfs-local', undefined],
      ['obfs-local', ''],
      ['obfs-local', 'obfs=http;'],
      ['obfs-local', 'obfs-host=x'],
      ['obfs-local', 'obfs=http;whatever=1'],
      ['obfs-local', 'obfs=http;obfs-host=a\\;b'],
      ['obfs-local', 'obfs = http'],
      ['obfs-local', 'obfs=tls;obfs-host='],
      ['obfs-local', 'ob\\fs=tls'],
      ['v2ray-plugin', 'mode=websocket;host=cdn.example.com;path=/ws;tls'],
      ['v2ray-plugin', undefined],
      ['v2ray-plugin', 'tls'],
      ['v2ray-plugin', 'mode=quic;tls;host=cdn.example.com'],
      ['v2ray-plugin', 'mode=quic;tls=0'],
      ['v2ray-plugin', 'mode=websocket;mux=4'],
      ['v2ray-plugin', 'mode=websocket;mux=-1'],
      ['v2ray-plugin', 'mode=websocket;mux=0'],
      ['v2ray-plugin', 'mode=websocket;mux=999999999999999999'],
      ['v2ray-plugin', 'host=;path='],
      ['v2ray-plugin', 'path=/a\\=b'],
      ['v2ray-plugin', 'path=/ws;loglevel=none'],
      ['v2ray-plugin', 'mode=websocket;'],
    ];
    for (const [plugin, opts] of accepted) expect(reason(withPlugin(plugin, opts)), `${plugin} ${String(opts)}`).toBeNull();
    expect(reason(withPlugin(undefined, 'obfs=foo'))).toBeNull();
    expect(reason(withPlugin('', 'obfs=foo'))).toBeNull();

    // Each is FATAL at `sing-box check` (same probes), except the two marked
    // stricter: the core reads only a key's first value, so it accepts them.
    const refused: [string, string, string][] = [
      ['simple-obfs', 'obfs=http', notSupported('simple-obfs')],
      ['Obfs-Local', 'obfs=http', notSupported('Obfs-Local')],
      ['obfs-local', ';obfs=http', NO_NAME],
      ['obfs-local', 'obfs=http;;obfs-host=x', NO_NAME],
      ['obfs-local', '=x', NO_NAME],
      ['obfs-local', 'obfs=http\\', DANGLING],
      ['v2ray-plugin', 'mode=websocket\\', DANGLING],
      ['obfs-local', 'obfs=foo', OBFS],
      ['obfs-local', 'obfs', OBFS],
      ['obfs-local', 'obfs=HTTP', OBFS],
      ['obfs-local', 'obfs=http\\\\', OBFS],
      ['obfs-local', 'ob\\fs=foo', OBFS],
      ['obfs-local', 'obfs=foo;obfs=http', OBFS],
      ['obfs-local', 'obfs=http;obfs=foo', OBFS], // stricter
      ['v2ray-plugin', 'mode=foo', MODE],
      ['v2ray-plugin', 'mode=WebSocket', MODE],
      ['v2ray-plugin', 'mode=quic', MODE],
      ['v2ray-plugin', 'mode=quic;host=cdn.example.com', MODE],
      ['v2ray-plugin', 'mode=websocket;mode=quic', MODE], // stricter
      ['v2ray-plugin', 'mode=websocket;cert=C:\\nope.pem;tls', CERT],
      ['v2ray-plugin', 'certRaw=abc;tls', CERT],
      ['v2ray-plugin', 'mode=websocket;host=a;path=/;tls;certRaw=', CERT],
      ['v2ray-plugin', 'mode=websocket;mux=abc', MUX],
      ['v2ray-plugin', 'mode=websocket;mux=99999999999999999999', MUX],
    ];
    for (const [plugin, opts, expected] of refused) expect(reason(withPlugin(plugin, opts)), `${plugin} ${opts}`).toBe(expected);

    // Only a Shadowsocks node reads a plugin, and the SS-2022 key check still comes first.
    expect(reason({ ...nodeFixtures(['shadowtls-v3'])[0], plugin: 'simple-obfs' })).toBeNull();
    expect(reason({ ...withPlugin('simple-obfs'), method: '2022-blake3-aes-128-gcm' })).toBe(
      'method 2022-blake3-aes-128-gcm needs a base64 key of 16 bytes'
    );
  });
});

describe('uTLS fingerprint', () => {
  it('only a fingerprint the core knows is emitted; any other counts as none, so Reality still gets chrome', () => {
    const KNOWN = [
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
    ];
    const tls = (name: string, fingerprint: unknown) =>
      generator.nodeToOutbound({ ...nodeFixtures([name])[0], fingerprint }, 't').tls;
    for (const fp of KNOWN) {
      expect(tls('vmess-ws-tls', fp).utls, fp).toEqual({ enabled: true, fingerprint: fp });
      expect(tls('vless-reality-vision', fp).utls, fp).toEqual({ enabled: true, fingerprint: fp });
    }
    // The core refuses each of these at startup ("unknown uTLS fingerprint"); links write `none`.
    for (const fp of ['none', 'unknown', 'Chrome', '', undefined]) {
      expect(tls('vmess-ws-tls', fp), String(fp)).not.toHaveProperty('utls');
      expect(tls('vless-reality-vision', fp).utls, String(fp)).toEqual({ enabled: true, fingerprint: 'chrome' });
    }

    const config = generate(TRANSPORT_CASES[0]);
    expect(outbound(config, 'vless-tls-insecure-firefox').tls).toEqual({
      enabled: true,
      server_name: 'example.com',
      insecure: true,
      utls: { enabled: true, fingerprint: 'firefox' },
    });
    expect(outbound(config, 'vmess-fingerprint-none').tls).toEqual({ enabled: true, server_name: 'example.com' });
  });
});

import { describe, expect, it } from 'vitest';
import { parseDnsServer as rendererParseDnsServer } from '../../src/services/dns-servers';
import { makeCase } from '../fixtures/matrix';
import { generate, generator } from '../helpers/generator';

/**
 * Remote and Direct DNS (audit P0-8): what parseDnsServer accepts and rejects,
 * and what the generator emits from it. The table runs against both copies,
 * the generator's and the renderer's mirror; dns-parity.test.ts compares the
 * two on a much larger set of inputs.
 */

const COPIES: [string, (input: unknown) => unknown][] = [
  ['generator', generator.parseDnsServer],
  ['renderer', rendererParseDnsServer],
];

const ok = (server: Record<string, unknown>, hostname: boolean) => ({ ok: true, server, hostname });
const fail = (error: string) => ({ ok: false, error });

const NO_SCHEME = 'Use https://, h3://, tls://, quic:// or udp://, or a bare IP address.';
const AUTHORITY = 'Only a host and an optional port may come before the path.';
const QUERY = 'A ? or # part is not supported.';
const ESCAPE = 'A % in the path must be followed by two hex digits, e.g. %2F.';
const BRACKETS = 'Put an IPv6 address in brackets, e.g. https://[2606:4700:4700::1111]/dns-query.';
const HOST = 'The server must be an IP address or a host name.';
const PORT = 'The port must be a number from 1 to 65535.';
const unsupported = (scheme: string) => `${scheme}:// is not supported. Use https://, h3://, tls://, quic:// or udp://.`;
const noPath = (scheme: string) => `${scheme}:// takes no path.`;

// Labels of 63, 63, 63 and 61 characters: 253 in all, the longest valid name.
const LONGEST_NAME = [63, 63, 63, 61].map((n) => 'a'.repeat(n)).join('.');

const DOH_1111 = { type: 'https', server: '1.1.1.1', path: '/dns-query' };

/** Input → expected result. The expected objects list their keys in emission order. */
const TABLE: [unknown, unknown][] = [
  // DoH; an empty path or "/" means /dns-query, anything else is kept.
  ['https://1.1.1.1/dns-query', ok(DOH_1111, false)],
  ['https://1.1.1.1', ok(DOH_1111, false)],
  ['https://1.1.1.1/', ok(DOH_1111, false)],
  ['https://dns.google/resolve', ok({ type: 'https', server: 'dns.google', path: '/resolve' }, true)],
  [
    'https://doh.example.com:8443/custom/path',
    ok({ type: 'https', server: 'doh.example.com', server_port: 8443, path: '/custom/path' }, true),
  ],
  ['https://[2606:4700:4700::1111]', ok({ type: 'https', server: '2606:4700:4700::1111', path: '/dns-query' }, false)],
  ['https://1.1.1.1:1', ok({ type: 'https', server: '1.1.1.1', server_port: 1, path: '/dns-query' }, false)],
  ['https://1.1.1.1:65535', ok({ type: 'https', server: '1.1.1.1', server_port: 65535, path: '/dns-query' }, false)],
  [`https://${LONGEST_NAME}`, ok({ type: 'https', server: LONGEST_NAME, path: '/dns-query' }, true)],
  // A % escape in the path is kept as typed: two hex digits of either case,
  // also for a byte that isn't UTF-8 (%C3), which the core takes as well.
  ['https://1.1.1.1/a%20b', ok({ type: 'https', server: '1.1.1.1', path: '/a%20b' }, false)],
  ['https://1.1.1.1/a%2Fb', ok({ type: 'https', server: '1.1.1.1', path: '/a%2Fb' }, false)],
  ['h3://1.1.1.1/a%2fb%C3', ok({ type: 'h3', server: '1.1.1.1', path: '/a%2fb%C3' }, false)],
  // DoH3, same path rule.
  ['h3://dns.google/dns-query', ok({ type: 'h3', server: 'dns.google', path: '/dns-query' }, true)],
  [
    'h3://[2606:4700:4700::1111]:443',
    ok({ type: 'h3', server: '2606:4700:4700::1111', server_port: 443, path: '/dns-query' }, false),
  ],
  // DoT, DoQ, plain UDP: no path; a lone "/" is tolerated.
  ['tls://1.1.1.1', ok({ type: 'tls', server: '1.1.1.1' }, false)],
  ['tls://dns.google:853', ok({ type: 'tls', server: 'dns.google', server_port: 853 }, true)],
  ['quic://dns.adguard-dns.com', ok({ type: 'quic', server: 'dns.adguard-dns.com' }, true)],
  ['quic://223.5.5.5:853/', ok({ type: 'quic', server: '223.5.5.5', server_port: 853 }, false)],
  ['udp://8.8.8.8', ok({ type: 'udp', server: '8.8.8.8' }, false)],
  ['udp://8.8.8.8:5353', ok({ type: 'udp', server: '8.8.8.8', server_port: 5353 }, false)],
  ['udp://[2001:4860:4860::8888]:53', ok({ type: 'udp', server: '2001:4860:4860::8888', server_port: 53 }, false)],
  // Bare addresses are plain DNS; IPv6 with or without brackets.
  ['114.114.114.114', ok({ type: 'udp', server: '114.114.114.114' }, false)],
  ['0.0.0.0', ok({ type: 'udp', server: '0.0.0.0' }, false)],
  ['2001:4860:4860::8888', ok({ type: 'udp', server: '2001:4860:4860::8888' }, false)],
  ['[2001:4860:4860::8888]', ok({ type: 'udp', server: '2001:4860:4860::8888' }, false)],
  ['::1', ok({ type: 'udp', server: '::1' }, false)],
  ['::ffff:1.2.3.4', ok({ type: 'udp', server: '::ffff:1.2.3.4' }, false)],
  ['1:2:3:4:5:6:7:8', ok({ type: 'udp', server: '1:2:3:4:5:6:7:8' }, false)],
  // The scheme is case-insensitive; the host is kept as typed. Whitespace around the value is dropped.
  ['HTTPS://DNS.Google/dns-query', ok({ type: 'https', server: 'DNS.Google', path: '/dns-query' }, true)],
  ['TLS://1.1.1.1', ok({ type: 'tls', server: '1.1.1.1' }, false)],
  ['  tls://1.1.1.1:853  ', ok({ type: 'tls', server: '1.1.1.1', server_port: 853 }, false)],
  ['\thttps://1.1.1.1\n', ok(DOH_1111, false)],

  // Nothing to parse.
  ['', fail('Enter a DNS server.')],
  ['   ', fail('Enter a DNS server.')],
  [undefined, fail('Enter a DNS server.')],
  [null, fail('Enter a DNS server.')],
  [53, fail('Enter a DNS server.')],
  // No scheme, and not a bare address.
  ['dns.google', fail(NO_SCHEME)],
  ['1.1.1.1:53', fail(NO_SCHEME)],
  ['[::1]:53', fail(NO_SCHEME)],
  ['https:/1.1.1.1', fail(NO_SCHEME)],
  ['1.2.3.4::', fail(NO_SCHEME)],
  ['1:2:3:4:5:6:7:8:9', fail(NO_SCHEME)],
  ['fe80::1%eth0', fail(NO_SCHEME)],
  // Schemes the app does not emit.
  ['ftp://x', fail(unsupported('ftp'))],
  ['tcp://1.1.1.1', fail(unsupported('tcp'))],
  ['FTP://x', fail(unsupported('ftp'))],
  ['sdns://AQcAAAAAAAAA', fail(unsupported('sdns'))],
  // Only host[:port] before the path, and no query or fragment after it.
  ['https://user@1.1.1.1/dns-query', fail(AUTHORITY)],
  ['https://1.1.1.1?dns=x', fail(AUTHORITY)],
  ['https://1.1.1.1 /dns-query', fail(AUTHORITY)],
  ['https://1.1.1.1/dns-query?dns=x', fail(QUERY)],
  ['https://1.1.1.1/dns-query#x', fail(QUERY)],
  // A % that two hex digits don't follow: sing-box refuses the whole config
  // over such a path ("invalid URL escape"), so it must never be emitted.
  ['https://1.1.1.1/dns-query%', fail(ESCAPE)],
  ['https://1.1.1.1/dns-query%2', fail(ESCAPE)],
  ['https://1.1.1.1/%zz', fail(ESCAPE)],
  ['h3://1.1.1.1/%zz', fail(ESCAPE)],
  ['https://1.1.1.1/%%', fail(ESCAPE)],
  ['https://1.1.1.1/a%20b%', fail(ESCAPE)],
  // An IPv6 host needs brackets.
  ['https://2606:4700:4700::1111/dns-query', fail(BRACKETS)],
  ['tls://::1', fail(BRACKETS)],
  // Hosts.
  ['https://256.1.1.1', fail(HOST)],
  ['https://1.1.1', fail(HOST)],
  ['https://01.1.1.1', fail(HOST)],
  ['https://-bad.example', fail(HOST)],
  ['https://bad-.example', fail(HOST)],
  ['https://a..b', fail(HOST)],
  ['https://dns.google.', fail(HOST)],
  ['https://host_name', fail(HOST)],
  [`https://${'a'.repeat(64)}.com`, fail(HOST)],
  [`https://${LONGEST_NAME}a`, fail(HOST)],
  ['https:///dns-query', fail(HOST)],
  ['https://:853', fail(HOST)],
  ['https://[1::2::3]', fail(HOST)],
  ['https://[::1', fail(HOST)],
  ['https://[::1]x', fail(HOST)],
  ['https://[1.1.1.1]', fail(HOST)],
  ['https://[fe80::1%eth0]', fail(HOST)],
  // The host is checked before the port.
  ['https://256.1.1.1:abc', fail(HOST)],
  // Ports.
  ['https://1.1.1.1:0', fail(PORT)],
  ['https://1.1.1.1:65536', fail(PORT)],
  ['https://1.1.1.1:123456', fail(PORT)],
  ['https://1.1.1.1:abc', fail(PORT)],
  ['https://1.1.1.1:', fail(PORT)],
  ['https://[::1]:', fail(PORT)],
  ['udp://1.1.1.1:-53', fail(PORT)],
  // A path only for DoH and DoH3.
  ['tls://1.1.1.1/dns-query', fail(noPath('tls'))],
  ['quic://1.1.1.1/x', fail(noPath('quic'))],
  ['udp://1.1.1.1/x', fail(noPath('udp'))],
];

describe('parseDnsServer', () => {
  for (const [copy, parse] of COPIES) {
    it(`${copy}: every accepted form and every error text`, () => {
      for (const [input, expected] of TABLE) {
        const result = parse(input);
        expect(result, JSON.stringify(input)).toEqual(expected);
        // Key order too: the generator emits these objects as they are.
        expect(JSON.stringify(result), JSON.stringify(input)).toBe(JSON.stringify(expected));
      }
    });
  }
});

describe('generator: dns.servers from the settings', () => {
  const dnsOf = (settings: Record<string, unknown>, options: { nodes?: [] } = {}) =>
    generate(makeCase('dns-test', { settings, ...options })).dns;
  const server = (dns: any, tag: string) => dns.servers.find((s: any) => s.tag === tag);
  const json = (value: unknown) => JSON.stringify(value);

  it('the defaults reproduce the servers the generator always emitted', () => {
    const dns = dnsOf({});
    expect(dns.servers.map((s: any) => s.tag)).toEqual(['hosts-dns', 'local-dns', 'remote-dns', 'direct-dns']);
    expect(json(server(dns, 'remote-dns'))).toBe(
      json({ tag: 'remote-dns', type: 'https', server: '1.1.1.1', path: '/dns-query', detour: 'proxy' })
    );
    expect(json(server(dns, 'direct-dns'))).toBe(
      json({ tag: 'direct-dns', type: 'https', server: '223.5.5.5', path: '/dns-query' })
    );
  });

  it('a Remote DNS name bootstraps through the proxy, a Direct DNS name through local-dns; an IP address needs nothing', () => {
    const tags = (dns: any) => dns.servers.map((s: any) => s.tag);
    const PLAIN_TAGS = ['hosts-dns', 'local-dns', 'remote-dns', 'direct-dns'];

    const named = dnsOf({ remoteDns: 'tls://dns.google', directDns: 'https://dns.alidns.com/dns-query' });
    expect(tags(named)).toEqual(['hosts-dns', 'local-dns', 'remote-dns-bootstrap', 'remote-dns', 'direct-dns']);
    // Cloudflare DoH by IP literal through the proxy: it needs no lookup of its
    // own, and Windows' resolver never sees the Remote DNS name.
    expect(json(server(named, 'remote-dns-bootstrap'))).toBe(
      json({ tag: 'remote-dns-bootstrap', type: 'https', server: '1.1.1.1', detour: 'proxy' })
    );
    expect(json(server(named, 'remote-dns'))).toBe(
      json({ tag: 'remote-dns', type: 'tls', server: 'dns.google', domain_resolver: 'remote-dns-bootstrap', detour: 'proxy' })
    );
    expect(json(server(named, 'direct-dns'))).toBe(
      json({ tag: 'direct-dns', type: 'https', server: 'dns.alidns.com', path: '/dns-query', domain_resolver: 'local-dns' })
    );
    // local-dns is the OS resolver, which needs no bootstrap of its own.
    expect(server(named, 'local-dns')).toEqual({ tag: 'local-dns', type: 'local' });

    // Without nodes there is no proxy to go through, so the name keeps local-dns.
    const noNodes = dnsOf({ remoteDns: 'tls://dns.google' }, { nodes: [] });
    expect(tags(noNodes)).toEqual(PLAIN_TAGS);
    expect(json(server(noNodes, 'remote-dns'))).toBe(
      json({ tag: 'remote-dns', type: 'tls', server: 'dns.google', domain_resolver: 'local-dns' })
    );

    // A Direct DNS name alone brings no bootstrap.
    const directNamed = dnsOf({ directDns: 'tls://dns.alidns.com' });
    expect(tags(directNamed)).toEqual(PLAIN_TAGS);
    expect(json(server(directNamed, 'direct-dns'))).toBe(
      json({ tag: 'direct-dns', type: 'tls', server: 'dns.alidns.com', domain_resolver: 'local-dns' })
    );

    const literal = dnsOf({ remoteDns: 'tls://1.1.1.1', directDns: 'quic://223.5.5.5:853' });
    expect(tags(literal)).toEqual(PLAIN_TAGS);
    expect(json(server(literal, 'remote-dns'))).toBe(
      json({ tag: 'remote-dns', type: 'tls', server: '1.1.1.1', detour: 'proxy' })
    );
    expect(json(server(literal, 'direct-dns'))).toBe(
      json({ tag: 'direct-dns', type: 'quic', server: '223.5.5.5', server_port: 853 })
    );
  });

  it('only Remote DNS and its bootstrap take a detour, and only when there are nodes', () => {
    const cases: [Record<string, unknown>, string[][]][] = [
      [{}, [['remote-dns', 'proxy']]],
      [
        { remoteDns: 'tls://dns.google', directDns: 'udp://114.114.114.114' },
        [
          ['remote-dns-bootstrap', 'proxy'],
          ['remote-dns', 'proxy'],
        ],
      ],
    ];
    for (const [settings, detours] of cases) {
      const withNodes = dnsOf(settings);
      expect(withNodes.servers.filter((s: any) => 'detour' in s).map((s: any) => [s.tag, s.detour])).toEqual(detours);
      const noNodes = dnsOf(settings, { nodes: [] });
      expect(noNodes.servers.filter((s: any) => 'detour' in s)).toEqual([]);
    }
  });

  it('a value that does not parse gives exactly the DNS block of the defaults', () => {
    const defaults = json(dnsOf({}));
    const invalid: [unknown, unknown][] = [
      ['ftp://x', 'not a server'],
      ['', '   '],
      [undefined, undefined],
      ['https://1.1.1.1:0', 'tls://1.1.1.1/dns-query'],
      ['https://2606:4700:4700::1111/dns-query', 'dns.alidns.com'],
      ['https://1.1.1.1/dns-query%', 'h3://223.5.5.5/%zz'],
    ];
    for (const [remoteDns, directDns] of invalid) {
      expect(json(dnsOf({ remoteDns, directDns })), json([remoteDns, directDns])).toBe(defaults);
    }
  });

  it('the rest of the DNS block does not depend on the servers', () => {
    const defaults = dnsOf({});
    const custom = dnsOf({ remoteDns: 'h3://[2606:4700:4700::1111]/dns-query', directDns: '114.114.114.114' });
    const { servers: _a, ...defaultsRest } = defaults;
    const { servers: _b, ...customRest } = custom;
    expect(customRest).toEqual(defaultsRest);
    expect(custom.servers.slice(0, 2)).toEqual(defaults.servers.slice(0, 2));
  });
});

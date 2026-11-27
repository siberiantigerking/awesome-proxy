import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECT_DNS, DEFAULT_REMOTE_DNS, parseDnsServer } from '../../src/services/dns-servers';
import { generator } from '../helpers/generator';

/**
 * Settings and the Dashboard judge a DNS setting with the renderer's copy of
 * parseDnsServer (src/services/dns-servers.ts), while the generator emits from
 * its own (shared/config-generator.cjs). If the two disagreed, Settings could
 * accept a value the generator replaces by the default, or flag one it uses.
 * Every input here must give the same result from both, key order included.
 */

const SCHEMES = ['https://', 'h3://', 'tls://', 'quic://', 'udp://', 'tcp://', 'HTTPS://', 'ftp://', 'https:/', ''];
const HOSTS = [
  '1.1.1.1',
  '223.5.5.5',
  '256.1.1.1',
  '1.1.1',
  'dns.google',
  'DNS.Example.COM',
  '-bad.example',
  'a..b',
  '[2606:4700:4700::1111]',
  '2606:4700:4700::1111',
  '[::1]',
  '[1::2::3]',
  '',
  ' ',
  'host_name',
  'a'.repeat(64) + '.com',
];
const PORTS = ['', ':53', ':853', ':0', ':65535', ':65536', ':abc', ':'];
const PATHS = ['', '/', '/dns-query', '/abc123', '/a?b', '/a#b', '/a%zz', '/a%20b'];

/** Every error text, with `<scheme>` where the text names the scheme typed. */
const ERROR_TEXTS = [
  'Enter a DNS server.',
  'Use https://, h3://, tls://, quic:// or udp://, or a bare IP address.',
  '<scheme>:// is not supported. Use https://, h3://, tls://, quic:// or udp://.',
  'Only a host and an optional port may come before the path.',
  'A ? or # part is not supported.',
  'A % in the path must be followed by two hex digits, e.g. %2F.',
  'Put an IPv6 address in brackets, e.g. https://[2606:4700:4700::1111]/dns-query.',
  'The server must be an IP address or a host name.',
  'The port must be a number from 1 to 65535.',
  '<scheme>:// takes no path.',
];

// Address shapes for isIPv4/isIPv6, which the generator does not export. Both
// copies see each one bare, in brackets and inside a URL.
const ADDRESSES = [
  '0.0.0.0',
  '255.255.255.255',
  '01.1.1.1',
  '1.1.1.1.1',
  '::',
  '::1',
  '1::',
  '1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7:8:9',
  '1::2:3:4:5:6:7:8',
  '::2:3:4:5:6:7:8',
  '::ffff:1.2.3.4',
  '1.2.3.4::',
  '::1.2.3.4:5',
  '1:2:3:4:5:6:1.2.3.4',
  '1:2:3:4:5:6:7:1.2.3.4',
  'fe80::1%eth0',
  '12345::1',
  ':1::2',
  '1:::2',
  'g::1',
  'FFFF::abcd',
];

function compare(input: unknown) {
  const renderer = parseDnsServer(input);
  const shared = generator.parseDnsServer(input);
  expect(renderer, JSON.stringify(input)).toEqual(shared);
  expect(JSON.stringify(renderer), JSON.stringify(input)).toBe(JSON.stringify(shared));
  return shared;
}

describe('DNS server parity (renderer vs generator)', () => {
  it('the defaults are the same IP literals in both copies', () => {
    expect(DEFAULT_REMOTE_DNS).toBe('https://1.1.1.1/dns-query');
    expect(DEFAULT_DIRECT_DNS).toBe('https://223.5.5.5/dns-query');
    expect(generator.DEFAULT_REMOTE_DNS).toBe(DEFAULT_REMOTE_DNS);
    expect(generator.DEFAULT_DIRECT_DNS).toBe(DEFAULT_DIRECT_DNS);
    compare(DEFAULT_REMOTE_DNS);
    compare(DEFAULT_DIRECT_DNS);
  });

  it('every scheme × host × port × path combination parses the same', () => {
    let combinations = 0;
    let accepted = 0;
    const errors = new Set<string>();
    for (const scheme of SCHEMES) {
      for (const host of HOSTS) {
        for (const port of PORTS) {
          for (const path of PATHS) {
            const result = compare(scheme + host + port + path);
            combinations++;
            if (result.ok) accepted++;
            else errors.add(result.error.replace(/^[a-z0-9+.-]+:\/\/ /, '<scheme>:// '));
          }
        }
      }
    }
    expect(combinations).toBe(10 * 16 * 8 * 8);
    // Not vacuous: many inputs are accepted, and every error text occurs.
    expect(accepted).toBeGreaterThan(100);
    expect([...errors].sort()).toEqual([...ERROR_TEXTS].sort());
  });

  it('address edge cases parse the same, bare, in brackets and in a URL', () => {
    for (const address of ADDRESSES) {
      compare(address);
      compare(`[${address}]`);
      compare(`https://[${address}]/dns-query`);
      compare(`udp://${address}:53`);
    }
  });

  it('input that is not a plain string, or carries whitespace', () => {
    for (const input of [undefined, null, 53, {}, [], true, ' https://1.1.1.1 ', '\thttps://1.1.1.1\n', 'https://1.1.1.1 /x']) {
      compare(input);
    }
  });
});

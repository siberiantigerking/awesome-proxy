/*
 * The renderer's copy of the DNS server rules in `shared/config-generator.cjs`
 * (its "DNS Servers" section): the defaults, parseDnsServer and the address
 * checks it relies on. Settings validates Remote and Direct DNS as the user
 * types, and the Dashboard shows the server the generator actually emits, so
 * these MUST accept and reject exactly what the generator does.
 * tests/unit/dns-parity.test.ts enforces the parity; change both copies
 * together.
 *
 * Why the settings needed this (audit P0-8): the generator used to ignore both
 * fields and always emit Cloudflare 1.1.1.1 and AliDNS 223.5.5.5, so a server
 * typed in Settings had no effect while the Dashboard showed it as in use.
 */

/**
 * What the generator emitted before it read the settings: Cloudflare and
 * AliDNS DoH by IP literal, which needs no bootstrap lookup through the local
 * resolver. They are the defaults too, and the settings v6 migration
 * (settingsStore) moves the old, never-used dns.google / dns.alidns.com
 * defaults to them, so nobody's DNS changes unless they edit it.
 */
export const DEFAULT_REMOTE_DNS = 'https://1.1.1.1/dns-query';
export const DEFAULT_DIRECT_DNS = 'https://223.5.5.5/dns-query';

/** The sing-box DNS server types the app emits. Each is also the scheme that selects it. */
export type DnsServerType = 'https' | 'h3' | 'tls' | 'quic' | 'udp';

/** A sing-box DNS server without its tag, with the keys in the order the generator emits them. */
export interface DnsServerSpec {
  type: DnsServerType;
  server: string;
  server_port?: number;
  path?: string;
}

/**
 * `hostname`: the server is a name the core must look up first (Remote DNS
 * through the proxy, Direct DNS through the OS resolver; see the DNS block in
 * shared/config-generator.cjs).
 */
export type DnsParseResult =
  | { ok: true; server: DnsServerSpec; hostname: boolean }
  | { ok: false; error: string };

const DNS_SERVER_TYPES: readonly string[] = ['https', 'h3', 'tls', 'quic', 'udp'];

const DNS_HOST_ERROR = 'The server must be an IP address or a host name.';
const DNS_PORT_ERROR = 'The port must be a number from 1 to 65535.';
const DNS_ESCAPE_ERROR = 'A % in the path must be followed by two hex digits, e.g. %2F.';

/** Dotted-quad IPv4: four decimal octets of 0-255, without leading zeros. */
export function isIPv4(text: unknown): boolean {
  return (
    typeof text === 'string' &&
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(text)
  );
}

/**
 * IPv6 in text form, without brackets and without a zone id: hex groups of
 * 1-4 digits, exactly 8 of them, or fewer with one `::` standing for the rest.
 * A dotted IPv4 part may end the address and counts as two groups.
 */
export function isIPv6(text: unknown): boolean {
  if (typeof text !== 'string' || !/^[0-9A-Fa-f:.]+$/.test(text) || !text.includes(':')) return false;
  const halves = text.split('::');
  if (halves.length > 2) return false;
  let groups = 0;
  for (let h = 0; h < halves.length; h++) {
    if (halves[h] === '') continue;
    const parts = halves[h].split(':');
    for (let i = 0; i < parts.length; i++) {
      // Only the address's very last part may be dotted IPv4.
      const last = h === halves.length - 1 && i === parts.length - 1;
      if (last && parts[i].includes('.')) {
        if (!isIPv4(parts[i])) return false;
        groups += 2;
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(parts[i])) {
        groups += 1;
      } else {
        return false;
      }
    }
  }
  return halves.length === 2 ? groups < 8 : groups === 8;
}

/**
 * A DNS host name: dot-separated labels of 1-63 letters, digits and hyphens,
 * none starting or ending with a hyphen, no trailing dot, 253 characters at most.
 */
function isHostName(text: string): boolean {
  return (
    text.length <= 253 &&
    text.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

/**
 * Parse a Remote/Direct DNS setting into a sing-box DNS server, exactly as the
 * generator does. The generator's parseDnsServer documents the accepted forms
 * (https://, h3://, tls://, quic://, udp://, or a bare IP address) and every
 * error text; Settings shows the error as is.
 *
 * Hand-written instead of `new URL()`: Chromium (this copy runs in Electron's
 * renderer) and Node parse non-special schemes such as tls:// differently, and
 * the two copies must agree on every input.
 */
export function parseDnsServer(input: unknown): DnsParseResult {
  const fail = (error: string): DnsParseResult => ({ ok: false, error });
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return fail('Enter a DNS server.');

  // A bare address is plain DNS.
  if (isIPv4(text) || isIPv6(text)) {
    return { ok: true, server: { type: 'udp', server: text }, hostname: false };
  }
  if (text.startsWith('[') && text.endsWith(']') && isIPv6(text.slice(1, -1))) {
    return { ok: true, server: { type: 'udp', server: text.slice(1, -1) }, hostname: false };
  }

  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (!match) return fail('Use https://, h3://, tls://, quic:// or udp://, or a bare IP address.');
  const scheme = match[1].toLowerCase();
  if (!DNS_SERVER_TYPES.includes(scheme)) {
    return fail(`${scheme}:// is not supported. Use https://, h3://, tls://, quic:// or udp://.`);
  }

  const rest = match[2];
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);
  if (/[@?#\s]/.test(authority)) return fail('Only a host and an optional port may come before the path.');
  if (/[?#]/.test(path)) return fail('A ? or # part is not supported.');
  // The core unescapes a DoH/DoH3 path when it builds the server, and a % not
  // followed by two hex digits fails that ("invalid URL escape"), which stops
  // the whole config and with it every node. Any other path it takes, a byte
  // that isn't UTF-8 (%C3) included, so this is the only escape check.
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return fail(DNS_ESCAPE_ERROR);

  let host: string;
  let portText: string | null = null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    host = close < 0 ? '' : authority.slice(1, close);
    const after = close < 0 ? '' : authority.slice(close + 1);
    if (close < 0 || !isIPv6(host) || (after !== '' && !after.startsWith(':'))) return fail(DNS_HOST_ERROR);
    if (after !== '') portText = after.slice(1);
  } else {
    const colon = authority.indexOf(':');
    if (colon !== authority.lastIndexOf(':')) {
      return fail('Put an IPv6 address in brackets, e.g. https://[2606:4700:4700::1111]/dns-query.');
    }
    host = colon < 0 ? authority : authority.slice(0, colon);
    if (colon >= 0) portText = authority.slice(colon + 1);
    // Only digits and dots is a mistyped IPv4 address (1.1.1, 256.1.1.1), not a name.
    if (!isIPv4(host) && (/^[0-9.]*$/.test(host) || !isHostName(host))) return fail(DNS_HOST_ERROR);
  }

  let port: number | undefined;
  if (portText !== null) {
    port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
    if (port < 1 || port > 65535) return fail(DNS_PORT_ERROR);
  }

  const takesPath = scheme === 'https' || scheme === 'h3';
  if (!takesPath && path !== '' && path !== '/') return fail(`${scheme}:// takes no path.`);

  const server: DnsServerSpec = { type: scheme as DnsServerType, server: host };
  if (port !== undefined) server.server_port = port;
  if (takesPath) server.path = path === '' || path === '/' ? '/dns-query' : path;
  return { ok: true, server, hostname: !isIPv4(host) && !isIPv6(host) };
}

export interface EffectiveDnsServer {
  /** The trimmed setting when it parses, otherwise the fallback. */
  text: string;
  /** True when the setting does not parse, so the generator emits the fallback instead. */
  usingDefault: boolean;
  /** Why the setting does not parse, when it doesn't. */
  error?: string;
}

/**
 * The DNS server the generator actually emits for a setting: the setting when
 * it parses, otherwise `fallback` (the generator's dnsServerEntry does the
 * same, so a typo can't stop the core). For the Dashboard, which used to show
 * the raw setting.
 */
export function effectiveDnsServer(value: unknown, fallback: string): EffectiveDnsServer {
  const parsed = parseDnsServer(value);
  if (parsed.ok) return { text: (value as string).trim(), usingDefault: false };
  return { text: fallback, usingDefault: true, error: parsed.error };
}

import type { ProxyNode, SplitRule } from '../../src/types';
import type { GeneratorCase, GeneratorSettings } from '../helpers/generator';
import { indexOfNode, nodeFixtures } from './nodes';
import { LEGACY_DIRECT_DNS, LEGACY_REMOTE_DNS } from './settings-history';
import { TRANSPORT_FIXTURES } from './transports';

export { indexOfNode };

/**
 * Generator cases: a pairwise settings matrix plus named edge cases. The
 * snapshot suite and the `sing-box check` suite both iterate allCases().
 */

/**
 * The renderer's default AppSettings (src/store/settingsStore.ts). The DNS
 * defaults are the IP literals the generator emitted, Cloudflare 1.1.1.1 and
 * AliDNS 223.5.5.5, back when it ignored remoteDns/directDns. That is why the
 * snapshots written before it honoured the fields (audit P0-8) stayed
 * byte-identical when it started to.
 */
export const BASE_SETTINGS: GeneratorSettings = {
  socksPort: 1080,
  httpPort: 8080,
  separatePorts: false,
  mixedPort: 7890,
  proxyMode: 'system',
  allowLan: false,
  ipv6Strategy: 'block',
  tunBypassLocalNetworks: false,
  tunStack: 'mixed',
  remoteDns: 'https://1.1.1.1/dns-query',
  directDns: 'https://223.5.5.5/dns-query',
  bypassChina: true,
  logLevel: 'info',
  autoStart: false,
  startMinimized: false,
  checkUpdatesOnStartup: true,
  theme: 'dark',
  splitRules: [],
  splitApps: [],
  splitMode: 'proxy',
};

/** Fields only the backend fills in. Fixed values so the snapshots are stable. */
export const BACKEND_FIELDS = {
  coreVersion: '1.14.4',
  // A fake path: `check` never opens the cache file.
  cacheFilePath: 'C:\\awesome-proxy-test\\cache.db',
  clashApi: { port: 19191, secret: 'f'.repeat(64) },
};

export const SPLIT_RULES: SplitRule[] = [
  { id: 'openai', name: 'OpenAI', outbound: 'proxy', ruleSets: ['geosite-openai'], enabled: true },
  {
    id: 'google',
    name: 'Google/YouTube',
    outbound: 'vless-reality-vision',
    ruleSets: ['geosite-youtube', 'geoip-google'],
    enabled: true,
  },
  { id: 'bilibili', name: 'BiliBili', outbound: 'direct', ruleSets: ['geosite-bilibili'], enabled: false },
];

/** What a Split row adds to BASE_SETTINGS. */
const SPLIT_SETTINGS: GeneratorSettings = {
  splitRules: SPLIT_RULES,
  splitApps: ['chrome.exe'],
  splitMode: 'proxy',
};

/** The matrix factors, in the order scratch/pairwise.cjs uses. */
export const FACTORS = {
  proxyMode: ['system', 'tun', 'split', 'manual'],
  ipv6Strategy: ['block', 'prefer-ipv4', 'ipv4-only'],
  tunStack: ['mixed', 'system', 'gvisor'],
  allowLan: [false, true],
  separatePorts: [false, true],
  bypassChina: [true, false],
  tunBypassLocalNetworks: [false, true],
} as const;

export type MatrixRow = {
  [K in keyof typeof FACTORS]: (typeof FACTORS)[K][number];
};

/** 12 rows that cover every pair of factor values (checked by the snapshot suite). */
export const MATRIX_ROWS: MatrixRow[] = [
  { proxyMode: 'system', ipv6Strategy: 'block', tunStack: 'mixed', allowLan: true, separatePorts: false, bypassChina: false, tunBypassLocalNetworks: true },
  { proxyMode: 'system', ipv6Strategy: 'prefer-ipv4', tunStack: 'system', allowLan: false, separatePorts: false, bypassChina: false, tunBypassLocalNetworks: false },
  { proxyMode: 'system', ipv6Strategy: 'ipv4-only', tunStack: 'gvisor', allowLan: false, separatePorts: true, bypassChina: true, tunBypassLocalNetworks: true },
  { proxyMode: 'tun', ipv6Strategy: 'block', tunStack: 'system', allowLan: false, separatePorts: true, bypassChina: false, tunBypassLocalNetworks: true },
  { proxyMode: 'tun', ipv6Strategy: 'prefer-ipv4', tunStack: 'gvisor', allowLan: true, separatePorts: true, bypassChina: false, tunBypassLocalNetworks: true },
  { proxyMode: 'tun', ipv6Strategy: 'ipv4-only', tunStack: 'mixed', allowLan: false, separatePorts: false, bypassChina: true, tunBypassLocalNetworks: false },
  { proxyMode: 'split', ipv6Strategy: 'block', tunStack: 'gvisor', allowLan: false, separatePorts: false, bypassChina: false, tunBypassLocalNetworks: false },
  { proxyMode: 'split', ipv6Strategy: 'prefer-ipv4', tunStack: 'mixed', allowLan: true, separatePorts: true, bypassChina: false, tunBypassLocalNetworks: false },
  { proxyMode: 'split', ipv6Strategy: 'ipv4-only', tunStack: 'system', allowLan: true, separatePorts: false, bypassChina: true, tunBypassLocalNetworks: true },
  { proxyMode: 'manual', ipv6Strategy: 'block', tunStack: 'mixed', allowLan: false, separatePorts: true, bypassChina: true, tunBypassLocalNetworks: true },
  { proxyMode: 'manual', ipv6Strategy: 'prefer-ipv4', tunStack: 'system', allowLan: false, separatePorts: true, bypassChina: true, tunBypassLocalNetworks: false },
  { proxyMode: 'manual', ipv6Strategy: 'ipv4-only', tunStack: 'gvisor', allowLan: true, separatePorts: false, bypassChina: false, tunBypassLocalNetworks: false },
];

interface CaseOptions {
  nodes?: GeneratorCase['nodes'];
  /** Default: 0 (vmess-ws-tls in the full fixture list). */
  selectedIndex?: number;
  settings?: GeneratorSettings;
  /** Default true. False leaves settings.clashApi out: the renderer-facing shape. */
  clashApi?: boolean;
  /** Default true. False leaves settings.cacheFilePath out: the web-mode shape. */
  cacheFile?: boolean;
}

/** One case: BASE_SETTINGS + backend fields + overrides, with its own copy of the nodes. */
export function makeCase(id: string, options: CaseOptions = {}): GeneratorCase {
  const { clashApi = true, cacheFile = true } = options;
  const settings: GeneratorSettings = {
    ...structuredClone(BASE_SETTINGS),
    coreVersion: BACKEND_FIELDS.coreVersion,
    ...(cacheFile ? { cacheFilePath: BACKEND_FIELDS.cacheFilePath } : {}),
    ...(clashApi ? { clashApi: { ...BACKEND_FIELDS.clashApi } } : {}),
    ...structuredClone(options.settings || {}),
  };
  return {
    id,
    nodes: options.nodes ? structuredClone(options.nodes) : nodeFixtures(),
    selectedIndex: options.selectedIndex ?? 0,
    settings,
  };
}

export function matrixCaseId(row: MatrixRow, index: number): string {
  return `matrix-${String(index + 1).padStart(2, '0')}-${row.proxyMode}-${row.ipv6Strategy}-${row.tunStack}`;
}

/** Every matrix row with the full node list and the OpenVPN node selected, so every node type appears. */
export const MATRIX_CASES: GeneratorCase[] = MATRIX_ROWS.map((row, index) =>
  makeCase(matrixCaseId(row, index), {
    selectedIndex: indexOfNode('ovpn-tls-auth'),
    settings: { ...row, ...(row.proxyMode === 'split' ? SPLIT_SETTINGS : {}) },
  })
);

export const NAMED_CASES: GeneratorCase[] = [
  makeCase('named-defaults-system'),
  makeCase('named-defaults-tun', { settings: { proxyMode: 'tun' } }),
  // The config the renderer gets back from config:generate (no controller).
  makeCase('named-no-clash-api', { clashApi: false }),
  // server/index.js: no controller and no cache path.
  makeCase('named-web-mode', { clashApi: false, cacheFile: false }),
  // Unknown or pre-1.14 core: OpenVPN and gecko skipped, disable_chrome_parrot
  // dropped, and the selector falls back from the skipped OpenVPN node.
  makeCase('named-oldest-core', {
    selectedIndex: indexOfNode('ovpn-tls-auth'),
    settings: { proxyMode: 'tun', coreVersion: '0.0.0' },
  }),
  makeCase('named-split-direct-apps', {
    settings: { proxyMode: 'split', splitMode: 'direct', splitApps: ['chrome.exe', 'Telegram.exe'], splitRules: [] },
  }),
  makeCase('named-split-no-usable-nodes', {
    nodes: nodeFixtures(['invalid-ss2022-key', 'invalid-vmess-no-uuid']),
    settings: { proxyMode: 'split', ...SPLIT_SETTINGS },
  }),
  makeCase('named-no-nodes', { nodes: [] }),
  makeCase('named-selected-invalid', { selectedIndex: indexOfNode('invalid-vmess-no-uuid') }),
  // The SOCKS port equals the mixed port, so the generator must skip it.
  makeCase('named-port-collision', { settings: { separatePorts: true, socksPort: 7890, httpPort: 8080 } }),
];

/**
 * Nodes for the collision cases: Shadowsocks on 127.0.0.1:19199, or ShadowTLS
 * (which also emits a helper outbound) for the names listed in `shadowtls`.
 * Only the names matter; the ids are unique, as the node store keeps them.
 */
function namedNodes(names: string[], shadowtls: string[] = []): ProxyNode[] {
  return names.map((name, i) => {
    const node: ProxyNode = {
      id: `collision-${i}`,
      name,
      type: 'shadowsocks',
      server: '127.0.0.1',
      port: 19199,
      method: 'aes-128-gcm',
      password: `collision-password-${i}`,
    };
    if (!shadowtls.includes(name)) return node;
    return {
      ...node,
      type: 'shadowtls',
      tls: true,
      sni: 'www.example.com',
      shadowTlsVersion: 3,
      shadowTlsPassword: 'shadowtls-password',
    };
  });
}

/**
 * Node names that collide with each other or with the generator's own tags
 * (audit P0-4). Before the fix, every case except collision-internal-prefixes
 * made `sing-box check` fail with "duplicate outbound/endpoint tag", and that
 * stops the core for every node, not just the one with the awkward name.
 */
export const COLLISION_CASES: GeneratorCase[] = [
  // The generator's own outbounds.
  makeCase('collision-reserved-names', { nodes: namedNodes(['direct', 'proxy', 'auto', 'A']) }),
  // The second HK's suffix is a name a third node already has.
  makeCase('collision-hk-hk-hk1', { nodes: namedNodes(['HK', 'HK', 'HK-1']) }),
  // A Split rule's selector used to be tagged with the rule's display name.
  makeCase('collision-split-rule-like-node', {
    nodes: namedNodes(['YouTube']),
    settings: {
      proxyMode: 'split',
      splitRules: [{ id: 'youtube', name: 'YouTube', outbound: 'proxy', ruleSets: ['geosite-youtube'], enabled: true }],
    },
  }),
  // A ShadowTLS helper used to be tagged "<node>-shadowtls".
  makeCase('collision-shadowtls-helper', { nodes: namedNodes(['X', 'X-shadowtls'], ['X']) }),
  // Names inside the internal namespaces. No collision before the fix (the
  // internal tags had no prefix then); this pins the `node-` escape that keeps
  // them from meeting split:openai and the shadowtls:X helper now.
  makeCase('collision-internal-prefixes', {
    nodes: namedNodes(['split:openai', 'shadowtls:X', 'X'], ['X']),
    settings: { proxyMode: 'split', splitRules: [SPLIT_RULES[0]] },
  }),
  // The suffix for the reserved "proxy" is a name a node already has.
  makeCase('collision-suffix-taken', { nodes: namedNodes(['proxy-1', 'proxy']) }),
];

/**
 * Remote/Direct DNS settings (audit P0-8). Every other case uses the
 * defaults, which reproduce the DNS the generator emitted before it read these
 * fields.
 */
export const DNS_CASES: GeneratorCase[] = [
  // The old, never-used defaults, as settings that skipped the v6 migration
  // would carry them. Taken as typed they are host names: Remote DNS is
  // bootstrapped through remote-dns-bootstrap (1.1.1.1 through the proxy),
  // Direct DNS through local-dns; the migration is what keeps real installs off
  // this.
  makeCase('dns-legacy-hostname-defaults', {
    settings: { proxyMode: 'tun', remoteDns: LEGACY_REMOTE_DNS, directDns: LEGACY_DIRECT_DNS },
  }),
  makeCase('dns-custom-tls-quic', {
    settings: { proxyMode: 'tun', remoteDns: 'tls://dns.google', directDns: 'quic://223.5.5.5:853' },
  }),
  makeCase('dns-custom-h3-ipv6-udp', {
    settings: { remoteDns: 'h3://[2606:4700:4700::1111]/dns-query', directDns: '114.114.114.114' },
  }),
  // Neither parses, so both fall back: the dns block is named-defaults-system's.
  makeCase('dns-invalid-falls-back', { settings: { remoteDns: 'ftp://x', directDns: 'not a server' } }),
  // No proxy to detour through, so the name is bootstrapped through local-dns.
  makeCase('dns-no-nodes-hostname', { nodes: [], settings: { remoteDns: 'https://dns.google/dns-query' } }),
  // sing-box refuses the whole config when a DoH path has a % that two hex
  // digits don't follow, so that Remote DNS must fall back to the default.
  // Valid escapes are kept as typed, even a byte that isn't UTF-8 (%C3).
  makeCase('dns-percent-escapes', {
    settings: { remoteDns: 'https://1.1.1.1/dns-query%', directDns: 'https://223.5.5.5/a%20b%2Fc%C3' },
  }),
];

/**
 * Transports, Shadowsocks plugins and uTLS fingerprints (audit P1-8), in one
 * case of their own so the 34 earlier snapshots keep their node list: the
 * emitted shapes must pass `check`, and the ones the core would refuse must be
 * left out.
 */
export const TRANSPORT_CASES: GeneratorCase[] = [makeCase('transport-shapes', { nodes: [...TRANSPORT_FIXTURES] })];

export function allCases(): GeneratorCase[] {
  return [...MATRIX_CASES, ...NAMED_CASES, ...COLLISION_CASES, ...DNS_CASES, ...TRANSPORT_CASES];
}

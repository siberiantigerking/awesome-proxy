import { describe, expect, it } from 'vitest';
import { normalizeTransportType, SUPPORTED_TRANSPORTS } from '../../src/services/node-parser';
import { generator } from '../helpers/generator';
import { mulberry32, pick } from '../helpers/prng';

/**
 * Links and Clash YAML are stored through the renderer's normalizeTransportType
 * (src/services/node-parser.ts), and the node form uses its SUPPORTED_TRANSPORTS
 * to mark a transport the node is skipped for. The generator normalises every
 * node again with its own copy (shared/config-generator.cjs) before it builds or
 * rejects the transport. If the two disagreed, the form could show a node as
 * fine that the generator skips, or a stored spelling could turn into a
 * different transport. Every input here must give the same result from both.
 */

const TABLE: [unknown, string][] = [
  ['', 'tcp'],
  [undefined, 'tcp'],
  [null, 'tcp'],
  ['TCP', 'tcp'],
  [' ws ', 'ws'],
  ['raw', 'tcp'],
  ['none', 'tcp'],
  ['h2', 'http'],
  ['http', 'http'],
  ['httpupgrade', 'httpupgrade'],
  ['grpc', 'grpc'],
  ['quic', 'quic'],
  ['xhttp', 'xhttp'],
  ['kcp', 'kcp'],
  ['mkcp', 'mkcp'],
  ['splithttp', 'splithttp'],
];

// Pieces of the random inputs: every special spelling, in several cases, plus
// whitespace, separators and characters toLowerCase treats unusually.
const PIECES = [
  'tcp',
  'TCP',
  'raw',
  'Raw',
  'none',
  'NONE',
  'h2',
  'H2',
  'http',
  'HttpUpgrade',
  'ws',
  'WS',
  'grpc',
  'quic',
  'xhttp',
  'kcp',
  ' ',
  '\t',
  '\n',
  '-',
  '_',
  'İ',
  'ß',
  '香港',
  '0',
  '',
];

describe('transport parity (renderer vs generator)', () => {
  it('both copies support the same transports', () => {
    expect([...SUPPORTED_TRANSPORTS].sort()).toEqual(['grpc', 'http', 'httpupgrade', 'quic', 'tcp', 'ws']);
    expect([...generator.SUPPORTED_TRANSPORTS].sort()).toEqual([...SUPPORTED_TRANSPORTS].sort());
  });

  it('the table normalises the same in both copies', () => {
    for (const [input, expected] of TABLE) {
      expect(normalizeTransportType(input), JSON.stringify(input)).toBe(expected);
      expect(generator.normalizeTransportType(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it('1,000 seeded random strings normalise the same in both copies', () => {
    const rand = mulberry32(0x7a5);
    const results = new Set<string>();
    let supported = 0;
    for (let i = 0; i < 1000; i++) {
      const count = 1 + Math.floor(rand() * 3);
      let input = '';
      for (let k = 0; k < count; k++) input += pick(rand, PIECES);
      const renderer = normalizeTransportType(input);
      const shared = generator.normalizeTransportType(input);
      expect(renderer, JSON.stringify(input)).toBe(shared);
      expect(SUPPORTED_TRANSPORTS.has(renderer), JSON.stringify(input)).toBe(generator.SUPPORTED_TRANSPORTS.has(shared));
      results.add(renderer);
      if (SUPPORTED_TRANSPORTS.has(renderer)) supported++;
    }
    // Not vacuous: the special spellings occur, and so do names sing-box lacks.
    for (const name of ['tcp', 'http', 'ws', 'xhttp']) expect(results.has(name), name).toBe(true);
    expect(supported).toBeGreaterThan(50);
    expect(supported).toBeLessThan(950);
  });
});

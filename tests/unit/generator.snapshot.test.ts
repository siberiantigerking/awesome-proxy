import { describe, expect, it } from 'vitest';
import { allCases, FACTORS, MATRIX_ROWS } from '../fixtures/matrix';
import { generate } from '../helpers/generator';
import { assertConfigInvariants, plainTcpTags } from '../helpers/invariants';

/**
 * One JSON file per case under __snapshots__/generator/, byte for byte what
 * electron/main.ts writes as the config file (JSON.stringify(config, null, 2)),
 * so a snapshot diff reads exactly like a change to the user's config.
 *
 * The invariants run BEFORE the snapshot assertion: a case that breaks one
 * fails without writing (or updating) its snapshot.
 *
 * A failing snapshot is a generator change. Read the diff; accept it with
 * `npm test -- -u` only when every change in it is intended.
 */
describe('generator snapshots', () => {
  for (const c of allCases()) {
    it(c.id, async () => {
      const config = generate(c);
      assertConfigInvariants(config, {
        expectClashApi: Boolean(c.settings.clashApi),
        plainTcpTags: plainTcpTags(c.nodes),
      });
      await expect(JSON.stringify(config, null, 2)).toMatchFileSnapshot(`./__snapshots__/generator/${c.id}.json`);
    });
  }
});

describe('case list', () => {
  it('MATRIX_ROWS covers every pair of factor values', () => {
    const factors = Object.entries(FACTORS) as [keyof typeof FACTORS, readonly unknown[]][];
    let pairs = 0;
    const missing: string[] = [];
    for (let i = 0; i < factors.length; i++) {
      for (let j = i + 1; j < factors.length; j++) {
        const [a, aValues] = factors[i];
        const [b, bValues] = factors[j];
        for (const x of aValues) {
          for (const y of bValues) {
            pairs++;
            if (!MATRIX_ROWS.some((row) => row[a] === x && row[b] === y)) missing.push(`${a}=${x} & ${b}=${y}`);
          }
        }
      }
    }
    // 4×3 + 4×3 + 3×3 for the three enums, + (4+3+3)×2×4 enum×boolean, + 6×4 boolean pairs.
    expect(pairs).toBe(137);
    expect(missing).toEqual([]);
  });

  it('every case id is unique and filename-safe', () => {
    const ids = allCases().map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(ids.filter((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id))).toEqual([]);
  });
});

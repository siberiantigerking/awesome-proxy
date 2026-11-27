import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allCases } from '../fixtures/matrix';
import { generate } from '../helpers/generator';
import { checkConfig, HAS_CORE } from '../helpers/sing-box';

/**
 * Every generator case through the bundled core's `check -c stdin`. It is
 * read-only: nothing starts, nothing listens, no admin rights needed, so TUN
 * and Split configs are safe here (and only here).
 *
 * Expected: exit 0 and NO output. Empty output also catches a new deprecation
 * warning the moment a core upgrade starts printing one.
 */
describe.skipIf(!HAS_CORE)(
  HAS_CORE ? 'sing-box check -c stdin' : 'sing-box check — SKIPPED: resources/bin/sing-box.exe not found',
  () => {
    let dir = '';
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awesome-proxy-test-'));
    });
    afterAll(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    for (const c of allCases()) {
      it(c.id, () => {
        const result = checkConfig(generate(c), dir);
        expect(result).toEqual({ status: 0, output: '' });
      });
    }
  }
);

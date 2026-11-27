// Test runner config: two Vitest projects, both in the plain Node environment.
//
//   unit  (`npm test`)          pure suites: generator snapshots and invariants,
//                               tag parity, share links, Clash YAML, settings
//                               migrations. No network, nothing is spawned.
//   core  (`npm run test:core`) suites that spawn resources/bin/sing-box.exe
//                               (`check` for every generator case, plus a
//                               loopback-only System/Manual `run` smoke test).
//
// Deliberately standalone: it neither imports nor extends vite.config.ts. That
// config loads vite-plugin-electron, which builds the main process and launches
// Electron, so sharing it would open the app (and a window) just to run tests.
// The suites never need the renderer's Vite pipeline either: tests load the
// generator through Node's own require, exactly as electron/main.ts does.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'core',
          include: ['tests/core/**/*.test.ts'],
          environment: 'node',
          // `check` takes well under a second per case, but a cold antivirus
          // scan of the core binary on its first spawn can take much longer.
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

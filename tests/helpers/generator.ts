import { createRequire } from 'node:module';
import type { ProxyNode } from '../../src/types';

// The generator and the Clash client are CommonJS modules shared by
// electron/main.ts and server/index.js, which both load them with Node's own
// `require`. Load them the same way here, so the suites exercise the exact
// module the app runs rather than a copy transformed by Vite.
const require = createRequire(import.meta.url);

export const generator: any = require('../../shared/config-generator.cjs');
export const clashClient: any = require('../../shared/clash-client.cjs');

/**
 * Generator input as the backends hand it over: the renderer's AppSettings
 * plus the fields only the backend fills in (coreVersion, cacheFilePath,
 * clashApi). Kept loose on purpose so fixtures can also carry values the
 * renderer types would reject.
 */
export type GeneratorSettings = Record<string, unknown> & {
  proxyMode?: string;
  clashApi?: { port: number; secret: string };
  cacheFilePath?: string;
  coreVersion?: string;
};

export interface GeneratorCase {
  /** Unique and filename-safe: it names the snapshot file. */
  id: string;
  nodes: ProxyNode[];
  selectedIndex: number;
  settings: GeneratorSettings;
}

/** The generated sing-box config for one case. */
export function generate(c: GeneratorCase): any {
  return generator.generateSingboxConfig(c.nodes, c.selectedIndex, c.settings);
}

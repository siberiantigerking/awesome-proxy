import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'path';

/**
 * Content-Security-Policy of the built renderer (audit P0-5, D24). It keeps
 * any injected markup from running script or loading from elsewhere.
 *
 * What the build needs, checked on dist\: the entry chunk plus the lazy
 * qr-scanner and web-api chunks and one stylesheet (all 'self'), ./logo.png,
 * blob: and data: images in qr-scanner.ts, and React `style` props (set through
 * the CSSOM, which 'unsafe-inline' for styles covers). No workers, no eval:
 * lodash's Function("return this") never runs because `self` exists, and
 * React's MSApp path is dead outside old Edge. For a page loaded with
 * loadFile, 'self' covers its file: URLs (electron-vite ships the same policy).
 * Web mode is served by vite.config.web.ts, so this policy never reaches it.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

export default defineConfig({
  plugins: [
    react(),
    // Build only: the dev server's HMR client and React refresh preamble are
    // inline scripts and a WebSocket, which this policy would block. Prepended,
    // because a <meta> CSP only governs what comes after it in the document.
    {
      name: 'awesome-proxy:production-csp',
      apply: 'build',
      transformIndexHtml: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: PRODUCTION_CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'electron',
                'electron-store',
                // vite-plugin-electron only externalizes Node builtins, and the
                // packaged app runs tsc's output anyway, which require()s the
                // updater from app.asar's node_modules. Bundling it here would
                // only duplicate a dependency that has to ship as-is.
                'electron-updater',
                // Kept external so the shipped copy under resources/ stays the
                // single source of truth instead of being inlined at build time.
                '../shared/config-generator.cjs',
                '../shared/node-probes.cjs',
                '../shared/core-version.cjs',
                '../shared/clash-client.cjs',
                '../shared/system-proxy.cjs',
              ],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
  },
});

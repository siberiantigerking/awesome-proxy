/**
 * Which URLs the app window may load, and which links may leave the app
 * (audit P0-5, D25).
 *
 * The renderer only ever shows the app itself, so a navigation anywhere else is
 * either a bug or injected script trying to swap the page for one that still
 * runs with the preload bridge. main.ts denies every new window, lets the
 * window navigate only to app URLs, and hands everything else to
 * openExternalSafely(), which opens plain https links in the default browser.
 *
 * No electron import, so plain Node can test the rules from
 * dist-electron\navigation.js.
 */
import path from 'path';
import { fileURLToPath } from 'url';

export interface AppUrlContext {
  /** VITE_DEV_SERVER_URL when running from source; undefined in a build. */
  devServerUrl?: string;
  /** The built renderer folder (dist), which a build loads with loadFile. */
  distDir: string;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * A file: URL that points inside distDir. Compared case-insensitively, as
 * Windows paths are. The URL parser has already resolved any `..` (encoded
 * ones included), and path.relative shows whatever is left outside the folder
 * as a leading `..`, or as an absolute path for another drive or a UNC share.
 */
function isFileInsideDir(url: URL, dir: string): boolean {
  let filePath: string;
  try {
    filePath = fileURLToPath(url);
  } catch {
    // A host Windows can't map, or an encoded slash in the path.
    return false;
  }
  const relative = path.relative(path.resolve(dir).toLowerCase(), path.resolve(filePath).toLowerCase());
  return relative !== '' && relative.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(relative);
}

/**
 * True for a URL that belongs to the app: the dev server's origin when running
 * from source, a file inside dist in a build. Also blob: URLs the app itself
 * created (Logs export clicks an `<a download href="blob:…">`), but only of the
 * app's own origin: `blob:http://localhost:5173/<uuid>` in dev,
 * `blob:file:///<uuid>` in a build.
 */
export function isAppUrl(url: string, ctx: AppUrlContext): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;

  const dev = ctx.devServerUrl ? parseUrl(ctx.devServerUrl) : null;
  if (ctx.devServerUrl && !dev) return false;

  if (parsed.protocol === 'blob:') {
    // The part after "blob:" is the creating page's origin plus a UUID.
    const inner = parseUrl(url.slice('blob:'.length));
    if (!inner) return false;
    if (dev) return inner.origin === dev.origin;
    // A file: page's origin has no host. The UUID is not a path, so there is
    // no folder to check.
    return inner.protocol === 'file:' && inner.host === '';
  }

  if (dev) return parsed.origin === dev.origin;
  return parsed.protocol === 'file:' && isFileInsideDir(parsed, ctx.distDir);
}

/**
 * True for a link that may be opened in the user's default browser: https
 * only, with a host and no embedded credentials. Anything else (http,
 * javascript:, file:, ms-settings: and other protocol handlers) is dropped,
 * because shell.openExternal hands it to whatever program Windows registered.
 */
export function isSafeExternalUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  return parsed.protocol === 'https:' && parsed.hostname !== '' && !parsed.username && !parsed.password;
}

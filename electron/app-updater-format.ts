/**
 * Pure helpers for the in-app app updater (./app-updater.ts): turn
 * electron-updater / Electron `net` failures into messages a user can act on,
 * and release notes into plain text.
 *
 * Pure on purpose — no imports, no Electron — so the mapping can be checked
 * with plain Node against real error shapes without starting an Electron app.
 */

export type AppUpdateErrorKind =
  | 'no-update-metadata'
  | 'no-release'
  | 'rate-limited'
  | 'offline'
  | 'dns'
  | 'timeout'
  | 'proxy'
  | 'network'
  | 'integrity'
  | 'install'
  | 'unknown';

export type UpdatePhase = 'check' | 'download' | 'install';

export interface UpdateErrorContext {
  phase: UpdatePhase;
  /** Local mixed-inbound port the request was routed through, or null when it went direct. */
  proxyPort: number | null;
}

/**
 * Shown when the latest release has no latest.yml and is newer than the
 * installed version. Every release up to v1.4.0 was published before the
 * updater existed. A latest release that isn't newer than the installed one
 * doesn't get here: the check reports "up to date" instead (D23, see
 * missingMetadataReleaseTag), because sending the user to download the
 * version they already run helps nobody.
 */
export const NO_UPDATE_METADATA_MESSAGE =
  "The latest release doesn't support in-app updating yet. Download it from the releases page.";

/** Matches electron-updater's message when the latest release has no channel file (latest.yml). */
const MISSING_CHANNEL_FILE_RE = /Cannot find \S+\.yml in the latest release artifacts/i;

/** String(x) that can't throw (e.g. on a null-prototype object). */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}

function messageOf(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return safeString(err);
}

/**
 * First non-empty line of an error's message, capped at `max` characters.
 * electron-updater packs response headers and stack traces into its messages,
 * so only the first line is fit for the app log or a UI string.
 */
export function firstLine(err: unknown, max = 300): string {
  const line = messageOf(err)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
  return line.length > max ? line.slice(0, Math.max(0, max - 1)) + '…' : line;
}

/**
 * Classify an updater failure and phrase it for the user. First match wins.
 *
 * The order matters: electron-updater wraps the real cause into its own codes
 * (e.g. ERR_UPDATER_LATEST_VERSION_NOT_FOUND around an `HttpError: 429` or a
 * `net::ERR_*`), so rate limiting and network errors are recognised before the
 * generic "no release" bucket and the user is told the actual problem.
 */
export function describeUpdateError(
  err: unknown,
  ctx: UpdateErrorContext
): { kind: AppUpdateErrorKind; message: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.statusCode === 'number' ? e.statusCode : NaN;
  const text = [e.message, e.stack, safeString(err)]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n');

  const via = ctx.proxyPort ? ` through the local proxy (127.0.0.1:${ctx.proxyPort})` : '';
  // The useful next step depends on the route: through the proxy the node is
  // the suspect, while a direct request may simply be blocked on this network.
  const hint = ctx.proxyPort
    ? ' Check that the selected node works, or disconnect and try again.'
    : ' If GitHub is blocked on this network, connect the proxy first and try again.';
  const timeoutMessage = `GitHub didn't respond in time${via}.${hint}`;

  if (ctx.phase === 'install') {
    if (code === 'APP_UPDATER_INSTALLER_MISSING') {
      // Found before anything was torn down (D22), so the app is still
      // connected and the message has no disconnect to mention.
      return {
        kind: 'install',
        message:
          'The downloaded update is no longer on disk (antivirus may have removed it). Check for updates to download it again.',
      };
    }
    if (code === 'APP_UPDATER_CORE_ACTIVE') {
      return {
        kind: 'install',
        message:
          "The proxy was reconnected while the update was being prepared, so the installer didn't start. Disconnect and try again.",
      };
    }
    // Every other install failure happens after the disconnect.
    return {
      kind: 'install',
      message:
        "Couldn't start the installer. The proxy was already disconnected: reconnect from the Dashboard, then download the update from the releases page.",
    };
  }

  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || MISSING_CHANNEL_FILE_RE.test(text)) {
    return { kind: 'no-update-metadata', message: NO_UPDATE_METADATA_MESSAGE };
  }

  if (
    status === 403 ||
    status === 429 ||
    code === 'HTTP_ERROR_403' ||
    code === 'HTTP_ERROR_429' ||
    /HttpError: (403|429)\b/.test(text) ||
    // File downloads report HTTP failures as plain text, not as an HttpError.
    /\bstatus (403|429)\b/.test(text) ||
    /rate limit/i.test(text)
  ) {
    return {
      kind: 'rate-limited',
      message: 'GitHub is limiting requests from this network right now. Wait a few minutes and try again.',
    };
  }

  if (code === 'APP_UPDATER_STALLED') {
    return {
      kind: 'timeout',
      message: `The download stopped making progress${via}. Check your connection and try again.`,
    };
  }

  const netError = /net::(ERR_[A-Z0-9_]+)/.exec(text)?.[1];
  if (netError) {
    if (netError === 'ERR_INTERNET_DISCONNECTED' || netError === 'ERR_ADDRESS_UNREACHABLE') {
      return {
        kind: 'offline',
        message: 'You appear to be offline. Check your internet connection and try again.',
      };
    }
    if (netError === 'ERR_NAME_NOT_RESOLVED' || netError === 'ERR_NAME_RESOLUTION_FAILED') {
      return { kind: 'dns', message: `Couldn't look up github.com.${hint}` };
    }
    if (netError === 'ERR_TIMED_OUT' || netError === 'ERR_CONNECTION_TIMED_OUT') {
      return { kind: 'timeout', message: timeoutMessage };
    }
    if (
      netError.startsWith('ERR_PROXY_') ||
      netError === 'ERR_TUNNEL_CONNECTION_FAILED' ||
      netError.startsWith('ERR_MANDATORY_PROXY_')
    ) {
      return {
        kind: 'proxy',
        message: ctx.proxyPort
          ? `Couldn't reach GitHub through the local proxy (127.0.0.1:${ctx.proxyPort}). Check that the selected node works, or disconnect and try again.`
          : "Couldn't reach GitHub through a proxy. Check your proxy settings and try again.",
      };
    }
    return { kind: 'network', message: `Couldn't connect to GitHub${via} (${netError}).${hint}` };
  }

  if (code === 'APP_UPDATER_TIMEOUT' || code === 'ETIMEDOUT' || /timed out/i.test(text)) {
    return { kind: 'timeout', message: timeoutMessage };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { kind: 'dns', message: `Couldn't look up github.com.${hint}` };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return { kind: 'network', message: `Couldn't connect to GitHub${via} (${code}).${hint}` };
  }

  if (
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    /No published versions on GitHub/i.test(text)
  ) {
    return { kind: 'no-release', message: 'No published release of Awesome Proxy was found on GitHub.' };
  }

  if (code === 'ERR_CHECKSUM_MISMATCH' || /checksum mismatch/i.test(text)) {
    return {
      kind: 'integrity',
      message:
        'The downloaded update failed its integrity check (sha512) and was discarded. Try downloading it again.',
    };
  }

  const detail = firstLine(err, 160);
  const suffix = detail ? ` (${detail})` : '';
  return {
    kind: 'unknown',
    message:
      ctx.phase === 'download'
        ? `The update download failed${suffix}.`
        : `Couldn't check for updates${suffix}.`,
  };
}

/**
 * The release tag whose latest.yml is missing, when `err` is the "no update
 * metadata" check failure; null for every other error. electron-updater names
 * the URL it tried (…/releases/download/<tag>/latest.yml) in the message.
 *
 * Only a version-shaped tag counts: the caller compares it with the installed
 * version (D23), and a tag that isn't a version must keep today's message
 * instead of passing for an older release.
 */
export function missingMetadataReleaseTag(err: unknown): string | null {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : '';
  const text = [e.message, e.stack, safeString(err)]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n');
  if (code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' && !MISSING_CHANNEL_FILE_RE.test(text)) return null;
  const match = /\/releases\/download\/(v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)\/[^/\s]+\.yml/i.exec(text);
  return match ? match[1] : null;
}

/**
 * Compare two app versions: >0 when `a` is newer, <0 when older, 0 when equal.
 * A leading "v" is ignored, the dotted numbers compare numerically, and a
 * pre-release sorts before its release (1.5.0-beta.1 < 1.5.0).
 */
export function compareAppVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const bare = version.trim().replace(/^v/i, '');
    const dash = bare.indexOf('-');
    return {
      parts: (dash === -1 ? bare : bare.slice(0, dash)).split('.').map((n) => parseInt(n, 10) || 0),
      pre: dash === -1 ? '' : bare.slice(dash + 1),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  // Both pre-releases of the same version: beta.2 < beta.10.
  const order = pa.pre.localeCompare(pb.pre, 'en', { numeric: true });
  return order === 0 ? 0 : order < 0 ? -1 : 1;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode HTML entities in a single pass, so `&amp;lt;` becomes the text
 * `&lt;` and is never decoded a second time into `<`.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      const valid =
        Number.isFinite(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Release notes as plain text.
 *
 * GitHub's releases feed delivers notes as HTML. The renderer shows them as a
 * React text node and never as markup, so the tags are dropped here: what is
 * left can't execute or load anything however the notes were written.
 * Accepts the string form and electron-updater's `fullChangelog` array form;
 * anything else yields ''.
 */
export function releaseNotesToText(notes: unknown, maxLength = 4000): string {
  let html: string;
  if (typeof notes === 'string') {
    html = notes;
  } else if (Array.isArray(notes)) {
    html = notes
      .map((item) => {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as {
          version?: unknown;
          note?: unknown;
        };
        const version = typeof entry.version === 'string' ? `<p>v${entry.version}</p>` : '';
        const note = typeof entry.note === 'string' ? entry.note : '';
        return version + note;
      })
      .join('\n\n');
  } else {
    return '';
  }

  const text = decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|h[1-6]|li|ul|ol|pre|blockquote|tr|table)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.length > maxLength ? text.slice(0, Math.max(0, maxLength - 1)) + '…' : text;
}

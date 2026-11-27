/**
 * The sing-box core upgrade's Electron-free half (audit P0-6, D27-D29): the
 * GitHub release lookup and the validated-version ceiling, a download that
 * must match GitHub's SHA-256 whichever source serves it, extraction, the new
 * binary's version and config check, and a swap that keeps the previous core.
 *
 * main.ts keeps the orchestration (stages, disconnecting, the backup record,
 * IPC) and the config generation. No electron import, like
 * app-updater-format.ts, so plain Node can test this from
 * dist-electron\core-upgrade.js.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import tls from 'tls';
import crypto from 'crypto';
import { execFile, spawn, ChildProcess } from 'child_process';

const USER_AGENT = 'AwesomeProxy';

// ==================== Versions ====================

/** Compare two dotted numeric versions. Returns >0 if a>b, <0 if a<b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The newest core line this app version has been validated with (D29). The
 * config generator still emits options that later cores drop (sing-box
 * removes `download_detour` in 1.16 and the TUN `stack` option in 1.17), so a
 * newer core is only installed after the user confirms.
 */
export const MAX_VALIDATED_CORE = '1.14';

/** True for a readable version at or below the MAX_VALIDATED_CORE line (any 1.14.x, or older). */
export function isValidatedCoreVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]*)?$/.exec(String(version ?? '').trim());
  if (!match) return false;
  const [maxMajor, maxMinor] = MAX_VALIDATED_CORE.split('.').map(Number);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < maxMajor || (major === maxMajor && minor <= maxMinor);
}

// ==================== Release metadata ====================

export interface CoreRelease {
  /** Version without the leading v, e.g. "1.14.4". */
  latest: string;
  tag: string;
  /** The plain windows-amd64 zip; null when the release has none. */
  downloadUrl: string | null;
  /** Lower-case hex from the asset's `digest`; null when GitHub published none. */
  sha256: string | null;
  /** The asset's size in bytes, when GitHub lists one. */
  size: number | null;
  notes: string;
  hasUpdate: boolean;
  /** Within MAX_VALIDATED_CORE. */
  validated: boolean;
}

// The plain build: not windows-amd64v3, not the legacy Windows 7 one.
const WINDOWS_AMD64_ASSET_RE = /-windows-amd64\.zip$/;
const SHA256_DIGEST_RE = /^sha256:([0-9a-f]{64})$/i;

/**
 * Read GitHub's `releases/latest` JSON. GitHub publishes a SHA-256 `digest`
 * for every release asset (since 2025-06); that digest, not the download
 * source, is what decides whether a file may be installed (D28).
 */
export function parseCoreRelease(json: any, current: string): CoreRelease {
  const tag = typeof json?.tag_name === 'string' ? json.tag_name : '';
  const latest = tag.replace(/^v/, '');
  const assets: any[] = Array.isArray(json?.assets) ? json.assets : [];
  const asset = assets.find((a) => typeof a?.name === 'string' && WINDOWS_AMD64_ASSET_RE.test(a.name));
  const digest = typeof asset?.digest === 'string' ? SHA256_DIGEST_RE.exec(asset.digest.trim()) : null;
  const url = asset?.browser_download_url;
  return {
    latest,
    tag,
    downloadUrl: typeof url === 'string' && url ? url : null,
    sha256: digest ? digest[1].toLowerCase() : null,
    size: Number.isSafeInteger(asset?.size) && asset.size > 0 ? asset.size : null,
    notes: typeof json?.body === 'string' ? json.body : '',
    hasUpdate: latest ? compareVersions(latest, current) > 0 : false,
    validated: isValidatedCoreVersion(latest),
  };
}

// ==================== GitHub API ====================

// A release JSON is tens of kilobytes; anything near this is not GitHub's API.
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSON_REDIRECTS = 3;

interface TextResponse {
  statusCode: number;
  location?: string;
  body: string;
}

/**
 * One https GET. With a proxyPort it opens a tunnel with `CONNECT host:443` on
 * 127.0.0.1:<proxyPort> (the running core's mixed inbound) and runs TLS over
 * it with the real host name, so the certificate is still GitHub's.
 */
function httpsGetText(url: string, proxyPort: number | null, timeoutMs: number): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new Error(`Refusing a non-https URL (${target.protocol})`));
      return;
    }
    const host = target.hostname;
    const port = Number(target.port) || 443;

    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (err: Error | null, value?: TextResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* already gone */
        }
      }
      if (err) reject(err);
      else resolve(value as TextResponse);
    };
    // An idle timeout, like the old request's socket timeout: restarted on
    // every step and every chunk, so a slow but moving response (the release
    // JSON is a few hundred kilobytes) still completes, and a stalled one
    // fails after timeoutMs.
    const onIdle = () => finish(new Error('GitHub API request timed out'));
    let timer = setTimeout(onIdle, timeoutMs);
    const touch = () => {
      clearTimeout(timer);
      if (!settled) timer = setTimeout(onIdle, timeoutMs);
    };

    const sendRequest = (tunnel: tls.TLSSocket | null) => {
      const req = https.request(
        {
          host,
          port,
          path: target.pathname + target.search,
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
          // Direct: a fresh connection each time, so nothing pooled on an
          // earlier route is reused. Tunnelled: the TLS socket opened above.
          ...(tunnel ? { createConnection: () => tunnel } : { agent: false }),
        },
        (res) => {
          touch();
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            res.resume();
            finish(null, { statusCode, location: res.headers.location, body: '' });
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            touch();
            total += chunk.length;
            if (total > MAX_JSON_BYTES) {
              finish(new Error('GitHub API response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => finish(null, { statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
          res.on('error', (err) => finish(err));
          res.on('close', () => {
            if (!res.complete) finish(new Error('The connection closed before the GitHub API response was complete'));
          });
        }
      );
      cleanups.push(() => req.destroy());
      req.on('error', (err) => finish(err));
      req.end();
    };

    if (!proxyPort) {
      sendRequest(null);
      return;
    }

    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, 'User-Agent': USER_AGENT },
    });
    cleanups.push(() => connectReq.destroy());
    connectReq.on('connect', (res, socket, head) => {
      touch();
      cleanups.push(() => socket.destroy());
      if (res.statusCode !== 200) {
        finish(new Error(`The local proxy (127.0.0.1:${proxyPort}) refused the tunnel to ${host}: HTTP ${res.statusCode}`));
        return;
      }
      if (head && head.length) socket.unshift(head);
      const tunnel = tls.connect({ socket, servername: host });
      cleanups.push(() => tunnel.destroy());
      tunnel.on('error', (err) => finish(err));
      tunnel.once('secureConnect', touch);
      sendRequest(tunnel);
    });
    connectReq.on('error', (err) =>
      finish(new Error(`Could not reach the local proxy (127.0.0.1:${proxyPort}): ${err.message}`))
    );
    connectReq.end();
  });
}

/**
 * GET a GitHub API URL and parse the JSON. Through the running core when a
 * proxyPort is given, else direct, like the app updater's routing (D27). There
 * is no fallback between the two routes: a failure on the chosen one is the
 * answer. Follows up to 3 redirects (https only). timeoutMs is how long a
 * request may go without progress.
 */
export async function fetchJson(
  url: string,
  options: { proxyPort?: number | null; timeoutMs?: number } = {}
): Promise<any> {
  const proxyPort = options.proxyPort ?? null;
  const timeoutMs = options.timeoutMs ?? 20000;
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const res = await httpsGetText(current, proxyPort, timeoutMs);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.location) {
      if (redirects >= MAX_JSON_REDIRECTS) throw new Error('GitHub API: too many redirects');
      current = new URL(res.location, current).href;
      continue;
    }
    if (res.statusCode !== 200) throw new Error(`GitHub API returned HTTP ${res.statusCode}`);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error('GitHub API returned something that is not JSON');
    }
  }
}

// ==================== Verified download ====================

/** No source served the file GitHub's digest describes (D28). */
export class CoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreIntegrityError';
  }
}

export interface VerifiedDownloadOptions {
  /** Hex SHA-256 the file must have (any case). */
  sha256: string;
  /** Exact size in bytes from GitHub; a source that sends more is cut off. */
  size?: number | null;
  /** 0..1 for the source currently downloading. */
  onProgress?: (fraction: number) => void;
  /** Idle timeout per source in ms. */
  timeoutMs?: number;
}

const MAX_DOWNLOAD_REDIRECTS = 6;

/** An error that means "this source served the wrong bytes", not "it couldn't be reached". */
function wrongBytes(message: string): Error {
  return Object.assign(new Error(message), { wrongBytes: true });
}

function sourceLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Stream one source into destPath while hashing it. Resolves the SHA-256 of
 * what was written; the file is always closed before this settles, so the
 * caller can delete it or let the next source overwrite it.
 */
function downloadHashed(
  url: string,
  destPath: string,
  opts: { size: number | null; onProgress?: (fraction: number) => void; timeoutMs: number },
  redirects = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_DOWNLOAD_REDIRECTS) {
      reject(new Error('Too many redirects'));
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
    if (!mod) {
      reject(new Error(`Unsupported protocol ${parsed.protocol}`));
      return;
    }

    let fd: number | null = null;
    let settled = false;
    const settle = (err: Error | null, digest?: string) => {
      if (settled) return;
      settled = true;
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
      }
      if (err) reject(err);
      else resolve(digest as string);
    };

    const req = mod.get(parsed, { timeout: opts.timeoutMs, headers: { 'User-Agent': USER_AGENT } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        // Handed over to the next hop; this request settles nothing more.
        settled = true;
        let next: string;
        try {
          next = new URL(res.headers.location, parsed).href;
        } catch {
          reject(new Error('Invalid redirect'));
          return;
        }
        downloadHashed(next, destPath, opts, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        settle(new Error(`HTTP ${status}`));
        return;
      }
      try {
        // Synchronous writes keep "closed before settled" simple; the chunks
        // are small and the zip is a few tens of megabytes.
        fd = fs.openSync(destPath, 'w');
      } catch (err: any) {
        res.destroy();
        settle(err);
        return;
      }
      const hash = crypto.createHash('sha256');
      const total = opts.size ?? (Number(res.headers['content-length']) || 0);
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (opts.size !== null && received > opts.size) {
          res.destroy();
          settle(wrongBytes(`sent more than the ${opts.size} bytes GitHub lists`));
          return;
        }
        try {
          fs.writeSync(fd as number, chunk);
        } catch (err: any) {
          res.destroy();
          settle(err);
          return;
        }
        hash.update(chunk);
        if (opts.onProgress && total > 0) opts.onProgress(Math.min(1, received / total));
      });
      res.on('end', () => {
        if (opts.size !== null && received !== opts.size) {
          settle(new Error(`the download ended early (${received} of ${opts.size} bytes)`));
          return;
        }
        settle(null, hash.digest('hex'));
      });
      res.on('error', (err) => settle(err));
      res.on('close', () => {
        if (!res.complete) settle(new Error('the connection closed mid-download'));
      });
    });
    req.on('error', (err) => settle(err));
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
  });
}

/**
 * Download one file from the first source that serves the right bytes (D28).
 * The sources (GitHub, then mirrors) are transport only: each is hashed while
 * it streams to destPath and cut off once it sends more than `size`. A wrong
 * file is deleted and the next source is tried. Resolves once destPath holds
 * exactly the bytes GitHub's digest describes. Otherwise it throws a
 * CoreIntegrityError when any source served wrong bytes (the message lists
 * every source), else the last source's network error, and destPath is gone.
 */
export async function downloadVerified(
  urls: string[],
  destPath: string,
  options: VerifiedDownloadOptions
): Promise<void> {
  const expected = String(options.sha256 || '').toLowerCase();
  // Fail closed: without a digest there is nothing to verify against.
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('A SHA-256 digest is required to download the core.');
  const size = Number.isSafeInteger(options.size) && (options.size as number) > 0 ? (options.size as number) : null;
  const timeoutMs = options.timeoutMs ?? 60000;
  const problems: string[] = [];
  let wrongSources = 0;
  let lastError: Error | null = null;

  for (const url of urls) {
    let digest: string | null = null;
    try {
      digest = await downloadHashed(url, destPath, { size, onProgress: options.onProgress, timeoutMs });
    } catch (err: any) {
      if (err?.wrongBytes) wrongSources++;
      else lastError = err;
      problems.push(`${sourceLabel(url)}: ${err?.message ?? err}`);
    }
    if (digest === expected) return;
    if (digest !== null) {
      wrongSources++;
      problems.push(`${sourceLabel(url)}: SHA-256 ${digest} does not match`);
    }
    try {
      fs.rmSync(destPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  if (wrongSources > 0) {
    throw new CoreIntegrityError(`No source served the file GitHub's SHA-256 describes (${problems.join('; ')})`);
  }
  throw lastError ?? new Error('No download source');
}

/** SHA-256 of a file, lower-case hex. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// ==================== Archive ====================

/** Extract a .zip archive using PowerShell's Expand-Archive (built into Windows). */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const cmd = `Expand-Archive -Path ${q(zipPath)} -DestinationPath ${q(destDir)} -Force`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      (err, _stdout, stderr) => {
        if (err) reject(new Error('Extract failed: ' + (stderr || err.message)));
        else resolve();
      }
    );
  });
}

/** Recursively locate a file by name (case-insensitive) within a directory. */
export function findFileRecursive(dir: string, name: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

// ==================== The new binary ====================

/** `<exe> version` → "1.14.4", or null when it can't be run or read. */
export function readCoreVersion(exe: string, timeoutMs = 60000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, ['version'], { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const match = /sing-box version (\S+)/.exec(String(stdout));
      resolve(match ? match[1] : null);
    });
  });
}

// Enough for any rejection message; a runaway output can't grow without bound.
const MAX_CHECK_OUTPUT = 64 * 1024;

/**
 * Feed a config to `<exe> check -c stdin` (D30). `check` only parses and
 * validates; it never starts inbounds, opens a TUN adapter or connects, which
 * is why TUN and Split configs may be checked without elevation. Resolves
 * `{ ok, output }` (stdout and stderr together); kills the process on timeout.
 */
export function checkConfigWithCore(
  exe: string,
  config: unknown,
  timeoutMs = 60000
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // cwd next to the binary: anything check might write lands there, and
      // main deletes the extract folder afterwards.
      child = spawn(exe, ['check', '-c', 'stdin'], {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      resolve({ ok: false, output: err?.message ?? String(err) });
      return;
    }
    let output = '';
    let settled = false;
    const collect = (data: Buffer) => {
      if (output.length < MAX_CHECK_OUTPUT) output += data.toString();
    };
    const finish = (ok: boolean, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: (note ? `${note}\n${output}` : output).trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false, `sing-box check did not finish within ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => finish(false, err.message));
    child.on('close', (code) => finish(code === 0));
    // The core may exit (rejecting the config) before it has read everything.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(config));
  });
}

// ==================== Swap and restore ====================

function replaceError(err: any): Error {
  const perm = err?.code === 'EPERM' || err?.code === 'EACCES';
  return Object.assign(
    new Error(
      'Failed to replace binary: ' + (err?.message ?? err) + (perm ? ' — try restarting the app as administrator.' : '')
    ),
    { code: err?.code }
  );
}

/**
 * Install newExe at target and keep the core it replaces at backup (D32).
 * Nothing is touched unless newExe is there. If copying the new core fails
 * after the backup was made, the old core is copied back before rethrowing.
 */
export function swapCoreBinary(newExe: string, target: string, backup: string): void {
  try {
    if (!fs.statSync(newExe).isFile()) throw new Error(`not a file: ${newExe}`);
  } catch (err: any) {
    throw replaceError(err);
  }
  let backedUp = false;
  try {
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, backup);
      backedUp = true;
    }
    fs.copyFileSync(newExe, target);
  } catch (err: any) {
    if (backedUp) {
      try {
        fs.copyFileSync(backup, target);
      } catch {
        /* ignore */
      }
    }
    // backupReplaced: the backup now holds the core that is still installed,
    // so whatever described the old backup is out of date.
    throw Object.assign(replaceError(err), { backupReplaced: backedUp });
  }
}

/** Put the kept core back at target, then delete the backup (D32). The backup is only ever copied, never run. */
export function restoreCoreBackup(target: string, backup: string): void {
  if (!fs.existsSync(backup)) throw new Error('There is no previous core to restore.');
  try {
    fs.copyFileSync(backup, target);
  } catch (err: any) {
    throw replaceError(err);
  }
  fs.rmSync(backup, { force: true });
}

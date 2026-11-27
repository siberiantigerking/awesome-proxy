/**
 * sing-box version probe — shared by electron/main.ts and server/index.js.
 *
 * The config generator has to know which core will run its output, because
 * some fields only exist in newer cores and older ones reject them outright
 * ("json: unknown field ..."). Asking the binary means one `sing-box version`
 * per answer, so the result is cached.
 *
 * Why this module exists (compat review R1 / E3.5):
 *   - Both backends used to cache a FAILED probe as '0.0.0' for the rest of the
 *     session. One slow first run (a Defender scan of a freshly installed or
 *     upgraded binary is the usual cause) then pinned every later config to the
 *     oldest supported surface until restart. A null result is therefore never
 *     cached here: the next caller simply probes again.
 *   - Concurrent callers (the startup prime, Settings → About and the first
 *     config:generate all fire at once) share one in-flight probe instead of
 *     spawning the binary several times.
 *   - `exec` goes through the shell with `windowsHide: true` on purpose: E3.5
 *     measured that a Defender scan then blocks cmd.exe, not the Node main loop,
 *     and no console window flashes up.
 */

'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION_RE = /sing-box version (\S+)/;

const PROBE_FAILED_MESSAGE =
  'Could not read the sing-box version; generating the config for the oldest supported core this time.';

/**
 * Run `<binaryPath> version` and resolve the version string, or null.
 *
 * An ABSOLUTE path that doesn't exist resolves null without spawning anything.
 * A bare name (the web server falls back to `sing-box` on PATH) is left to the
 * shell to resolve.
 */
function probeCoreVersion(binaryPath) {
  return new Promise((resolve) => {
    if (!binaryPath || (path.isAbsolute(binaryPath) && !fs.existsSync(binaryPath))) {
      resolve(null);
      return;
    }
    exec('"' + binaryPath + '" version', { windowsHide: true }, (error, stdout) => {
      const match = !error && typeof stdout === 'string' ? stdout.match(VERSION_RE) : null;
      resolve(match ? match[1] : null);
    });
  });
}

/**
 * Cached, de-duplicated version probe.
 *
 * get()        → the version string, or null when the probe failed. Success is
 *                cached until invalidate(); null never is.
 * invalidate() → forget the cached version (the binary was replaced). A probe
 *                already in flight for the old binary can't repopulate the cache.
 */
function createCoreVersionProbe({ getBinaryPath, log, probe = probeCoreVersion }) {
  let cached = null;
  let inFlight = null;
  // Bumped by invalidate(), so a probe started before the binary changed can't
  // write its (now stale) answer into the cache.
  let generation = 0;

  function get() {
    if (cached !== null) return Promise.resolve(cached);
    if (inFlight) return inFlight;

    const startedIn = generation;
    const run = Promise.resolve()
      .then(() => probe(getBinaryPath()))
      .catch(() => null)
      .then((version) => {
        const result = typeof version === 'string' && version ? version : null;
        if (inFlight === run) inFlight = null;
        if (result === null) {
          if (typeof log === 'function') log(PROBE_FAILED_MESSAGE);
        } else if (startedIn === generation) {
          cached = result;
        }
        return result;
      });
    inFlight = run;
    return run;
  }

  function invalidate() {
    cached = null;
    inFlight = null;
    generation += 1;
  }

  return { get, invalidate };
}

module.exports = {
  probeCoreVersion,
  createCoreVersionProbe,
  PROBE_FAILED_MESSAGE,
};

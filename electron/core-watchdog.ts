/**
 * Restart policy for a sing-box core that stopped on its own (audit P1-5, D18):
 * restart after 1 s, then 3 s, then 10 s, and give up once 3 restarts happened
 * within a rolling minute. A core that keeps dying right after it starts would
 * otherwise be respawned forever while the user's traffic goes nowhere.
 *
 * Pure on purpose (no Electron import, like app-updater-format.ts), so plain
 * Node can check the policy from dist-electron without starting an Electron app.
 * main.ts owns the timer, the flags that suppress a restart and what the user
 * sees.
 */

/** Delay before the 1st, 2nd and 3rd restart of a crash streak. */
export const WATCHDOG_DELAYS_MS = [1000, 3000, 10000];

/** Restarts older than this no longer count against the cap. */
export const WATCHDOG_WINDOW_MS = 60000;

/**
 * Plan the next restart after an unexpected exit at `now`.
 *
 * `history` holds the times of the restarts planned so far (same clock as
 * `now`). Returns the pruned history with this restart added, and its delay;
 * `delayMs` is null when the cap is reached (give up), and the history is then
 * returned without a new entry.
 */
export function planWatchdogRestart(
  history: readonly number[],
  now: number
): { history: number[]; delayMs: number | null } {
  const recent = history.filter((at) => now - at < WATCHDOG_WINDOW_MS);
  if (recent.length >= WATCHDOG_DELAYS_MS.length) {
    return { history: recent, delayMs: null };
  }
  return { history: [...recent, now], delayMs: WATCHDOG_DELAYS_MS[recent.length] };
}

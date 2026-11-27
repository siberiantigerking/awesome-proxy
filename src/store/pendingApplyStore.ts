import { create } from 'zustand';
import { useNodeStore } from './nodeStore';

interface PendingApplyStore {
  /**
   * True when something the generated config is built from (a setting, or the
   * node list after a subscription refresh) changed while a core was live, so
   * the running core is still on the older config.
   */
  pending: boolean;
  setPending: (pending: boolean) => void;
}

/**
 * Backs the "Reconnect to apply" banners on Settings, the Dashboard and the
 * Subscriptions page. It lives here rather than in Settings because a
 * subscription refresh, from the Subscriptions page or the scheduler, raises
 * it too, and because it has to stay up when the user changes pages. connect()
 * and a node switch's restart clear it: the core they start runs the current
 * nodes and settings. They clear it where they read those, not once the core
 * is up, so a change made during the start raises it again. Not persisted: it
 * describes this session only.
 */
export const usePendingApplyStore = create<PendingApplyStore>((set) => ({
  pending: false,
  setPending: (pending) => set({ pending }),
}));

/**
 * Starts of the core this renderer has under way (whileStarting): connect(),
 * and the restart switchNode falls back to. Main pushes no status for a start
 * it was asked for until the core reports it started, so the renderer shows
 * 'disconnected' all through connect(), and during a restart from the old
 * core's exit on. A change made in that window is missing from the config
 * being started, so it still has to be flagged (Round 2 follow-up N1).
 */
let startsInProgress = 0;

/**
 * Run `run`, a start of the core whose config is already decided, and count
 * it as live for changeIsLive() until it settles.
 */
export async function whileStarting<T>(run: () => Promise<T>): Promise<T> {
  startsInProgress += 1;
  try {
    return await run();
  } finally {
    startsInProgress -= 1;
  }
}

/**
 * True while a core runs, and also while main's watchdog is bringing back one
 * that stopped unexpectedly ('connecting'). That restart reuses the config
 * from the last connect, so a change made meanwhile has to be applied too, or
 * the UI would show it in force once the old config is running again.
 */
export function hasLiveConnection(): boolean {
  const status = useNodeStore.getState().connectionStatus;
  return status === 'connected' || status === 'connecting';
}

/**
 * True when a change made now may be missing from the config of a core that
 * is live or being started: hasLiveConnection(), or a start under way. For
 * flagging only. What restarts the core keeps asking hasLiveConnection():
 * during a start there is no core to restart yet.
 */
export function changeIsLive(): boolean {
  return hasLiveConnection() || startsInProgress > 0;
}

/**
 * Raise the flag if a core is live or being started. With none, there is
 * nothing to flag: the next connect generates its config from the current
 * state anyway.
 */
export function markPendingIfLive(): void {
  if (changeIsLive()) usePendingApplyStore.getState().setPending(true);
}

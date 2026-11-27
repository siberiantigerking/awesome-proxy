import type { Subscription, ProxyNode } from '../types';
import { fetchSubscription, updateAllSubscriptions } from './subscription-fetcher';

/**
 * Subscription refreshes: the auto-update scheduler, and the single and
 * "Update All" refreshes the Subscriptions page runs.
 *
 * The scheduler runs a single low-frequency interval (default every 60s) and,
 * on each tick, refreshes any enabled subscription whose `updateInterval`
 * (hours) has elapsed since its `lastUpdate`. All three paths hand a
 * subscription's fetched nodes to `replaceSubscriptionNodes`, which merges them
 * into the list in place (subscription-merge.ts): its nodes stay where they
 * are and keep their ids, so the selection survives a refresh (audit P0-3).
 *
 * This module is intentionally framework-agnostic: it pulls current state via
 * getters and pushes results via callbacks, so it doesn't couple to the
 * Zustand stores directly. subscription-refresh.ts binds the callbacks to them.
 */

/** Where a refresh delivers its result. */
export interface RefreshHooks {
  /**
   * Merge a subscription's freshly fetched nodes into the node list. The store
   * reads the list at that moment rather than one captured before the fetch,
   * so a manual refresh and a scheduler tick can't overwrite each other.
   */
  replaceSubscriptionNodes: (subscriptionId: string, nodes: ProxyNode[]) => void;
  onSubscriptionUpdated: (id: string, nodeCount: number) => void;
  onError?: (id: string, error: string) => void;
}

export interface AutoUpdateHooks extends RefreshHooks {
  getSubscriptions: () => Subscription[];
}

const HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000; // check once per minute

/**
 * Backoff for subscriptions that failed, kept in memory only.
 *
 * Without this a failing subscription is retried every single minute, forever:
 * `lastUpdate` is only stamped on success, so `isDue` keeps returning true. A
 * subscription whose provider returns 403, or that yields zero nodes, then
 * re-fetches on every tick for as long as the app is open. That hammers the
 * provider.
 *
 * Module scope rather than inside the scheduler closure so that editing a
 * subscription can clear its penalty — see resetSubscriptionBackoff. Deliberately
 * not persisted: a restart is a reasonable "try again now".
 */
const retryAfter = new Map<string, number>();
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Forget a subscription's failure backoff so the next tick reconsiders it.
 *
 * Call this when the subscription's definition changes — in particular when its
 * URL is edited. A user fixing a broken URL expects the fix to take effect now,
 * not up to 30 minutes later, and without this the corrected subscription would
 * still be serving out the old penalty.
 */
export function resetSubscriptionBackoff(id: string): void {
  retryAfter.delete(id);
}

function isDue(sub: Subscription, now: number): boolean {
  if (!sub.enabled || !sub.autoUpdate) return false;
  const interval = Math.max(1, sub.updateInterval || 12) * HOUR_MS;
  if (!sub.lastUpdate) return true; // never updated → update now
  return now - sub.lastUpdate >= interval;
}

/**
 * Refresh a single subscription and merge its nodes into the node list.
 * Exported so the scheduler and the Update button share identical behaviour.
 * A failed or empty fetch leaves the subscription's nodes as they are.
 */
export async function refreshSubscription(sub: Subscription, hooks: RefreshHooks): Promise<void> {
  const result = await fetchSubscription(sub);
  if (result.error) {
    hooks.onError?.(sub.id, result.error);
    return;
  }
  if (result.nodes.length === 0) return;

  hooks.replaceSubscriptionNodes(sub.id, result.nodes);
  hooks.onSubscriptionUpdated(sub.id, result.nodes.length);
}

/**
 * "Update All": fetch every enabled subscription in parallel, then merge each
 * one on its own.
 *
 * This used to rebuild the whole list from the manual nodes plus the fetches
 * that succeeded. A provider that was briefly unreachable or returned nothing
 * lost all its nodes, so did every disabled subscription and every node whose
 * subscription had been deleted, and no error was shown (audit P0-3). Now a
 * subscription that fails or returns no nodes keeps its nodes, a disabled one
 * isn't fetched and keeps them too, and manual and orphaned nodes are never
 * touched.
 *
 * Returns one message per subscription that was not updated, naming it, in
 * the order of `subscriptions`. They are returned for the page to show, not
 * passed to onError.
 */
export async function refreshAllSubscriptions(
  subscriptions: Subscription[],
  hooks: RefreshHooks
): Promise<string[]> {
  const results = await updateAllSubscriptions(subscriptions);
  const errors: string[] = [];
  for (const sub of subscriptions) {
    const result = results.get(sub.id);
    if (!result) continue; // disabled: not fetched
    if (result.error || result.nodes.length === 0) {
      errors.push(`${sub.name}: ${result.error || 'returned no nodes'}`);
      continue;
    }
    hooks.replaceSubscriptionNodes(sub.id, result.nodes);
    hooks.onSubscriptionUpdated(sub.id, result.nodes.length);
  }
  return errors;
}

/**
 * Start the auto-update scheduler. Returns a stop function.
 */
export function startAutoUpdateScheduler(hooks: AutoUpdateHooks): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // avoid overlapping runs
    running = true;
    try {
      const now = Date.now();
      const due = hooks
        .getSubscriptions()
        .filter((s) => isDue(s, now) && (retryAfter.get(s.id) ?? 0) <= now);
      for (const sub of due) {
        // Sequential to avoid hammering the network and to keep node order stable.
        const before = hooks.getSubscriptions().find((s) => s.id === sub.id)?.lastUpdate;
        await refreshSubscription(sub, hooks);
        const after = hooks.getSubscriptions().find((s) => s.id === sub.id)?.lastUpdate;
        if (after && after !== before) {
          retryAfter.delete(sub.id);
        } else {
          retryAfter.set(sub.id, Date.now() + FAILURE_BACKOFF_MS);
        }
      }
    } finally {
      running = false;
    }
  };

  // Run an initial check shortly after startup (lets stores hydrate first).
  const startupTimer = setTimeout(tick, 5000);
  const interval = setInterval(tick, CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}

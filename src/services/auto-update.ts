import type { Subscription, ProxyNode } from '../types';
import { fetchSubscription } from './subscription-fetcher';

/**
 * Auto-update scheduler for subscriptions.
 *
 * Runs a single low-frequency interval (default every 60s) and, on each tick,
 * refreshes any enabled subscription whose `updateInterval` (hours) has elapsed
 * since its `lastUpdate`. Refreshed nodes replace the old nodes for that
 * subscription, mirroring the manual "Update" button behaviour.
 *
 * The scheduler is intentionally framework-agnostic: it pulls current state via
 * getters and pushes results via callbacks so it can be driven from App.tsx
 * without coupling to the Zustand stores directly.
 */

export interface AutoUpdateHooks {
  getSubscriptions: () => Subscription[];
  getNodes: () => ProxyNode[];
  setNodes: (nodes: ProxyNode[]) => void;
  onSubscriptionUpdated: (id: string, nodeCount: number) => void;
  onError?: (id: string, error: string) => void;
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
 * provider and, because a successful refresh calls setNodes, it also re-renders
 * the UI repeatedly.
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
 * Refresh a single subscription and swap its nodes into the node list.
 * Exported so the scheduler and any manual trigger share identical behaviour.
 */
export async function refreshSubscription(sub: Subscription, hooks: AutoUpdateHooks): Promise<void> {
  const result = await fetchSubscription(sub);
  if (result.error) {
    hooks.onError?.(sub.id, result.error);
    return;
  }
  if (result.nodes.length === 0) return;

  const others = hooks.getNodes().filter((n) => n.subscriptionId !== sub.id);
  hooks.setNodes([...others, ...result.nodes]);
  hooks.onSubscriptionUpdated(sub.id, result.nodes.length);
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

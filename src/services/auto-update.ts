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
      const due = hooks.getSubscriptions().filter((s) => isDue(s, now));
      for (const sub of due) {
        // Sequential to avoid hammering the network and to keep node order stable.
        await refreshSubscription(sub, hooks);
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

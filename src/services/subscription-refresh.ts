import { useNodeStore } from '../store/nodeStore';
import { markPendingIfLive } from '../store/pendingApplyStore';
import { useSubscriptionStore } from '../store/subscriptionStore';
import type { AutoUpdateHooks } from './auto-update';

/**
 * The refresh hooks of auto-update.ts, bound to the app's stores. The Update
 * button, Update All and the auto-update scheduler all use these, so the
 * three refresh in exactly the same way.
 *
 * - Nodes go through nodeStore.replaceSubscriptionNodes, which merges them in
 *   place into the list as it is at that moment. Each caller used to rebuild
 *   the list from a copy taken before its fetch, so a manual refresh and a
 *   scheduler tick could overwrite each other.
 * - A refresh that changed the list while a core is live raises the
 *   "Reconnect to apply" flag. The running core keeps the nodes it started
 *   with, and saying nothing let the UI and the core silently diverge
 *   (audit P0-3).
 * - Success stamps the subscription's lastUpdate and nodeCount. The scheduler
 *   also reads lastUpdate to tell a success from a failure for its backoff.
 */
export function storeRefreshHooks(onError?: (id: string, error: string) => void): AutoUpdateHooks {
  return {
    getSubscriptions: () => useSubscriptionStore.getState().subscriptions,
    replaceSubscriptionNodes: (subscriptionId, nodes) => {
      if (useNodeStore.getState().replaceSubscriptionNodes(subscriptionId, nodes)) markPendingIfLive();
    },
    onSubscriptionUpdated: (id, nodeCount) =>
      useSubscriptionStore.getState().updateSubscription(id, {
        lastUpdate: Date.now(),
        nodeCount,
      }),
    onError,
  };
}

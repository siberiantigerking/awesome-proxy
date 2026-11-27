import React from 'react';
import { useNodeStore } from '../store/nodeStore';
import { usePendingApplyStore } from '../store/pendingApplyStore';
import { applyPendingChanges } from '../services/connection';

/**
 * The "Reconnect to apply" banner on the Dashboard and the Subscriptions page.
 * Settings shows its own, with the same text, next to the settings that raise
 * it.
 *
 * A subscription refresh that changes the node list while connected raises
 * the flag too (subscription-refresh.ts). The running core keeps the nodes it
 * started with until it restarts, so these pages say so instead of showing a
 * node list the core isn't using. Shown only while a core is live, as in
 * Settings.
 */
export default function PendingApplyBanner() {
  const pending = usePendingApplyStore((s) => s.pending);
  const connectionStatus = useNodeStore((s) => s.connectionStatus);
  const [applying, setApplying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const live = connectionStatus === 'connected' || connectionStatus === 'connecting';

  const applyNow = async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await applyPendingChanges();
      if (res && !res.ok && !res.elevating && res.error) setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected connection error.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      {applying && <p className="text-[11px] text-primary-400">Reconnecting…</p>}
      {/* Outside the live condition: a failed reconnect leaves the app
          disconnected, and the reason must stay readable. */}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
          <p className="text-[11px] text-red-300">{error}</p>
        </div>
      )}
      {pending && live && !applying && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-yellow-300">
            The running connection is still using the previous settings or node list. Reconnect
            to apply the changes.
          </p>
          <button onClick={applyNow} className="btn-secondary text-[11px] px-2 py-1 shrink-0">
            Apply now
          </button>
        </div>
      )}
    </>
  );
}

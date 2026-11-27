import React, { useState } from 'react';
import { Plus, Trash2, RefreshCw, ExternalLink, Clock, Package, AlertCircle, Edit3, QrCode } from '../components/Icons';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { useNodeStore } from '../store/nodeStore';
import { refreshAllSubscriptions, refreshSubscription, resetSubscriptionBackoff } from '../services/auto-update';
import { storeRefreshHooks } from '../services/subscription-refresh';
import { useConfirm } from '../components/ConfirmDialog';
import PendingApplyBanner from '../components/PendingApplyBanner';
// Type only: the dialog itself is loaded on demand (openShare).
import type { ShareTarget } from '../components/ShareDialog';
import type { Subscription } from '../types';

export default function SubscriptionManager() {
  const { subscriptions, addSubscription, updateSubscription, removeSubscription, saveToStore } = useSubscriptionStore();
  const { nodes, removeNodesBySubscription } = useNodeStore();
  // null = closed, 'add' = new subscription, otherwise the subscription being edited.
  const [dialog, setDialog] = useState<'add' | Subscription | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  // One "<subscription>: <reason>" line per subscription that was not updated.
  const [updateErrors, setUpdateErrors] = useState<string[]>([]);
  const { confirm, confirmDialog } = useConfirm();
  // The share dialog, once its chunk has loaded, and what it shares.
  const [share, setShare] = useState<{
    Dialog: React.ComponentType<{ target: ShareTarget; onClose: () => void }>;
    target: ShareTarget;
  } | null>(null);
  // Its own line: a share dialog that failed to load is not an update error.
  const [shareError, setShareError] = useState<string | null>(null);

  // Lazy, as on the Nodes page: the dialog's chunk holds the QR encoder and
  // its library, so the main chunk only carries the button.
  const openShare = async (target: ShareTarget) => {
    setShareError(null);
    try {
      const { default: Dialog } = await import('../components/ShareDialog');
      setShare({ Dialog, target });
    } catch {
      setShareError('Could not open the share dialog.');
    }
  };

  // Remove a subscription and all proxy nodes that were imported from it.
  //
  // Uses the in-app confirm rather than window.confirm: the native dialog blocks
  // the renderer and leaves text inputs unable to take focus afterwards, which is
  // what made the Add Subscription name field impossible to type in after a
  // delete. See components/ConfirmDialog.
  const handleRemoveSubscription = async (sub: Subscription) => {
    const count = nodes.filter((n) => n.subscriptionId === sub.id).length;
    const ok = await confirm({
      title: 'Delete subscription',
      message:
        count > 0
          ? `Delete "${sub.name}" and the ${count} node${count !== 1 ? 's' : ''} imported from it?`
          : `Delete "${sub.name}"?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    removeNodesBySubscription(sub.id);
    removeSubscription(sub.id);
    // Drop the scheduler's in-memory penalty for this id along with it, so a
    // deleted subscription leaves nothing behind that a re-added one could inherit.
    resetSubscriptionBackoff(sub.id);
  };

  /**
   * Save an edit to an existing subscription.
   *
   * A changed URL points at a different provider, so the nodes currently held
   * under this subscription no longer came from it. Refresh immediately so the
   * node list matches what the user just entered instead of leaving stale nodes
   * attributed to the new URL, and clear any failure backoff so a URL corrected
   * to fix a broken subscription takes effect now rather than up to 30 minutes
   * later.
   */
  const handleSaveEdit = async (original: Subscription, updated: Subscription) => {
    const urlChanged = original.url !== updated.url;
    updateSubscription(original.id, {
      name: updated.name,
      url: updated.url,
      autoUpdate: updated.autoUpdate,
      updateInterval: updated.updateInterval,
      ...(urlChanged ? { lastUpdate: undefined } : {}),
    });
    setDialog(null);
    if (urlChanged) {
      resetSubscriptionBackoff(original.id);
      await handleUpdateOne({ ...original, ...updated });
    }
  };

  // The scheduler's refresh path: the nodes are merged in place, so they keep
  // their positions and ids and the selection survives, and a failed fetch
  // leaves them as they are.
  const handleUpdateOne = async (sub: Subscription) => {
    setUpdatingId(sub.id);
    setUpdateErrors([]);
    try {
      // Surface failures instead of silently doing nothing. Previously a failed
      // fetch (e.g. HTTP 403 from the provider's WAF) left the UI unchanged
      // with no explanation, which looked like "the import just doesn't work".
      await refreshSubscription(
        sub,
        storeRefreshHooks((_, error) => setUpdateErrors([`${sub.name}: ${error}`]))
      );
    } catch (err: any) {
      console.error('Failed to update subscription:', err);
      setUpdateErrors([`${sub.name}: ${err?.message || 'Failed to update subscription.'}`]);
    } finally {
      setUpdatingId(null);
    }
  };

  // Each subscription is merged on its own. One that fails, returns nothing or
  // is disabled keeps its nodes and is listed in the banner; this used to drop
  // them all without a word (audit P0-3).
  const handleUpdateAll = async () => {
    setUpdatingAll(true);
    setUpdateErrors([]);
    try {
      setUpdateErrors(await refreshAllSubscriptions(subscriptions, storeRefreshHooks()));
    } catch (err) {
      console.error('Failed to update all subscriptions:', err);
    } finally {
      setUpdatingAll(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-surface-100">Subscriptions</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleUpdateAll}
            disabled={updatingAll || subscriptions.length === 0}
            className="btn-secondary flex items-center gap-1.5"
          >
            <RefreshCw size={14} className={updatingAll ? 'animate-spin' : ''} />
            {updatingAll ? 'Updating...' : 'Update All'}
          </button>
          <button onClick={() => setDialog('add')} className="btn-primary flex items-center gap-1.5">
            <Plus size={14} />
            Add Subscription
          </button>
        </div>
      </div>

      <p className="text-xs text-surface-500">
        Manage subscription URLs to automatically import proxy nodes. Supports base64 and Clash YAML formats.
      </p>

      {updateErrors.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-red-300">Not updated — their nodes were kept:</p>
            {updateErrors.map((message, i) => (
              <p key={i} className="text-sm text-red-300 break-words">{message}</p>
            ))}
          </div>
          <button
            onClick={() => setUpdateErrors([])}
            className="text-red-400 hover:text-red-200 text-xs shrink-0"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {shareError && <p className="text-[11px] text-red-300">{shareError}</p>}

      <PendingApplyBanner />

      {/* Subscription List */}
      <div className="space-y-3">
        {subscriptions.length === 0 ? (
          <div className="text-center py-16">
            <Package size={48} className="mx-auto text-surface-700 mb-3" />
            <p className="text-surface-500">No subscriptions</p>
            <p className="text-xs text-surface-600 mt-1">Add a subscription URL to import proxy nodes automatically</p>
          </div>
        ) : (
          subscriptions.map((sub) => (
            <div key={sub.id} className="card flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-surface-200 truncate">{sub.name}</h3>
                  {!sub.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-700 text-surface-500">Disabled</span>
                  )}
                </div>
                <p className="text-xs text-surface-500 truncate mt-1 font-mono">{sub.url}</p>
                <div className="flex items-center gap-4 mt-2 text-[11px] text-surface-500">
                  <span className="flex items-center gap-1">
                    <Package size={12} />
                    {sub.nodeCount} nodes
                  </span>
                  {sub.lastUpdate && (
                    <span className="flex items-center gap-1">
                      <Clock size={12} />
                      Updated {new Date(sub.lastUpdate).toLocaleString()}
                    </span>
                  )}
                  {sub.autoUpdate && (
                    <span className="flex items-center gap-1">
                      <RefreshCw size={12} />
                      Auto every {sub.updateInterval}h
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleUpdateOne(sub)}
                  disabled={updatingId === sub.id}
                  className="btn-icon"
                  title="Update"
                >
                  <RefreshCw size={14} className={updatingId === sub.id ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => setDialog(sub)}
                  className="btn-icon"
                  title="Edit name, URL and update schedule"
                >
                  <Edit3 size={14} />
                </button>
                <button
                  onClick={() => void openShare({ kind: 'subscription', subscription: sub })}
                  className="btn-icon"
                  title="Share URL"
                >
                  <QrCode size={14} />
                </button>
                <button
                  onClick={() => updateSubscription(sub.id, { enabled: !sub.enabled })}
                  className="btn-icon"
                  title={sub.enabled ? 'Disable' : 'Enable'}
                >
                  <div className={`w-3 h-3 rounded-full ${sub.enabled ? 'bg-green-500' : 'bg-surface-600'}`} />
                </button>
                <button
                  onClick={() => handleRemoveSubscription(sub)}
                  className="btn-icon hover:!text-red-400"
                  title="Delete subscription and its nodes"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add / Edit Dialog */}
      {dialog && (
        <SubscriptionDialog
          // Remount when switching between subscriptions so the fields reflect
          // whichever one was opened rather than keeping the previous values.
          key={dialog === 'add' ? 'add' : dialog.id}
          existing={dialog === 'add' ? null : dialog}
          onClose={() => setDialog(null)}
          onSave={(sub) => {
            if (dialog === 'add') {
              addSubscription(sub);
              setDialog(null);
            } else {
              void handleSaveEdit(dialog, sub);
            }
          }}
        />
      )}

      {/* Share Dialog */}
      {share && <share.Dialog target={share.target} onClose={() => setShare(null)} />}

      {confirmDialog}
    </div>
  );
}

function SubscriptionDialog({
  existing,
  onClose,
  onSave,
}: {
  /** The subscription being edited, or null when adding a new one. */
  existing: Subscription | null;
  onClose: () => void;
  onSave: (sub: Subscription) => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [autoUpdate, setAutoUpdate] = useState(existing?.autoUpdate ?? true);
  const [updateInterval, setUpdateInterval] = useState(existing?.updateInterval ?? 12);

  const isEdit = existing !== null;
  const urlChanged = isEdit && url.trim() !== existing.url;

  const handleSubmit = () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) return;
    onSave({
      // Editing keeps the identity and history; only the fields on this form move.
      id: existing?.id ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 11),
      name: trimmedName,
      url: trimmedUrl,
      nodeCount: existing?.nodeCount ?? 0,
      lastUpdate: existing?.lastUpdate,
      autoUpdate,
      updateInterval,
      enabled: existing?.enabled ?? true,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-800 border border-surface-700 rounded-xl w-[460px]" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-surface-700">
          <h3 className="text-base font-semibold">{isEdit ? 'Edit Subscription' : 'Add Subscription'}</h3>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-surface-400 mb-1 block">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Subscription"
              className="input-field"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs text-surface-400 mb-1 block">Subscription URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/api/v1/client/subscribe?token=..."
              className="input-field font-mono text-xs"
            />
            {urlChanged && (
              <p className="text-[11px] text-yellow-300 mt-1.5">
                The URL changed, so this subscription's existing nodes came from the old one. Saving
                refreshes it now and replaces those nodes.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="auto-update"
              checked={autoUpdate}
              onChange={(e) => setAutoUpdate(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <label htmlFor="auto-update" className="text-sm text-surface-300">Auto-update</label>
          </div>

          {autoUpdate && (
            <div>
              <label className="text-xs text-surface-400 mb-1 block">Update Interval (hours)</label>
              <input
                type="number"
                value={updateInterval}
                onChange={(e) => setUpdateInterval(parseInt(e.target.value) || 12)}
                min={1}
                className="input-field"
              />
            </div>
          )}
        </div>

        <div className="p-4 border-t border-surface-700 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !url.trim()}
            className="btn-primary"
          >
            {isEdit ? 'Save Changes' : 'Add Subscription'}
          </button>
        </div>
      </div>
    </div>
  );
}
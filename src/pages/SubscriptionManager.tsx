import React, { useState } from 'react';
import { Plus, Trash2, RefreshCw, ExternalLink, Clock, Package, AlertCircle } from '../components/Icons';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { useNodeStore } from '../store/nodeStore';
import { fetchSubscription, updateAllSubscriptions } from '../services/subscription-fetcher';
import type { Subscription } from '../types';

export default function SubscriptionManager() {
  const { subscriptions, addSubscription, updateSubscription, removeSubscription, saveToStore } = useSubscriptionStore();
  const { nodes, setNodes, removeNodesBySubscription } = useNodeStore();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  // Remove a subscription and all proxy nodes that were imported from it.
  const handleRemoveSubscription = (sub: Subscription) => {
    const count = nodes.filter((n) => n.subscriptionId === sub.id).length;
    const ok = window.confirm(
      count > 0
        ? `Delete subscription "${sub.name}" and its ${count} node${count !== 1 ? 's' : ''}?`
        : `Delete subscription "${sub.name}"?`
    );
    if (!ok) return;
    removeNodesBySubscription(sub.id);
    removeSubscription(sub.id);
  };

  const handleUpdateOne = async (sub: Subscription) => {
    setUpdatingId(sub.id);
    try {
      const result = await fetchSubscription(sub);
      if (result.nodes.length > 0) {
        // Remove old nodes from this subscription and add new ones
        const otherNodes = nodes.filter((n) => n.subscriptionId !== sub.id);
        setNodes([...otherNodes, ...result.nodes]);
        updateSubscription(sub.id, {
          lastUpdate: Date.now(),
          nodeCount: result.nodes.length,
        });
      }
    } catch (err) {
      console.error('Failed to update subscription:', err);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleUpdateAll = async () => {
    setUpdatingAll(true);
    try {
      const results = await updateAllSubscriptions(subscriptions);
      let allOtherNodes = nodes.filter((n) => !n.subscriptionId);
      let allNewNodes = [...allOtherNodes];

      for (const [subId, result] of results.entries()) {
        if (result.nodes.length > 0) {
          allNewNodes = [...allNewNodes, ...result.nodes];
          updateSubscription(subId, {
            lastUpdate: Date.now(),
            nodeCount: result.nodes.length,
          });
        }
      }

      setNodes(allNewNodes);
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
          <button onClick={() => setShowAddDialog(true)} className="btn-primary flex items-center gap-1.5">
            <Plus size={14} />
            Add Subscription
          </button>
        </div>
      </div>

      <p className="text-xs text-surface-500">
        Manage subscription URLs to automatically import proxy nodes. Supports base64 and Clash YAML formats.
      </p>

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

      {/* Add Dialog */}
      {showAddDialog && (
        <AddSubscriptionDialog
          onClose={() => setShowAddDialog(false)}
          onAdd={(sub) => {
            addSubscription(sub);
            setShowAddDialog(false);
          }}
        />
      )}
    </div>
  );
}

function AddSubscriptionDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (sub: Subscription) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateInterval, setUpdateInterval] = useState(12);

  const handleSubmit = () => {
    if (!name || !url) return;
    onAdd({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
      name,
      url,
      nodeCount: 0,
      autoUpdate,
      updateInterval,
      enabled: true,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-800 border border-surface-700 rounded-xl w-[460px]" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-surface-700">
          <h3 className="text-base font-semibold">Add Subscription</h3>
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
            disabled={!name || !url}
            className="btn-primary"
          >
            Add Subscription
          </button>
        </div>
      </div>
    </div>
  );
}
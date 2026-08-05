import React, { useState, useMemo } from 'react';
import {
  Plus, Search, Trash2, Edit3, Copy, Zap, CheckSquare, Square,
  Clipboard, MoreVertical, ChevronDown, ChevronUp, ExternalLink, QrCode
} from '../components/Icons';
import { useNodeStore } from '../store/nodeStore';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { useSettingsStore } from '../store/settingsStore';
import { parseProxyLink, parseProxyLinks, getCountryFlag, getProtocolColor } from '../services/node-parser';
import type { ProxyNode, ProxyProtocol } from '../types';

export default function NodeManager() {
  const { nodes, selectedIndex, addNode, removeNode, removeNodes, updateNode, setSelectedIndex, updateLatency, moveNodeToTop } = useNodeStore();
  const settings = useSettingsStore((s) => s.settings);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [editingNode, setEditingNode] = useState<ProxyNode | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testProgress, setTestProgress] = useState({ done: 0, total: 0 });
  // Group filter: 'all', 'manual' (nodes not from any subscription), or a
  // subscription id. Nodes are grouped by which subscription imported them.
  const [activeGroup, setActiveGroup] = useState<string>('all');

  const subscriptions = useSubscriptionStore((s) => s.subscriptions);

  // Build the group list with live counts. "Manual" only appears when there
  // are hand-added nodes, and a subscription only appears once it has nodes,
  // so the bar stays quiet for simple setups.
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    let manual = 0;
    for (const n of nodes) {
      if (n.subscriptionId) counts.set(n.subscriptionId, (counts.get(n.subscriptionId) || 0) + 1);
      else manual++;
    }
    const list: { id: string; label: string; count: number }[] = [
      { id: 'all', label: 'All', count: nodes.length },
    ];
    for (const sub of subscriptions) {
      const c = counts.get(sub.id) || 0;
      if (c > 0) list.push({ id: sub.id, label: sub.name, count: c });
    }
    // Nodes whose subscription was deleted but that somehow survived.
    const orphaned = nodes.filter(
      (n) => n.subscriptionId && !subscriptions.some((s) => s.id === n.subscriptionId)
    ).length;
    if (orphaned > 0) list.push({ id: '__orphaned', label: 'Other', count: orphaned });
    if (manual > 0) list.push({ id: 'manual', label: 'Manual', count: manual });
    return list;
  }, [nodes, subscriptions]);

  // Filter nodes by group, then by search text.
  const filteredNodes = useMemo(() => {
    let list = nodes;

    if (activeGroup === 'manual') {
      list = list.filter((n) => !n.subscriptionId);
    } else if (activeGroup === '__orphaned') {
      list = list.filter(
        (n) => n.subscriptionId && !subscriptions.some((s) => s.id === n.subscriptionId)
      );
    } else if (activeGroup !== 'all') {
      list = list.filter((n) => n.subscriptionId === activeGroup);
    }

    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.server.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q)
    );
  }, [nodes, searchQuery, activeGroup, subscriptions]);

  // If the active group disappears (subscription deleted / all its nodes gone),
  // fall back to "All" so the list never looks mysteriously empty.
  React.useEffect(() => {
    if (activeGroup !== 'all' && !groups.some((g) => g.id === activeGroup)) {
      setActiveGroup('all');
    }
  }, [groups, activeGroup]);

  const markTesting = (id: string, testing: boolean) => {
    setTestingIds((prev) => {
      const next = new Set(prev);
      if (testing) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleTestLatency = async (node: ProxyNode) => {
    if (!window.api) return;
    markTesting(node.id, true);
    try {
      const latency = await window.api.network.testLatency(node.server, node.port);
      updateLatency(node.id, latency);
    } finally {
      markTesting(node.id, false);
    }
  };

  // Test every node, running a bounded number of probes in parallel so large
  // node lists finish quickly without opening hundreds of sockets at once.
  const handleTestAllLatency = async () => {
    if (!window.api || testingAll) return;
    const targets = nodes;
    if (targets.length === 0) return;

    const CONCURRENCY = 8;
    let index = 0;
    let completed = 0;

    setTestingAll(true);
    setTestProgress({ done: 0, total: targets.length });
    setTestingIds(new Set(targets.map((n) => n.id)));

    const worker = async () => {
      while (index < targets.length) {
        const node = targets[index++];
        try {
          const latency = await window.api.network.testLatency(node.server, node.port);
          updateLatency(node.id, latency);
        } catch {
          updateLatency(node.id, -1);
        } finally {
          markTesting(node.id, false);
          completed += 1;
          setTestProgress({ done: completed, total: targets.length });
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker())
      );
    } finally {
      setTestingAll(false);
      setTestingIds(new Set());
    }
  };

  const handleSelectNode = (index: number) => {
    setSelectedIndex(index);
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    removeNodes(Array.from(selectedIds));
    setSelectedIds(new Set());
  };

  const handleCopyNodeLink = (node: ProxyNode) => {
    let link = '';
    switch (node.type) {
      case 'vmess':
        link = 'vmess://' + btoa(JSON.stringify({
          v: '2', ps: node.name, add: node.server, port: node.port,
          id: node.uuid, aid: node.alterId || 0, scy: node.security || 'auto',
          net: node.transportType || 'tcp', tls: node.tls ? 'tls' : '',
          sni: node.sni || '', host: node.transportHost || '', path: node.transportPath || '',
        }));
        break;
      case 'vless': {
        const params = new URLSearchParams();
        params.set('type', node.transportType || 'tcp');
        if (node.realityPublicKey) {
          params.set('security', 'reality');
          params.set('pbk', node.realityPublicKey);
          if (node.realityShortId) params.set('sid', node.realityShortId);
        } else {
          params.set('security', node.tls ? 'tls' : 'none');
        }
        if (node.sni) params.set('sni', node.sni);
        if (node.fingerprint) params.set('fp', node.fingerprint);
        if (node.flow) params.set('flow', node.flow);
        if (node.transportPath) params.set('path', node.transportPath);
        link = `vless://${node.uuid}@${node.server}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
        break;
      }
      case 'trojan':
        link = `trojan://${node.password}@${node.server}:${node.port}?sni=${node.sni || ''}#${encodeURIComponent(node.name)}`;
        break;
      case 'shadowsocks':
        link = `ss://${btoa(`${node.method}:${node.password}`)}@${node.server}:${node.port}#${encodeURIComponent(node.name)}`;
        break;
      case 'hysteria2':
        link = `hysteria2://${node.password}@${node.server}:${node.port}?sni=${node.sni || ''}#${encodeURIComponent(node.name)}`;
        break;
    }
    navigator.clipboard.writeText(link);
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-surface-100">Proxy Nodes</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowImportDialog(true)} className="btn-secondary flex items-center gap-1.5">
            <Clipboard size={14} />
            Import
          </button>
          <button onClick={() => setShowAddDialog(true)} className="btn-primary flex items-center gap-1.5">
            <Plus size={14} />
            Add Node
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
          <input
            type="text"
            placeholder="Search nodes by name, server, or protocol..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input-field pl-9"
          />
        </div>
        <button
          onClick={handleTestAllLatency}
          disabled={testingAll || nodes.length === 0}
          className="btn-secondary flex items-center gap-1.5"
        >
          <Zap size={14} className={testingAll ? 'animate-pulse' : ''} />
          {testingAll ? `Testing ${testProgress.done}/${testProgress.total}...` : 'Test All'}
        </button>
        {selectedIds.size > 0 && (
          <button onClick={handleDeleteSelected} className="btn-danger flex items-center gap-1.5">
            <Trash2 size={14} />
            Delete ({selectedIds.size})
          </button>
        )}
      </div>

      {/* Subscription groups. Only shown when there's more than one group to
          choose from, so a single-subscription setup stays uncluttered. */}
      {groups.length > 2 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => setActiveGroup(g.id)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                activeGroup === g.id
                  ? 'bg-primary-600/20 border-primary-500/40 text-primary-600 dark:text-primary-300'
                  : 'bg-surface-100 border-surface-200 text-surface-600 hover:bg-surface-200 dark:bg-surface-800/50 dark:border-surface-700/40 dark:text-surface-400 dark:hover:bg-surface-800'
              }`}
              title={g.id === 'manual' ? 'Nodes added manually (not from a subscription)' : g.label}
            >
              <span className="truncate max-w-[160px] inline-block align-bottom">{g.label}</span>
              <span className="ml-1.5 opacity-60">{g.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Node Count */}
      <div className="text-xs text-surface-500">
        {filteredNodes.length} of {nodes.length} nodes
        {activeGroup !== 'all' && ' (filtered by group)'}
      </div>

      {/* Node List */}
      <div className="flex-1 overflow-y-auto space-y-1.5">
        {filteredNodes.length === 0 ? (
          <div className="text-center py-16">
            <Globe size={48} className="mx-auto text-surface-700 mb-3" />
            <p className="text-surface-500">No proxy nodes</p>
            <p className="text-xs text-surface-600 mt-1">Click "Add Node" or "Import" to get started</p>
          </div>
        ) : (
          filteredNodes.map((node) => {
            const originalIndex = nodes.findIndex((n) => n.id === node.id);
            const isSelected = originalIndex === selectedIndex;
            const isChecked = selectedIds.has(node.id);

            return (
              <div
                key={node.id}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-primary-600/10 border-primary-500/30'
                    : 'bg-surface-800/50 border-surface-700/30 hover:bg-surface-800'
                }`}
                onDoubleClick={() => handleSelectNode(originalIndex)}
              >
                {/* Checkbox */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggleSelect(node.id); }}
                  className="text-surface-500 hover:text-surface-300"
                >
                  {isChecked ? <CheckSquare size={16} /> : <Square size={16} />}
                </button>

                {/* Flag */}
                <span className="text-lg w-6 text-center">{getCountryFlag(node.country)}</span>

                {/* Protocol Badge */}
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold min-w-[52px] text-center"
                  style={{
                    backgroundColor: getProtocolColor(node.type) + '20',
                    color: getProtocolColor(node.type),
                  }}
                >
                  {node.type.toUpperCase()}
                </span>

                {/* Name & Server */}
                <div className="flex-1 min-w-0" onClick={() => handleSelectNode(originalIndex)}>
                  <p className={`text-sm truncate ${isSelected ? 'text-primary-300' : 'text-surface-200'}`}>
                    {node.name}
                  </p>
                  <p className="text-[11px] text-surface-500 truncate">
                    {node.server}:{node.port}
                  </p>
                </div>

                {/* Latency */}
                <div className="w-16 text-right">
                  {testingIds.has(node.id) ? (
                    <span className="inline-block w-3.5 h-3.5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin align-middle" />
                  ) : node.latency !== undefined && node.latency >= 0 ? (
                    <span
                      className={`text-xs font-mono ${
                        node.latency < 100
                          ? 'text-green-400'
                          : node.latency < 300
                          ? 'text-yellow-400'
                          : 'text-red-400'
                      }`}
                    >
                      {node.latency}ms
                    </span>
                  ) : node.latency === -1 ? (
                    <span className="text-xs font-mono text-red-400">timeout</span>
                  ) : (
                    <span className="text-xs text-surface-600">-</span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); moveNodeToTop(node.id); }}
                    className="btn-icon"
                    title="Move to top"
                    disabled={originalIndex === 0}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleTestLatency(node); }}
                    className="btn-icon"
                    title="Test latency"
                    disabled={testingIds.has(node.id)}
                  >
                    <Zap size={14} className={testingIds.has(node.id) ? 'animate-pulse' : ''} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCopyNodeLink(node); }}
                    className="btn-icon"
                    title="Copy link"
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingNode(node); }}
                    className="btn-icon"
                    title="Edit"
                  >
                    <Edit3 size={14} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeNode(node.id); }}
                    className="btn-icon hover:!text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Import Dialog */}
      {showImportDialog && (
        <ImportDialog
          onClose={() => setShowImportDialog(false)}
          onImport={(newNodes) => {
            newNodes.forEach((n) => addNode(n));
            setShowImportDialog(false);
          }}
        />
      )}

      {/* Add/Edit Node Dialog */}
      {(showAddDialog || editingNode) && (
        <NodeFormDialog
          node={editingNode}
          onClose={() => { setShowAddDialog(false); setEditingNode(null); }}
          onSave={(nodeData) => {
            if (editingNode) {
              updateNode(editingNode.id, nodeData);
            } else {
              const newNode: ProxyNode = {
                type: 'vmess',
                name: '',
                server: '',
                port: 443,
                ...nodeData,
                id: generateId(),
              };
              addNode(newNode);
            }
            setShowAddDialog(false);
            setEditingNode(null);
          }}
        />
      )}
    </div>
  );
}

// ==================== Import Dialog ====================

function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (nodes: ProxyNode[]) => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ProxyNode[]>([]);
  const [qrStatus, setQrStatus] = useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleParse = () => {
    const nodes = parseProxyLinks(text);
    setPreview(nodes);
    if (nodes.length === 0) setQrStatus('No valid proxy links found in the text.');
  };

  // Decode a QR code and feed the decoded link(s) into the parse flow.
  const ingestDecoded = (decoded: string | null, sourceLabel: string) => {
    if (!decoded) {
      setQrStatus(`No QR code found in the ${sourceLabel}.`);
      return;
    }
    const nodes = parseProxyLinks(decoded);
    if (nodes.length === 0) {
      setQrStatus('QR decoded, but it did not contain a valid proxy link.');
      return;
    }
    // Append decoded text so the user can see/edit it, and show the preview.
    setText((prev) => (prev ? prev + '\n' + decoded : decoded));
    setPreview((prev) => [...prev, ...nodes]);
    setQrStatus(`Found ${nodes.length} node${nodes.length !== 1 ? 's' : ''} from QR (${sourceLabel}).`);
  };

  const handleScanFile = async (file: File) => {
    setQrStatus('Scanning image...');
    try {
      const { decodeQrFromFile } = await import('../services/qr-scanner');
      ingestDecoded(await decodeQrFromFile(file), 'image');
    } catch (err: any) {
      setQrStatus(err?.message || 'Failed to scan image.');
    }
  };

  const handleScanClipboard = async () => {
    setQrStatus('Reading clipboard...');
    try {
      const { decodeQrFromClipboard } = await import('../services/qr-scanner');
      ingestDecoded(await decodeQrFromClipboard(), 'clipboard');
    } catch (err: any) {
      setQrStatus(err?.message || 'Failed to read clipboard image.');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-800 border border-surface-700 rounded-xl w-[520px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-surface-700">
          <h3 className="text-base font-semibold">Import Proxy Nodes</h3>
          <p className="text-xs text-surface-500 mt-1">
            Paste links (vmess://, vless://, trojan://, ss://, hysteria2://, tuic://, anytls://), a base64 subscription, or scan a QR code
          </p>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview([]); setQrStatus(null); }}
            placeholder="vmess://eyJ2IjoyLCJwcyI6Ii4uLiJ9&#10;vless://uuid@server:port&#10;trojan://password@server:port&#10;..."
            className="input-field h-32 resize-none font-mono text-xs"
          />

          {/* QR scan controls */}
          <div className="flex items-center gap-2 mt-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleScanFile(f);
                e.target.value = '';
              }}
            />
            <button onClick={() => fileInputRef.current?.click()} className="btn-secondary flex-1 flex items-center justify-center gap-1.5">
              <QrCode size={14} />
              Scan QR Image
            </button>
            <button onClick={handleScanClipboard} className="btn-secondary flex-1 flex items-center justify-center gap-1.5">
              <Clipboard size={14} />
              QR from Clipboard
            </button>
          </div>

          <button onClick={handleParse} className="btn-secondary w-full mt-2">
            Parse Links
          </button>

          {qrStatus && (
            <p className="text-xs text-surface-400 mt-2">{qrStatus}</p>
          )}

          {preview.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-green-400 mb-2">Found {preview.length} nodes:</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {preview.map((node, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs p-2 bg-surface-900/50 rounded">
                    <span>{getCountryFlag(node.country)}</span>
                    <span
                      className="px-1 py-0.5 rounded font-mono text-[9px]"
                      style={{ backgroundColor: getProtocolColor(node.type) + '20', color: getProtocolColor(node.type) }}
                    >
                      {node.type.toUpperCase()}
                    </span>
                    <span className="truncate text-surface-300">{node.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-surface-700 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => onImport(preview)}
            disabled={preview.length === 0}
            className="btn-primary"
          >
            Import {preview.length > 0 ? `(${preview.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== Node Form Dialog ====================

function NodeFormDialog({
  node,
  onClose,
  onSave,
}: {
  node: ProxyNode | null;
  onClose: () => void;
  onSave: (node: Partial<ProxyNode>) => void;
}) {
  const [form, setForm] = useState<Partial<ProxyNode>>(
    node || {
      type: 'vmess',
      name: '',
      server: '',
      port: 443,
      tls: true,
    }
  );

  const update = (field: string, value: any) => setForm((f) => ({ ...f, [field]: value }));

  const protocolOptions: { value: ProxyProtocol; label: string }[] = [
    { value: 'vmess', label: 'VMess' },
    { value: 'vless', label: 'VLess' },
    { value: 'trojan', label: 'Trojan' },
    { value: 'shadowsocks', label: 'Shadowsocks' },
    { value: 'hysteria2', label: 'Hysteria2' },
    { value: 'tuic', label: 'TUIC' },
    { value: 'anytls', label: 'AnyTLS' },
    { value: 'shadowtls', label: 'ShadowTLS (+ Shadowsocks)' },
    { value: 'wireguard', label: 'WireGuard' },
  ];

  // Per-protocol required-field validation so users get a clear reason a node
  // can't be saved (previously the button just silently disabled on missing
  // name/server, hiding missing UUID/password from the user).
  const validationError = (() => {
    if (!form.name?.trim()) return 'Name is required.';
    if (!form.server?.trim()) return 'Server address is required.';
    if (!form.port || form.port < 1 || form.port > 65535) return 'Port must be between 1 and 65535.';
    if ((form.type === 'vmess' || form.type === 'vless' || form.type === 'tuic') && !form.uuid?.trim()) {
      return 'UUID is required for this protocol.';
    }
    if (
      (form.type === 'trojan' ||
        form.type === 'hysteria2' ||
        form.type === 'shadowsocks' ||
        form.type === 'anytls' ||
        form.type === 'shadowtls') &&
      !form.password?.trim()
    ) {
      return form.type === 'shadowtls'
        ? 'Password is required (the inner Shadowsocks password).'
        : 'Password is required for this protocol.';
    }
    if (form.type === 'vless' && form.realityPublicKey && !form.sni?.trim()) {
      return 'Reality requires an SNI (server name).';
    }
    if (form.type === 'wireguard') {
      if (!form.privateKey?.trim()) return 'WireGuard requires a private key.';
      if (!form.peerPublicKey?.trim()) return 'WireGuard requires the peer public key.';
      if (!form.localAddress?.length) return 'WireGuard requires a local address (e.g. 10.0.0.2/32).';
    }
    return null;
  })();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-800 border border-surface-700 rounded-xl w-[480px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-surface-700">
          <h3 className="text-base font-semibold">{node ? 'Edit Node' : 'Add Node'}</h3>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {/* Protocol */}
          <div>
            <label className="text-xs text-surface-400 mb-1 block">Protocol</label>
            <select
              value={form.type}
              onChange={(e) => update('type', e.target.value)}
              className="input-field"
            >
              {protocolOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div>
            <label className="text-xs text-surface-400 mb-1 block">Name</label>
            <input
              type="text"
              value={form.name || ''}
              onChange={(e) => update('name', e.target.value)}
              placeholder="My Proxy Node"
              className="input-field"
            />
          </div>

          {/* Server & Port */}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="text-xs text-surface-400 mb-1 block">Server</label>
              <input
                type="text"
                value={form.server || ''}
                onChange={(e) => update('server', e.target.value)}
                placeholder="example.com"
                className="input-field"
              />
            </div>
            <div>
              <label className="text-xs text-surface-400 mb-1 block">Port</label>
              <input
                type="number"
                value={form.port || ''}
                onChange={(e) => update('port', parseInt(e.target.value) || 0)}
                placeholder="443"
                className="input-field"
              />
            </div>
          </div>

          {/* UUID / Password */}
          {(form.type === 'vmess' || form.type === 'vless' || form.type === 'tuic') && (
            <div>
              <label className="text-xs text-surface-400 mb-1 block">UUID</label>
              <input
                type="text"
                value={form.uuid || ''}
                onChange={(e) => update('uuid', e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="input-field font-mono"
              />
            </div>
          )}

          {(form.type === 'trojan' ||
            form.type === 'hysteria2' ||
            form.type === 'tuic' ||
            form.type === 'anytls') && (
            <div>
              <label className="text-xs text-surface-400 mb-1 block">Password</label>
              <input
                type="text"
                value={form.password || ''}
                onChange={(e) => update('password', e.target.value)}
                placeholder="password"
                className="input-field"
              />
            </div>
          )}

          {/* Hysteria2 specific: obfuscation, port hopping, bandwidth */}
          {form.type === 'hysteria2' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">Obfuscation</label>
                  <select
                    value={form.obfsType || ''}
                    onChange={(e) => update('obfsType', e.target.value || undefined)}
                    className="input-field"
                  >
                    <option value="">none</option>
                    <option value="salamander">salamander</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">Obfs Password</label>
                  <input
                    type="text"
                    value={form.obfsPassword || ''}
                    onChange={(e) => update('obfsPassword', e.target.value)}
                    placeholder={form.obfsType ? 'obfs password' : 'select obfuscation first'}
                    disabled={!form.obfsType}
                    className="input-field disabled:opacity-50"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">
                  Port Hopping Range (overrides Port)
                </label>
                <input
                  type="text"
                  value={(form.serverPorts || []).join(',')}
                  onChange={(e) =>
                    update(
                      'serverPorts',
                      e.target.value
                        .split(',')
                        .map((s) => s.trim().replace('-', ':'))
                        .filter(Boolean)
                    )
                  }
                  placeholder="1000:2000,3000:4000"
                  className="input-field font-mono text-xs"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">Hop Interval</label>
                  <input
                    type="text"
                    value={form.hopInterval || ''}
                    onChange={(e) => update('hopInterval', e.target.value || undefined)}
                    placeholder="30s"
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">Up (Mbps)</label>
                  <input
                    type="number"
                    value={form.upMbps ?? ''}
                    onChange={(e) => update('upMbps', parseInt(e.target.value) || undefined)}
                    placeholder="auto"
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">Down (Mbps)</label>
                  <input
                    type="number"
                    value={form.downMbps ?? ''}
                    onChange={(e) => update('downMbps', parseInt(e.target.value) || undefined)}
                    placeholder="auto"
                    className="input-field"
                  />
                </div>
              </div>
              <p className="text-[11px] text-surface-500">
                Leave bandwidth empty to use BBR congestion control. Obfuscation must match the
                server, or the connection will be silently refused.
              </p>
            </>
          )}

          {/* TUIC specific (QUIC tuning) */}
          {form.type === 'tuic' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-surface-400 mb-1 block">Congestion Control</label>
                <select
                  value={form.congestionControl || ''}
                  onChange={(e) => update('congestionControl', e.target.value || undefined)}
                  className="input-field"
                >
                  <option value="">default (cubic)</option>
                  <option value="cubic">cubic</option>
                  <option value="new_reno">new_reno</option>
                  <option value="bbr">bbr</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">UDP Relay Mode</label>
                <select
                  value={form.udpRelayMode || ''}
                  onChange={(e) => update('udpRelayMode', e.target.value || undefined)}
                  className="input-field"
                >
                  <option value="">default (native)</option>
                  <option value="native">native</option>
                  <option value="quic">quic</option>
                </select>
              </div>
            </div>
          )}

          {/* ShadowTLS: outer handshake settings + inner Shadowsocks credentials */}
          {form.type === 'shadowtls' && (
            <>
              <p className="text-[11px] text-surface-500">
                ShadowTLS wraps a Shadowsocks connection. Set the ShadowTLS handshake below and
                the inner Shadowsocks method/password underneath.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">ShadowTLS Version</label>
                  <select
                    value={form.shadowTlsVersion || 3}
                    onChange={(e) => update('shadowTlsVersion', parseInt(e.target.value))}
                    className="input-field"
                  >
                    <option value={1}>v1 (no password)</option>
                    <option value={2}>v2</option>
                    <option value={3}>v3</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">ShadowTLS Password</label>
                  <input
                    type="text"
                    value={form.shadowTlsPassword || ''}
                    onChange={(e) => update('shadowTlsPassword', e.target.value)}
                    placeholder={form.shadowTlsVersion === 1 ? 'not used in v1' : 'shadowtls password'}
                    disabled={form.shadowTlsVersion === 1}
                    className="input-field disabled:opacity-50"
                  />
                </div>
              </div>
            </>
          )}

          {/* WireGuard specific */}
          {form.type === 'wireguard' && (
            <>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">Private Key</label>
                <input
                  type="text"
                  value={form.privateKey || ''}
                  onChange={(e) => update('privateKey', e.target.value)}
                  placeholder="base64 private key"
                  className="input-field font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">Peer Public Key</label>
                <input
                  type="text"
                  value={form.peerPublicKey || ''}
                  onChange={(e) => update('peerPublicKey', e.target.value)}
                  placeholder="base64 public key"
                  className="input-field font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">
                  Local Address (comma-separated)
                </label>
                <input
                  type="text"
                  value={(form.localAddress || []).join(', ')}
                  onChange={(e) =>
                    update(
                      'localAddress',
                      e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    )
                  }
                  placeholder="10.0.0.2/32, fd00::2/128"
                  className="input-field font-mono text-xs"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">Pre-shared Key (optional)</label>
                  <input
                    type="text"
                    value={form.preSharedKey || ''}
                    onChange={(e) => update('preSharedKey', e.target.value)}
                    placeholder="optional"
                    className="input-field font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">MTU</label>
                  <input
                    type="number"
                    value={form.mtu ?? 1408}
                    onChange={(e) => update('mtu', parseInt(e.target.value) || undefined)}
                    className="input-field"
                  />
                </div>
              </div>
            </>
          )}

          {(form.type === 'shadowsocks' || form.type === 'shadowtls') && (
            <>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">Encryption Method</label>
                <select
                  value={form.method || 'aes-256-gcm'}
                  onChange={(e) => update('method', e.target.value)}
                  className="input-field"
                >
                  <option value="aes-256-gcm">aes-256-gcm</option>
                  <option value="aes-128-gcm">aes-128-gcm</option>
                  <option value="chacha20-poly1305">chacha20-poly1305</option>
                  <option value="chacha20-ietf-poly1305">chacha20-ietf-poly1305</option>
                  <option value="2022-blake3-aes-128-gcm">2022-blake3-aes-128-gcm</option>
                  <option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option>
                  <option value="2022-blake3-chacha20-poly1305">2022-blake3-chacha20-poly1305</option>
                  <option value="none">none</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">Password</label>
                <input
                  type="text"
                  value={form.password || ''}
                  onChange={(e) => update('password', e.target.value)}
                  placeholder="password"
                  className="input-field"
                />
              </div>
            </>
          )}

          {/* VMess specific */}
          {form.type === 'vmess' && (
            <div>
              <label className="text-xs text-surface-400 mb-1 block">AlterID</label>
              <input
                type="number"
                value={form.alterId ?? 0}
                onChange={(e) => update('alterId', parseInt(e.target.value) || 0)}
                className="input-field"
              />
            </div>
          )}

          {/* TLS */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="tls"
              checked={form.tls || false}
              onChange={(e) => update('tls', e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <label htmlFor="tls" className="text-sm text-surface-300">Enable TLS</label>
          </div>

          {form.tls && (
            <div>
              <label className="text-xs text-surface-400 mb-1 block">SNI (Server Name)</label>
              <input
                type="text"
                value={form.sni || ''}
                onChange={(e) => update('sni', e.target.value)}
                placeholder="example.com"
                className="input-field"
              />
            </div>
          )}

          {/* Reality (VLESS only) */}
          {form.type === 'vless' && form.tls && (
            <>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">
                  Reality Public Key <span className="text-surface-600">(leave empty for plain TLS)</span>
                </label>
                <input
                  type="text"
                  value={form.realityPublicKey || ''}
                  onChange={(e) => update('realityPublicKey', e.target.value)}
                  placeholder="pbk (base64 public key)"
                  className="input-field font-mono text-xs"
                />
              </div>
              {form.realityPublicKey && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-surface-400 mb-1 block">Reality Short ID</label>
                    <input
                      type="text"
                      value={form.realityShortId || ''}
                      onChange={(e) => update('realityShortId', e.target.value)}
                      placeholder="sid"
                      className="input-field font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-surface-400 mb-1 block">Fingerprint</label>
                    <select
                      value={form.fingerprint || 'chrome'}
                      onChange={(e) => update('fingerprint', e.target.value)}
                      className="input-field"
                    >
                      <option value="chrome">chrome</option>
                      <option value="firefox">firefox</option>
                      <option value="safari">safari</option>
                      <option value="edge">edge</option>
                      <option value="ios">ios</option>
                      <option value="android">android</option>
                      <option value="random">random</option>
                    </select>
                  </div>
                </div>
              )}
              {form.type === 'vless' && (
                <div>
                  <label className="text-xs text-surface-400 mb-1 block">Flow</label>
                  <select
                    value={form.flow || ''}
                    onChange={(e) => update('flow', e.target.value)}
                    className="input-field"
                  >
                    <option value="">none</option>
                    <option value="xtls-rprx-vision">xtls-rprx-vision</option>
                  </select>
                </div>
              )}
            </>
          )}

          {/* Transport */}
          <div>
            <label className="text-xs text-surface-400 mb-1 block">Transport</label>
            <select
              value={form.transportType || 'tcp'}
              onChange={(e) => update('transportType', e.target.value)}
              className="input-field"
            >
              <option value="tcp">TCP</option>
              <option value="ws">WebSocket</option>
              <option value="grpc">gRPC</option>
              <option value="http">HTTP/2</option>
            </select>
          </div>

          {form.transportType === 'ws' && (
            <div>
              <label className="text-xs text-surface-400 mb-1 block">WebSocket Path</label>
              <input
                type="text"
                value={form.transportPath || ''}
                onChange={(e) => update('transportPath', e.target.value)}
                placeholder="/path"
                className="input-field"
              />
            </div>
          )}
        </div>

        <div className="p-4 border-t border-surface-700 flex flex-col gap-2">
          {validationError && (
            <p className="text-xs text-red-400">{validationError}</p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button
              onClick={() => onSave(form)}
              disabled={!!validationError}
              className="btn-primary"
            >
              {node ? 'Save Changes' : 'Add Node'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function Globe({ size, className }: { size: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
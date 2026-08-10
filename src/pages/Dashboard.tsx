import React, { useState, useEffect } from 'react';
import { Power, Zap, ArrowUp, ArrowDown, RefreshCw, ChevronDown } from '../components/Icons';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { useNodeStore } from '../store/nodeStore';
import { useSettingsStore } from '../store/settingsStore';
import { getCountryFlag, getProtocolColor } from '../services/node-parser';
import { connect, disconnect, switchNode } from '../services/connection';
import type { ProxyNode } from '../types';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s';
  return formatBytes(bytesPerSec) + '/s';
}

export default function Dashboard() {
  const { nodes, selectedIndex, connectionStatus } = useNodeStore();
  const { traffic, settings } = useSettingsStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedNode = selectedIndex >= 0 && selectedIndex < nodes.length ? nodes[selectedIndex] : null;

  const handleConnect = async () => {
    if (!window.api) return;
    setIsConnecting(true);
    setError(null);
    try {
      if (connectionStatus === 'connected') {
        await disconnect();
      } else {
        const res = await connect();
        if (!res.ok && !res.elevating && res.error) {
          setError(res.error);
        }
      }
    } catch (err) {
      console.error('Connection error:', err);
      setError(err instanceof Error ? err.message : 'Unexpected connection error.');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleQuickSwitch = async (index: number) => {
    // Shared with the Nodes page so both paths actually move live traffic.
    const res = await switchNode(index);
    if (!res.ok && res.error) setError(res.error);
  };

  const chartData = traffic.history.map((d, i) => ({
    time: i,
    up: d.up,
    down: d.down,
  }));

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Error Banner */}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-start justify-between gap-3">
          <p className="text-sm text-red-300 break-words">{error}</p>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-200 text-xs shrink-0"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Connection Status Card */}
      <div className="card relative overflow-hidden">
        {/* Background glow effect */}
        <div
          className={`absolute inset-0 opacity-5 ${
            connectionStatus === 'connected'
              ? 'bg-green-500'
              : connectionStatus === 'connecting'
              ? 'bg-yellow-500'
              : 'bg-red-500'
          }`}
        />

        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Status Indicator */}
            <div
              className={`w-16 h-16 rounded-full flex items-center justify-center ${
                connectionStatus === 'connected'
                  ? 'bg-green-500/20'
                  : connectionStatus === 'connecting'
                  ? 'bg-yellow-500/20'
                  : 'bg-red-500/20'
              }`}
            >
              <div
                className={`w-3 h-3 rounded-full status-dot ${
                  connectionStatus === 'connected'
                    ? 'status-connected'
                    : connectionStatus === 'connecting'
                    ? 'status-connecting'
                    : 'status-disconnected'
                }`}
              />
            </div>

            <div>
              <h2 className="text-lg font-semibold">
                {connectionStatus === 'connected'
                  ? 'Connected'
                  : connectionStatus === 'connecting'
                  ? 'Connecting...'
                  : 'Disconnected'}
              </h2>
              {selectedNode ? (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-lg">{getCountryFlag(selectedNode.country)}</span>
                  <span className="text-sm text-surface-300">{selectedNode.name}</span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold"
                    style={{
                      backgroundColor: getProtocolColor(selectedNode.type) + '20',
                      color: getProtocolColor(selectedNode.type),
                    }}
                  >
                    {selectedNode.type.toUpperCase()}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-surface-500 mt-1">No node selected</p>
              )}
            </div>
          </div>

          {/* Connect Button */}
          <button
            onClick={handleConnect}
            disabled={isConnecting || nodes.length === 0}
            className={`px-6 py-3 rounded-xl font-medium transition-all duration-300 flex items-center gap-2 ${
              connectionStatus === 'connected'
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-primary-600 hover:bg-primary-700 text-white'
            } disabled:opacity-50 disabled:cursor-not-allowed active:scale-95`}
          >
            <Power size={18} />
            {isConnecting
              ? 'Connecting...'
              : connectionStatus === 'connected'
              ? 'Disconnect'
              : 'Connect'}
          </button>
        </div>
      </div>

      {/* Speed & Traffic */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-green-500/15 flex items-center justify-center">
            <ArrowDown size={18} className="text-green-400" />
          </div>
          <div>
            <p className="text-xs text-surface-500">Download</p>
            <p className="text-lg font-semibold text-green-400">{formatSpeed(traffic.downloadSpeed)}</p>
          </div>
        </div>

        <div className="card flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/15 flex items-center justify-center">
            <ArrowUp size={18} className="text-blue-400" />
          </div>
          <div>
            <p className="text-xs text-surface-500">Upload</p>
            <p className="text-lg font-semibold text-blue-400">{formatSpeed(traffic.uploadSpeed)}</p>
          </div>
        </div>

        <div className="card flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-purple-500/15 flex items-center justify-center">
            <Zap size={18} className="text-purple-400" />
          </div>
          <div>
            <p className="text-xs text-surface-500">Total Transfer</p>
            <p className="text-lg font-semibold text-purple-400">
              {formatBytes(traffic.totalDownload + traffic.totalUpload)}
            </p>
          </div>
        </div>
      </div>

      {/* Speed Chart */}
      <div className="card">
        <h3 className="text-sm font-medium text-surface-300 mb-3">Speed History</h3>
        <div className="h-32">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <XAxis dataKey="time" hide />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value: number) => formatSpeed(value)}
                />
                <Line
                  type="monotone"
                  dataKey="down"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                  name="Download"
                />
                <Line
                  type="monotone"
                  dataKey="up"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  name="Upload"
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-surface-600 text-sm">
              No traffic data yet
            </div>
          )}
        </div>
      </div>

      {/* Quick Node Switcher */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-surface-300">Quick Switch</h3>
          <span className="text-xs text-surface-500">{nodes.length} nodes</span>
        </div>

        {nodes.length === 0 ? (
          <p className="text-sm text-surface-500 text-center py-4">
            No nodes configured. Go to Nodes page to add proxy nodes.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
            {nodes.slice(0, 20).map((node, index) => (
              <button
                key={node.id}
                onClick={() => handleQuickSwitch(index)}
                className={`flex items-center gap-2 p-2 rounded-lg text-left text-sm transition-colors ${
                  index === selectedIndex
                    ? 'bg-primary-600/20 border border-primary-500/30 text-primary-300'
                    : 'bg-surface-800/50 border border-surface-700/50 hover:bg-surface-700/50 text-surface-300'
                }`}
              >
                <span>{getCountryFlag(node.country)}</span>
                <span className="truncate flex-1">{node.name}</span>
                {node.latency !== undefined && node.latency >= 0 && (
                  <span
                    className={`text-[10px] font-mono ${
                      node.latency < 100
                        ? 'text-green-400'
                        : node.latency < 300
                        ? 'text-yellow-400'
                        : 'text-red-400'
                    }`}
                  >
                    {node.latency}ms
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Proxy Info */}
      {connectionStatus === 'connected' && (
        <div className="card">
          <h3 className="text-sm font-medium text-surface-300 mb-2">Proxy Information</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between p-2 bg-surface-800/50 rounded">
              <span className="text-surface-500">Mixed Port</span>
              <span className="text-surface-200 font-mono">{settings.mixedPort}</span>
            </div>
            <div className="flex justify-between p-2 bg-surface-800/50 rounded">
              <span className="text-surface-500">Proxy Mode</span>
              <span className="text-surface-200 font-mono">{settings.proxyMode}</span>
            </div>
            <div className="flex justify-between p-2 bg-surface-800/50 rounded">
              <span className="text-surface-500">Remote DNS</span>
              <span className="text-surface-200 font-mono truncate ml-2">{settings.remoteDns}</span>
            </div>
            <div className="flex justify-between p-2 bg-surface-800/50 rounded">
              <span className="text-surface-500">Bypass China</span>
              <span className="text-surface-200 font-mono">{settings.bypassChina ? 'Yes' : 'No'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
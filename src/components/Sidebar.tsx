import React from 'react';
import { LayoutDashboard, Globe, Rss, Settings, FileText, Wifi, WifiOff, Loader2 } from './Icons';
import { useNodeStore } from '../store/nodeStore';
import type { Page } from '../App';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const navItems: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
  { id: 'nodes', label: 'Nodes', icon: <Globe size={18} /> },
  { id: 'subscriptions', label: 'Subscriptions', icon: <Rss size={18} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={18} /> },
  { id: 'logs', label: 'Logs', icon: <FileText size={18} /> },
];

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const connectionStatus = useNodeStore((s) => s.connectionStatus);
  const nodes = useNodeStore((s) => s.nodes);
  const selectedIndex = useNodeStore((s) => s.selectedIndex);

  const selectedNode = selectedIndex >= 0 && selectedIndex < nodes.length ? nodes[selectedIndex] : null;

  const statusColor = {
    connected: 'text-green-400',
    connecting: 'text-yellow-400',
    disconnected: 'text-red-400',
  }[connectionStatus];

  const StatusIcon = connectionStatus === 'connected' ? Wifi : connectionStatus === 'connecting' ? Loader2 : WifiOff;

  return (
    <aside className="w-52 bg-surface-100 border-r border-surface-200 dark:bg-surface-950 dark:border-surface-800 flex flex-col">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-200 dark:border-surface-800">
        <img src="./logo.png" alt="Awesome Proxy" className="w-6 h-6 rounded object-cover" />
        <span className="text-sm font-semibold text-surface-800 dark:text-surface-100">Awesome Proxy</span>
      </div>

      {/* Connection Status */}
      <div className="p-4 border-b border-surface-200 dark:border-surface-800">
        <div className="flex items-center gap-2">
          <StatusIcon
            size={16}
            className={`${statusColor} ${connectionStatus === 'connecting' ? 'animate-spin' : ''}`}
          />
          <span className={`text-xs font-medium ${statusColor}`}>
            {connectionStatus === 'connected'
              ? 'Connected'
              : connectionStatus === 'connecting'
              ? 'Connecting...'
              : 'Disconnected'}
          </span>
        </div>
        {selectedNode && connectionStatus === 'connected' && (
          <p className="text-[11px] text-surface-400 dark:text-surface-500 mt-1 truncate">{selectedNode.name}</p>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-2">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 ${
              currentPage === item.id
                ? 'bg-primary-600/15 text-primary-600 dark:text-primary-400 border-r-2 border-primary-500'
                : 'text-surface-500 hover:text-surface-800 hover:bg-surface-200/60 dark:text-surface-400 dark:hover:text-surface-200 dark:hover:bg-surface-800/50'
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Node Count */}
      <div className="p-4 border-t border-surface-200 dark:border-surface-800">
        <div className="text-[11px] text-surface-400 dark:text-surface-500">
          {nodes.length} node{nodes.length !== 1 ? 's' : ''} configured
        </div>
      </div>
    </aside>
  );
}
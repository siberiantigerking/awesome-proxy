import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import NodeManager from './pages/NodeManager';
import SubscriptionManager from './pages/SubscriptionManager';
import Settings from './pages/Settings';
import Logs from './pages/Logs';
import TitleBar from './components/TitleBar';
import { useNodeStore } from './store/nodeStore';
import { useSettingsStore } from './store/settingsStore';
import { useSubscriptionStore } from './store/subscriptionStore';
import { applyTheme, watchSystemTheme } from './services/theme';
import { startAutoUpdateScheduler } from './services/auto-update';
import { connect, disconnect, resumePendingConnect } from './services/connection';
import type { ConnectionStatus } from './types';

export type Page = 'dashboard' | 'nodes' | 'subscriptions' | 'settings' | 'logs';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [isLoading, setIsLoading] = useState(true);

  // Load persisted data on mount
  const loadNodes = useNodeStore((s) => s.loadFromStore);
  const loadSettings = useSettingsStore((s) => s.loadFromStore);
  const loadSubscriptions = useSubscriptionStore((s) => s.loadFromStore);
  const setConnectionStatus = useNodeStore((s) => s.setConnectionStatus);
  const setSingboxVersion = useSettingsStore((s) => s.setSingboxVersion);
  const setAppVersion = useSettingsStore((s) => s.setAppVersion);
  const updateTraffic = useSettingsStore((s) => s.updateTraffic);
  const theme = useSettingsStore((s) => s.settings.theme);
  const proxyMode = useSettingsStore((s) => s.settings.proxyMode);

  // Apply the theme whenever it changes, and follow OS changes in system mode.
  useEffect(() => {
    applyTheme(theme);
    const unwatch = watchSystemTheme(() => useSettingsStore.getState().settings.theme);
    return unwatch;
  }, [theme]);

  // Keep the tray icon's mode tint in sync with the selected proxy mode, so
  // it's ready to show the right color as soon as a connection is made.
  useEffect(() => {
    window.api?.tray?.setMode(proxyMode);
  }, [proxyMode]);

  useEffect(() => {
    const init = async () => {
      try {
        await Promise.all([loadNodes(), loadSettings(), loadSubscriptions()]);

        // Get app info
        try {
          const version = await window.api.singbox.getVersion();
          setSingboxVersion(version);
        } catch {
          setSingboxVersion('Not available');
        }

        try {
          const appVersion = await window.api.app.getVersion();
          setAppVersion(appVersion);
        } catch {
          // In dev mode, window.api might not be available
        }

        // Check current connection status
        let currentStatus: ConnectionStatus = 'disconnected';
        try {
          currentStatus = await window.api.singbox.getStatus();
          setConnectionStatus(currentStatus);
        } catch {
          // Dev mode
        }

        // On a normal launch (not the elevated relaunch that resumes a
        // pending TUN/Split connect), always show "System Proxy" as the
        // selected mode. Persisting the last-used mode across restarts was
        // misleading: the mode selector could show "TUN" highlighted while
        // sing-box wasn't even running, making it look like TUN was already
        // active. The user picks a different mode explicitly each session
        // if they want one.
        try {
          const pending = window.api?.store ? !!(await window.api.store.get('pendingConnect')) : false;
          if (!pending && currentStatus !== 'connected' && useSettingsStore.getState().settings.proxyMode !== 'system') {
            useSettingsStore.getState().updateSettings({ proxyMode: 'system' });
          }
        } catch {
          /* ignore */
        }

        // If we just relaunched as administrator to enable TUN/Split, resume
        // the connection automatically so the user doesn't have to click
        // Connect a second time.
        try {
          await resumePendingConnect();
        } catch {
          /* ignore */
        }
      } catch (err) {
        console.error('Failed to initialize:', err);
      } finally {
        setIsLoading(false);
      }
    };

    init();

    // Set up event listeners for sing-box events
    if (window.api) {
      window.api.singbox.onStatusChange((status) => {
        setConnectionStatus(status);
      });

      window.api.singbox.onTrafficUpdate((data) => {
        updateTraffic(data.up, data.down);
      });
    }

    // Tray's single Connect/Disconnect menu item asks the renderer to do the
    // actual work — connecting needs node selection, elevation handling, and
    // Clash API calls that live here, not in the main process.
    window.api?.tray?.onConnect(() => {
      if (useNodeStore.getState().connectionStatus !== 'connected') {
        connect().catch((err) => console.error('Tray connect failed:', err));
      }
    });
    window.api?.tray?.onDisconnect(() => {
      if (useNodeStore.getState().connectionStatus === 'connected') {
        disconnect().catch((err) => console.error('Tray disconnect failed:', err));
      }
    });

    // Start the subscription auto-update scheduler. It reads live store state
    // on each tick, so it always sees the latest subscriptions/nodes.
    const stopScheduler = startAutoUpdateScheduler({
      getSubscriptions: () => useSubscriptionStore.getState().subscriptions,
      getNodes: () => useNodeStore.getState().nodes,
      setNodes: (nodes) => useNodeStore.getState().setNodes(nodes),
      onSubscriptionUpdated: (id, nodeCount) =>
        useSubscriptionStore.getState().updateSubscription(id, {
          lastUpdate: Date.now(),
          nodeCount,
        }),
      onError: (id, error) => console.warn('Auto-update failed for', id, error),
    });

    return () => {
      stopScheduler();
    };
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return <Dashboard />;
      case 'nodes':
        return <NodeManager />;
      case 'subscriptions':
        return <SubscriptionManager />;
      case 'settings':
        return <Settings />;
      case 'logs':
        return <Logs />;
      default:
        return <Dashboard />;
    }
  };

  if (isLoading) {
    return (
      <div className="h-screen bg-surface-50 dark:bg-surface-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-surface-500 dark:text-surface-400 text-sm">Loading Awesome Proxy...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-surface-50 text-surface-900 dark:bg-surface-900 dark:text-surface-100 overflow-hidden">
      {/* Custom Title Bar */}
      <TitleBar />

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
        <main className="flex-1 overflow-auto bg-surface-50 dark:bg-surface-900 p-6">
          {renderPage()}
        </main>
      </div>
    </div>
  );
}

export default App;
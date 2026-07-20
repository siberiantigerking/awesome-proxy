import { useNodeStore } from '../store/nodeStore';
import { useSettingsStore } from '../store/settingsStore';
import { tagForIndex } from './outbound-tags';

export interface ConnectResult {
  ok: boolean;
  error?: string;
  /** True when the app is relaunching as admin (caller should stop). */
  elevating?: boolean;
}

function needsAdmin(mode: string): boolean {
  return mode === 'tun' || mode === 'split';
}

/**
 * Stop sing-box and clean up the system proxy. Safe to call regardless of the
 * current mode (disabling the system proxy is idempotent).
 */
export async function disconnect(): Promise<void> {
  if (!window.api) return;
  await window.api.singbox.stop();
  // Always clear the system proxy registry entry on disconnect, even if the
  // current mode isn't "system" — it's a no-op when already off and prevents a
  // stale proxy being left set after switching modes.
  try {
    await window.api.systemProxy.disable();
  } catch {
    /* ignore */
  }
}

/**
 * Start sing-box with the current nodes/settings and apply the system proxy
 * when in system mode. Handles admin elevation for TUN/Split modes.
 */
export async function connect(): Promise<ConnectResult> {
  if (!window.api) return { ok: false, error: 'API unavailable' };

  const { nodes, selectedIndex } = useNodeStore.getState();
  const { settings } = useSettingsStore.getState();

  const selectedNode = selectedIndex >= 0 && selectedIndex < nodes.length ? nodes[selectedIndex] : null;
  if (!selectedNode) return { ok: false, error: 'Select a node first.' };

  // TUN / Split need administrator rights (TUN adapter). Relaunch elevated if
  // necessary — the Windows UAC prompt is the single confirmation.
  if (needsAdmin(settings.proxyMode) && window.api.app.isAdmin) {
    const admin = await window.api.app.isAdmin();
    if (!admin) {
      // Remember the connect intent so the elevated instance auto-connects on
      // startup. Without this, the first TUN/Split connect relaunches the app
      // (the old window quits, which looks like "disconnecting by itself") and
      // the user has to click Connect a second time.
      try { await window.api.store.set('pendingConnect', true); } catch { /* ignore */ }
      const ok = await window.api.app.relaunchAsAdmin();
      if (!ok) {
        try { await window.api.store.set('pendingConnect', false); } catch { /* ignore */ }
      }
      return {
        ok: false,
        elevating: ok,
        error: ok
          ? undefined
          : 'This mode needs administrator rights. The elevation request was declined or unavailable. ' +
            'You can also use "System Proxy" mode, which does not need admin.',
      };
    }
  }

  const config = await window.api.config.generate(nodes, selectedIndex, settings);
  const configPath = await window.api.config.write(config);
  const result = await window.api.singbox.start(configPath);
  if (!result.success) {
    return { ok: false, error: result.error || 'Failed to start sing-box. Check the Logs page for details.' };
  }

  // sing-box persists every selector's last choice in its cache file and
  // restores it on the NEXT start regardless of the config's `default` field
  // (see protocol/group/selector.go: Selector.Start() loads the cached tag
  // before ever looking at `default`). That's why activating e.g. a US node
  // could silently keep using a previously-selected JP node. Force each
  // selector's selection explicitly via the Clash API right after start so
  // the UI's current choice always wins over any stale cached selection.
  const tag = tagForIndex(nodes, selectedIndex);
  if (tag) {
    await forceSelectWithRetry('proxy', tag);
    if (settings.proxyMode === 'split' && Array.isArray(settings.splitRules)) {
      for (const rule of settings.splitRules) {
        if (rule.enabled && rule.outbound) {
          await forceSelectWithRetry(rule.name, rule.outbound);
        }
      }
    }
  }

  if (settings.proxyMode === 'system') {
    await window.api.systemProxy.enable('127.0.0.1', settings.mixedPort);
  }
  return { ok: true };
}

/**
 * Call the Clash API select with a couple of retries — the API listener can
 * take a brief moment to come up right after sing-box reports "started".
 */
async function forceSelectWithRetry(selector: string, outbound: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await window.api.singbox.select(selector, outbound);
      if (res && res.success) return;
    } catch {
      /* ignore and retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Reconnect: stop, then start fresh with the current settings. Used when the
 * proxy MODE changes while connected (different inbounds require a real
 * restart, unlike node/selector switches which go through the Clash API).
 */
export async function reconnect(): Promise<ConnectResult> {
  await disconnect();
  // Brief pause so the previous process releases its ports / TUN adapter
  // before the new one binds them.
  await new Promise((r) => setTimeout(r, 800));
  return connect();
}

/**
 * On startup, resume a connection that was pending across an admin-elevation
 * relaunch. Returns true if a connect was attempted. The pending flag is
 * always cleared first so it never triggers on a later normal launch.
 */
export async function resumePendingConnect(): Promise<boolean> {
  if (!window.api?.store) return false;
  let pending = false;
  try {
    pending = !!(await window.api.store.get('pendingConnect'));
  } catch {
    return false;
  }
  if (!pending) return false;

  try { await window.api.store.set('pendingConnect', false); } catch { /* ignore */ }

  // Only resume if we're now elevated (the whole point of the relaunch) and not
  // already connected.
  try {
    const admin = window.api.app.isAdmin ? await window.api.app.isAdmin() : true;
    const status = await window.api.singbox.getStatus();
    if (admin && status !== 'connected') {
      await connect();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

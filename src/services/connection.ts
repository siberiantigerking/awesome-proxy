import { useNodeStore } from '../store/nodeStore';
import { useSettingsStore } from '../store/settingsStore';
import { tagForIndex } from './outbound-tags';

export interface ConnectResult {
  ok: boolean;
  error?: string;
  /**
   * Set when the connection succeeded but something could not be verified.
   * Distinct from `error`, which means the connection is not usable.
   */
  warning?: string;
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
  let warning: string | undefined;
  if (tag) {
    const outcome = await forceSelect('proxy', tag);
    if (!outcome.ok) {
      if (outcome.confirmedWrong) {
        // The core told us it is on a different node. That IS a routing problem
        // and saying "connected" would be a lie.
        return {
          ok: false,
          error:
            `Could not switch to "${tag}": ${outcome.reason}. ` +
            'Traffic would not go through the node you picked.',
        };
      }
      // We could not reach the Clash API to confirm. The config was generated
      // with this node as the selector default, so it is probably active — we
      // just cannot prove it. Warn rather than blocking a working connection.
      warning =
        `Connected, but could not confirm the active node with the core (${outcome.reason}). ` +
        `The config selects "${tag}"; check the Logs page if traffic looks wrong.`;
    }
    if (settings.proxyMode === 'split' && Array.isArray(settings.splitRules)) {
      for (const rule of settings.splitRules) {
        if (rule.enabled && rule.outbound) {
          // Best-effort: the API is known-reachable by now if the call above
          // succeeded, and a per-rule failure should not fail the connection.
          await forceSelect(rule.name, rule.outbound, 2000);
        }
      }
    }
  }

  if (settings.proxyMode === 'system') {
    await window.api.systemProxy.enable('127.0.0.1', settings.mixedPort);
  }
  return { ok: true, warning };
}

/**
 * Outcome of trying to point a selector at an outbound.
 *
 * The distinction between the two failure kinds is the important part.
 * "Confirmed wrong" means the core told us it is using a different node, which
 * is a real routing problem worth blocking on. "Unverified" means we could not
 * reach the Clash API to ask — the selection may well be correct, and claiming
 * otherwise is a false alarm.
 */
type SelectOutcome =
  | { ok: true }
  | { ok: false; confirmedWrong: boolean; reason: string };

/**
 * How long to wait for the Clash API listener after the core reports started.
 *
 * Split mode needs a generous budget. Its config carries remote `rule_set`
 * entries that sing-box downloads from jsDelivr during startup, and the Clash
 * API only begins listening once that finishes — so the listener can be many
 * seconds late. The original 1.5s here produced a confident but wrong
 * "traffic would not go through the node you picked" in Split mode while the
 * log showed traffic correctly using the selected node the whole time.
 */
const CLASH_API_READY_TIMEOUT_MS = 15000;
const CLASH_API_POLL_INTERVAL_MS = 400;

/**
 * Point `selector` at `outbound` and CONFIRM it took effect.
 *
 * The confirmation matters more than the retry. A successful PUT only says the
 * request was accepted; it does not prove the selector moved. sing-box restores
 * every selector's cached choice on start and that overrides the config's
 * `default`, so a selection that silently fails leaves the core routing through
 * a previously-used node while the UI happily shows the one the user picked.
 * That was observed in the field: the config carried `default: "SP1"`, the user
 * had another node highlighted, and every connection went out through a stale
 * `24 日本`. So read the active outbound back and only report success when it is
 * the tag we asked for.
 *
 * `budgetMs` bounds how long to keep trying while the API is still coming up.
 * Callers that have a cheap fallback (switchNode, which can just restart) pass
 * a small budget; the initial connect passes the full readiness timeout.
 */
async function forceSelect(
  selector: string,
  outbound: string,
  budgetMs = CLASH_API_READY_TIMEOUT_MS
): Promise<SelectOutcome> {
  const deadline = Date.now() + budgetMs;
  let unreachableReason = 'the core did not respond';

  for (;;) {
    try {
      const res = await window.api.singbox.select(selector, outbound);
      if (res && res.success) {
        // Older builds of the preload bridge may not expose the read-back. In
        // that case accept the PUT rather than failing a working switch.
        if (!window.api.singbox.getSelection) return { ok: true };
        const active = await window.api.singbox.getSelection(selector);
        if (active && active.success) {
          if (active.now === outbound) return { ok: true };
          // The API answered and named a different outbound. That is a genuine
          // mismatch, not a timing artefact, so stop and report it.
          return {
            ok: false,
            confirmedWrong: true,
            reason: `the core is using "${active.now ?? 'unknown'}" instead of "${outbound}"`,
          };
        }
        unreachableReason = active?.error || 'could not read the active outbound back';
      } else if (res && res.error) {
        unreachableReason = res.error;
      }
    } catch (err: any) {
      unreachableReason = err?.message || 'the core did not respond';
    }

    if (Date.now() >= deadline) {
      return { ok: false, confirmedWrong: false, reason: unreachableReason };
    }
    await new Promise((r) => setTimeout(r, CLASH_API_POLL_INTERVAL_MS));
  }
}

/**
 * Select a node and, when connected, actually move live traffic onto it.
 *
 * This MUST be the only way the UI changes the active node. Updating
 * `selectedIndex` alone only repaints the UI: the running core keeps using
 * whatever outbound its `proxy` selector points at, so the app cheerfully
 * showed "connected via JP3" while every connection still went out through the
 * previously selected node.
 *
 * Falls back to a full restart if the live switch fails, since a wrong-but-
 * displayed node is worse than a brief reconnect.
 */
export async function switchNode(index: number): Promise<ConnectResult> {
  const {
    nodes,
    selectedIndex: previousIndex,
    connectionStatus,
    setSelectedIndex,
  } = useNodeStore.getState();
  if (index < 0 || index >= nodes.length) return { ok: false, error: 'No such node' };

  setSelectedIndex(index);
  if (connectionStatus !== 'connected' || !window.api) return { ok: true };

  const { settings } = useSettingsStore.getState();
  const tag = tagForIndex(nodes, index);

  // OpenVPN cannot be switched live, in either direction. Its endpoint dials at
  // startup and holds the session for as long as it is in the config, so only
  // the selected profile is emitted at all (see nodeInactiveReason in the config
  // generator). Switching TO one therefore can't work — the tag isn't in the
  // running config — and switching AWAY from one via the selector would leave
  // its VPN session established and counting against the account's device
  // limit. Both cases need the config itself to change, so skip the live switch.
  const involvesOpenvpn =
    nodes[index]?.type === 'openvpn' ||
    (previousIndex >= 0 &&
      previousIndex < nodes.length &&
      nodes[previousIndex]?.type === 'openvpn');

  // One attempt at the live switch, but verified: an accepted PUT that did not
  // actually move the selector used to leave traffic on the previous node with
  // the UI showing the new one. If it cannot be confirmed, fall through to the
  // restart below rather than reporting a switch that did not happen.
  if (tag && !involvesOpenvpn) {
    // Short budget: the core is already running, so the API should answer at
    // once. If it doesn't, the restart below is the cheaper path.
    const outcome = await forceSelect('proxy', tag, 1200);
    if (outcome.ok) return { ok: true };
  }

  try {
    const config = await window.api.config.generate(nodes, index, settings);
    const configPath = await window.api.config.write(config);
    const result = await window.api.singbox.restart(configPath);
    if (result && result.success === false) {
      return { ok: false, error: result.error || 'Could not switch node' };
    }
    if (tag) {
      const outcome = await forceSelect('proxy', tag);
      if (!outcome.ok && outcome.confirmedWrong) {
        return { ok: false, error: `Could not switch to "${tag}": ${outcome.reason}.` };
      }
      if (!outcome.ok) {
        return {
          ok: true,
          warning: `Switched to "${tag}", but could not confirm it with the core (${outcome.reason}).`,
        };
      }
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Could not switch node' };
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

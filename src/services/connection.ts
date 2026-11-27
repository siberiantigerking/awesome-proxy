import { useNodeStore } from '../store/nodeStore';
import { useSettingsStore } from '../store/settingsStore';
import { useCoreCrashStore } from '../store/coreCrashStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { hasLiveConnection, usePendingApplyStore, whileStarting } from '../store/pendingApplyStore';
import { splitSelectorTag, tagForIndex } from './outbound-tags';
import type { AppSettings, ProxyNode } from '../types';

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
 * The port this connection pointed the Windows system proxy at: set by
 * connect() once the proxy is on in System Proxy mode, null in the other modes
 * and from disconnect() on. switchNode's restart reads it to make the proxy
 * follow the restarted core (followSystemProxy). Main keeps the snapshot of
 * the user's own settings from the first enable and only moves the server on
 * a later one (enableImpl in shared/system-proxy.cjs), so moving it keeps the
 * restore intact.
 */
let systemProxyPort: number | null = null;

/**
 * Stop sing-box and clean up the system proxy. Safe to call regardless of the
 * current mode: disable restores whatever proxy settings were there before
 * connecting, and is a no-op when the app didn't set them.
 */
export async function disconnect(): Promise<void> {
  if (!window.api) return;
  // The proxy this connection set ends with it: disable() below undoes it.
  systemProxyPort = null;
  await window.api.singbox.stop();
  // Always ask, even if the current mode isn't "system": after a mode switch
  // the proxy may still be the one an earlier System-mode connect set. When
  // the app didn't set it (Manual mode, another tool's proxy) nothing changes.
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
  // The updater is disconnecting to run the installer: a core started now
  // would outlive the quit and lock sing-box.exe for it. Main refuses too; this
  // covers the Dashboard, tray Connect and resumePendingConnect before any of
  // them generates a config or asks for elevation.
  if (useAppUpdateStore.getState().status.state === 'installing') {
    return { ok: false, error: 'Awesome Proxy is installing an update and will restart in a moment.' };
  }

  const { nodes, selectedIndex } = useNodeStore.getState();
  const { settings } = useSettingsStore.getState();

  const selectedNode = selectedIndex >= 0 && selectedIndex < nodes.length ? nodes[selectedIndex] : null;
  if (!selectedNode) return { ok: false, error: 'Select a node first.' };

  // The config is built from the nodes and settings just read, so this is
  // where "Reconnect to apply" stops being true, not once the core is up. A
  // change made while this start is under way (the scheduler's first refresh
  // during the auto-connect after an admin relaunch, a port typed meanwhile)
  // is missing from that config: it raises the flag again (whileStarting
  // counts the start as live), and the flag stays up once connected (Round 2
  // follow-up N1). A start that fails brings the flag back as it was.
  const wasPending = usePendingApplyStore.getState().pending;
  usePendingApplyStore.getState().setPending(false);
  let ok = false;
  try {
    const result = await whileStarting(() => startConnection(nodes, selectedIndex, settings));
    ok = result.ok;
    return result;
  } finally {
    if (!ok && wasPending) usePendingApplyStore.getState().setPending(true);
  }
}

/**
 * The rest of connect(), from the admin check on, with the nodes and settings
 * connect() read. Runs inside whileStarting().
 */
async function startConnection(
  nodes: ProxyNode[],
  selectedIndex: number,
  settings: AppSettings
): Promise<ConnectResult> {
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
    await selectSplitTargets(settings);
  }

  if (settings.proxyMode === 'system') {
    // In System Proxy mode an unset proxy means no app uses the core, so a
    // "connected" status would be a lie. Stop the core and say why.
    const enabled = await window.api.systemProxy.enable('127.0.0.1', settings.mixedPort).catch(() => false);
    if (enabled !== true) {
      await window.api.singbox.stop().catch(() => {});
      return {
        ok: false,
        error:
          "Couldn't set the Windows system proxy, so the connection was stopped (apps would not have used it). " +
          'The Logs page has the reason.',
      };
    }
  }
  // What a later restart's followSystemProxy compares the settings with.
  systemProxyPort = settings.proxyMode === 'system' ? settings.mixedPort : null;
  // Connected again, so an old "sing-box stopped unexpectedly" banner is stale.
  useCoreCrashStore.getState().clearCrash();
  return { ok: true, warning };
}

/**
 * Point every enabled Split rule's selector at its target, after the `proxy`
 * selector. The core restores each selector's cached choice on start, whatever
 * the config's `default` says (see forceSelect), so a rule whose target
 * changed would otherwise keep its old one.
 */
async function selectSplitTargets(settings: AppSettings): Promise<void> {
  if (settings.proxyMode !== 'split' || !Array.isArray(settings.splitRules)) return;
  for (const rule of settings.splitRules) {
    if (rule.enabled && rule.outbound) {
      // Best-effort: the API is known-reachable by now if the `proxy` select
      // succeeded, and a per-rule failure should not fail the connection.
      await forceSelect(splitSelectorTag(rule), rule.outbound, 2000);
    }
  }
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
 * That was observed in the field: the config's `default` named one node, the user
 * had another node highlighted, and every connection went out through a stale
 * `<node name>`. So read the active outbound back and only report success when it is
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
 * Select a node and, when connected or while main's watchdog is bringing the
 * core back, actually move live traffic onto it.
 *
 * This MUST be the only way the UI changes the active node. Updating
 * `selectedIndex` alone only repaints the UI: the running core keeps using
 * whatever outbound its `proxy` selector points at, so the app cheerfully
 * showed "connected via JP3" while every connection still went out through the
 * previously selected node.
 *
 * Falls back to a full restart if the live switch fails, since a wrong-but-
 * displayed node is worse than a brief reconnect.
 *
 * While "Reconnect to apply" is up it restarts straight away: the running core
 * has an older node list, in which the picked node's tag can name another
 * node. The restart's config comes from the current nodes and settings, so it
 * applies the pending change as well: the flag is cleared, and the Windows
 * proxy follows a mixed port or a mode that changed meanwhile. After any
 * failed restart the flag comes back if it was up, and the proxy is restored
 * when no core is left running.
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
  // 'connecting' is main's watchdog bringing back a core that stopped
  // unexpectedly. That restart reuses the config file from the last connect,
  // and the cache file brings back the old selector choice, so a node picked
  // now would be shown but never used. Treat it as live and restart with the
  // new node below, which also calls off the pending restart.
  const restartPending = connectionStatus === 'connecting';
  if ((connectionStatus !== 'connected' && !restartPending) || !window.api) return { ok: true };

  const { settings } = useSettingsStore.getState();
  const tag = tagForIndex(nodes, index);
  // "Reconnect to apply" is up (Round 2 follow-up N6): the running core still
  // has an older node list or older settings, typically after a subscription
  // refresh. The tag above comes from the current list, and tag suffixes
  // follow list order, so with same-named nodes it can name a different node
  // in the running core (SubB's new "HK" can be SubA's "HK" there) and a live
  // switch would report success on the wrong node. Restart instead, as while
  // a restart is pending. The restart's config is generated from the nodes
  // and settings read above, which hold the pending change, so the flag is
  // cleared here, where they were read. A change made from now on raises it
  // again (whileStarting counts the restart as live), and a failed restart
  // brings it back.
  const applyPending = usePendingApplyStore.getState().pending;
  if (applyPending) usePendingApplyStore.getState().setPending(false);

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
  // restart below rather than reporting a switch that did not happen. While a
  // restart is pending there is no core to take a live switch, and while
  // changes are pending the tag may name another node in the running core.
  if (tag && !involvesOpenvpn && !restartPending && !applyPending) {
    // Short budget: the core is already running, so the API should answer at
    // once. If it doesn't, the restart below is the cheaper path.
    const outcome = await forceSelect('proxy', tag, 1200);
    if (outcome.ok) return { ok: true };
  }

  try {
    const result = await whileStarting(async () => {
      const config = await window.api.config.generate(nodes, index, settings);
      const configPath = await window.api.config.write(config);
      return window.api.singbox.restart(configPath);
    });
    if (result && result.success === false) {
      return await restartFailed(applyPending, result.error || 'Could not switch node');
    }
    // Before the node is confirmed: a confirmation that fails below must not
    // leave every app pointing at a port the new core doesn't listen on.
    const proxyError = await followSystemProxy(settings);
    if (proxyError) {
      if (applyPending) usePendingApplyStore.getState().setPending(true);
      return { ok: false, error: proxyError };
    }
    if (tag) {
      const outcome = await forceSelect('proxy', tag);
      if (!outcome.ok && outcome.confirmedWrong) {
        return { ok: false, error: `Could not switch to "${tag}": ${outcome.reason}.` };
      }
      // A Split rule's target can be pending too (Apply now refused with no
      // node selected), and the core restores each selector's cached choice
      // on start, so put the rules on their targets as connect() does.
      if (applyPending) await selectSplitTargets(settings);
      if (!outcome.ok) {
        return {
          ok: true,
          warning: `Switched to "${tag}", but could not confirm it with the core (${outcome.reason}).`,
        };
      }
    }
    return { ok: true };
  } catch (err: any) {
    return restartFailed(applyPending, err?.message || 'Could not switch node');
  }
}

/**
 * A node switch's restart failed or threw: bring the "Reconnect to apply" flag
 * back if the restart was applying it, and restore the Windows system proxy
 * when no core is left running.
 *
 * The restart stops the old core before it starts the new one, so a failure
 * normally leaves none. Nothing else restores the proxy then: an explicit
 * start's failure isn't a crash, and a restart that replaced main's watchdog
 * restart also called off its give-up, which would have. In System Proxy mode
 * every app would keep pointing at a stopped core while the Dashboard shows
 * Disconnected, after a pick during a pending watchdog restart (Round 1's N4)
 * as after a pick while connected whose live switch and restart both failed
 * (Round 1 follow-up 2). Only when the core really is down: a node picked
 * meanwhile may have started another restart, which needs the proxy kept, and
 * a restart that threw before it stopped anything leaves the old core
 * running. As in disconnect(), disable() undoes only a proxy the app set, so
 * the other modes are unaffected.
 */
async function restartFailed(applyPending: boolean, error: string): Promise<ConnectResult> {
  if (applyPending) usePendingApplyStore.getState().setPending(true);
  const status = await window.api.singbox.getStatus().catch(() => null);
  if (status === 'disconnected') {
    await window.api.systemProxy.disable().catch(() => false);
    systemProxyPort = null;
  }
  return { ok: false, error };
}

/**
 * After a node switch's restart: point the Windows system proxy where
 * connect() would for these settings. Returns an error, with the core
 * stopped, when the proxy can't be set.
 *
 * A pending change can have moved the mixed port (also Round 1 follow-up 4: a
 * port edit, then a pick during "Connecting..."). The new core listens on the
 * new port, and a proxy left on the old one would send every app to a port
 * nothing listens on. A pending change of mode is possible too, because Apply
 * now with no node selected keeps the old core running (applyPendingChanges):
 * the proxy then comes on for System Proxy mode and goes off for the others,
 * as a reconnect would leave it.
 */
async function followSystemProxy(settings: AppSettings): Promise<string | null> {
  if (settings.proxyMode !== 'system') {
    if (systemProxyPort !== null) {
      await window.api.systemProxy.disable().catch(() => false);
      systemProxyPort = null;
    }
    return null;
  }
  if (systemProxyPort === settings.mixedPort) return null;
  const moving = systemProxyPort !== null;
  const enabled = await window.api.systemProxy.enable('127.0.0.1', settings.mixedPort).catch(() => false);
  if (enabled === true) {
    systemProxyPort = settings.mixedPort;
    return null;
  }
  // As in connect(): with the proxy unset no app uses the core, so a
  // "connected" status would be a lie. disable() as well, because the proxy
  // this connection set may still point at the old port.
  await window.api.singbox.stop().catch(() => {});
  await window.api.systemProxy.disable().catch(() => false);
  systemProxyPort = null;
  return moving
    ? "Couldn't move the Windows system proxy to the new port, so the connection was stopped (apps would not have used it). " +
        'The Logs page has the reason.'
    : "Couldn't set the Windows system proxy, so the connection was stopped (apps would not have used it). " +
        'The Logs page has the reason.';
}

/**
 * Reconnect: stop, then start fresh with the current settings. Used when the
 * proxy MODE changes while connected (different inbounds require a real
 * restart, unlike node/selector switches which go through the Clash API).
 */
export async function reconnect(): Promise<ConnectResult> {
  await disconnect();
  // Brief pause so the previous process releases its ports / TUN adapter
  // before the new one binds them. It also lets a watchdog restart that the
  // stop called off (status 'connecting') settle first. Unlike
  // singbox:restart, singbox:start doesn't wait for it, and a watchdog start
  // in main's controller-port retry pause (CONTROLLER_RETRY_DELAY_MS, 800 ms)
  // only cancels itself when that pause ends. A start before then is refused
  // as already running, so keep this pause at least that long.
  await new Promise((r) => setTimeout(r, 800));
  return connect();
}

/**
 * "Apply now" on a Reconnect-to-apply banner: restart the core so it runs the
 * current nodes and settings, and connect() then clears the flag. With no live
 * core there is nothing to restart and the next connect applies everything
 * anyway, so the flag is dropped and null returned.
 *
 * With no node selected (a refresh removed the selected one, say) connect()
 * refuses, so a reconnect would only stop a working core, and in System Proxy
 * mode restore the Windows proxy too (Round 2 follow-up N4). Refuse first
 * instead, leaving the core and the flag as they are: picking a node then
 * applies the change, since switchNode restarts while the flag is up.
 */
export async function applyPendingChanges(): Promise<ConnectResult | null> {
  if (!hasLiveConnection()) {
    usePendingApplyStore.getState().setPending(false);
    return null;
  }
  const { nodes, selectedIndex } = useNodeStore.getState();
  if (selectedIndex < 0 || selectedIndex >= nodes.length) return { ok: false, error: 'Select a node first.' };
  return reconnect();
}

/**
 * How a Split rule's new target reaches the core (Settings' rule editor):
 * - 'live': connected with nothing pending, so a Clash API select moves the
 *   rule's selector without a restart;
 * - 'reconnect': main's watchdog is bringing the core back with the old rules
 *   ('connecting'), and its cache file would restore the old choice; or
 *   "Reconnect to apply" is up, and the target, a tag from the current node
 *   list, can name another node in the running core (N6). A reconnect starts
 *   from the current rules, and connect() re-selects every enabled rule's
 *   target;
 * - 'none': no core, so the next connect uses the new target anyway.
 */
export function splitTargetChangeMode(): 'live' | 'reconnect' | 'none' {
  const status = useNodeStore.getState().connectionStatus;
  if (status === 'connecting') return 'reconnect';
  if (status === 'connected') return usePendingApplyStore.getState().pending ? 'reconnect' : 'live';
  return 'none';
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

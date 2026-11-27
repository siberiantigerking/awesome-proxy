import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProxyNode, SplitRule } from '../../src/types';
import { installMockApi } from '../helpers/mock-api';

/**
 * src/services/connection.ts and the "Reconnect to apply" flag
 * (src/store/pendingApplyStore.ts) over a mocked window.api: how a node switch
 * treats the flag (Round 2 follow-up N6), changes made while a start is under
 * way (N1), Apply now with no node selected (N4), and the system proxy after a
 * failed or a successful restart (Round 1 follow-ups 2 and 4).
 *
 * The modules are imported fresh for each test, so connection.ts's module
 * state (the system proxy port, the starts under way) starts empty. The mock's
 * select / getSelection act as the core's selectors, so forceSelect confirms a
 * selection at once. Nothing is spawned and no timer runs: every core call
 * goes to the mock, and the Windows proxy calls are only recorded.
 */

/** Two Shadowsocks nodes on loopback; nothing dials them. */
const NODES: ProxyNode[] = [
  { id: 'node-a', name: 'A', type: 'shadowsocks', server: '127.0.0.1', port: 19191, method: 'aes-256-gcm', password: 'pw-a' },
  { id: 'node-b', name: 'B', type: 'shadowsocks', server: '127.0.0.1', port: 19192, method: 'aes-256-gcm', password: 'pw-b' },
];

const SPLIT_RULE: SplitRule = { id: 'rule-1', name: 'Rule', outbound: 'direct', ruleSets: [], enabled: true };

/** Fresh stores and connection.ts over a mock API, with A selected and nothing connected. */
async function setup() {
  const mock = installMockApi();
  const api = mock.api;
  const selected = new Map<string, string>();
  api.singbox.select.mockImplementation(async (selector: string, outbound: string) => {
    selected.set(selector, outbound);
    return { success: true };
  });
  api.singbox.getSelection.mockImplementation(async (selector: string) => ({ success: true, now: selected.get(selector) }));
  vi.resetModules();
  const { useNodeStore } = await import('../../src/store/nodeStore');
  const { useSettingsStore } = await import('../../src/store/settingsStore');
  const pendingApply = await import('../../src/store/pendingApplyStore');
  const connection = await import('../../src/services/connection');
  useNodeStore.getState().setNodes(NODES);
  useNodeStore.getState().setSelectedIndex(0);
  return {
    api,
    useNodeStore,
    useSettingsStore,
    pendingApply,
    connection,
    pending: () => pendingApply.usePendingApplyStore.getState().pending,
    setPending: (pending: boolean) => pendingApply.usePendingApplyStore.getState().setPending(pending),
    setStatus: (status: 'connected' | 'connecting' | 'disconnected') =>
      useNodeStore.getState().setConnectionStatus(status),
    settings: (patch: Record<string, unknown>) => useSettingsStore.getState().updateSettings(patch),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * connect() in the current mode (System Proxy by default), then the status
 * main would push, and an empty call log, so a test sees only what follows.
 */
async function connected(t: Setup) {
  expect(await t.connection.connect()).toMatchObject({ ok: true });
  t.setStatus('connected');
  vi.clearAllMocks();
}

/** Global call order of a mock's calls, to tell "before the restart" from "after". */
const order = (fn: any): number[] => fn.mock.invocationCallOrder;
const restartAt = (t: Setup): number => order(t.api.singbox.restart)[0];

/**
 * Connected, and a refresh removed the selected node: Apply now is then
 * refused (applyPendingChanges) and Settings raises the flag, the core being
 * still live.
 */
function loseSelectionWithChangePending(t: Setup) {
  const { nodes, selectedNodeId } = t.useNodeStore.getState();
  t.setStatus('connected');
  t.useNodeStore.getState().setNodes(nodes.filter((n) => n.id !== selectedNodeId));
  expect(t.useNodeStore.getState().selectedIndex).toBe(-1);
  t.setPending(true);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('switchNode and "Reconnect to apply" (N6)', () => {
  it('with nothing pending, switches live and confirms it, with no restart', async () => {
    const t = await setup();
    await connected(t);
    expect(await t.connection.switchNode(1)).toEqual({ ok: true });
    expect(t.api.singbox.select.mock.calls).toEqual([['proxy', 'B']]);
    expect(t.api.singbox.getSelection).toHaveBeenCalledWith('proxy');
    expect(t.api.singbox.restart).not.toHaveBeenCalled();
    expect(t.api.config.generate).not.toHaveBeenCalled();
    expect(t.useNodeStore.getState().selectedIndex).toBe(1);
  });

  it('with the flag up, restarts with the current nodes, index and settings before any select, and clears the flag', async () => {
    const t = await setup();
    await connected(t);
    // A refresh rotates B's password while connected: the running core still has the old list.
    const refreshed = [NODES[0], { ...NODES[1], password: 'rotated' }];
    t.useNodeStore.getState().setNodes(refreshed);
    t.pendingApply.markPendingIfLive();
    expect(t.pending()).toBe(true);

    expect(await t.connection.switchNode(1)).toEqual({ ok: true });
    expect(t.api.config.generate).toHaveBeenCalledTimes(1);
    const [nodes, index, settings] = t.api.config.generate.mock.calls[0];
    expect(nodes).toBe(refreshed);
    expect(index).toBe(1);
    expect(settings).toBe(t.useSettingsStore.getState().settings);
    expect(t.api.singbox.restart).toHaveBeenCalledTimes(1);
    // The only select is the confirmation after the restart: no live switch first.
    expect(t.api.singbox.select.mock.calls).toEqual([['proxy', 'B']]);
    expect(order(t.api.singbox.select)[0]).toBeGreaterThan(restartAt(t));
    // Same port, so the proxy is left as connect() set it.
    expect(t.api.systemProxy.enable).not.toHaveBeenCalled();
    expect(t.api.systemProxy.disable).not.toHaveBeenCalled();
    expect(t.pending()).toBe(false);
  });

  it.each([
    ['disconnected', 1],
    ['connecting', 0],
    ['connected', 0],
  ])('when that restart fails, the flag comes back, and with status %s the proxy is restored %i time(s)', async (status, disables) => {
    const t = await setup();
    await connected(t);
    t.setPending(true);
    t.api.singbox.restart.mockResolvedValueOnce({ success: false, error: 'mock restart failure' });
    t.api.singbox.getStatus.mockResolvedValueOnce(status);

    expect(await t.connection.switchNode(1)).toEqual({ ok: false, error: 'mock restart failure' });
    expect(t.pending()).toBe(true);
    expect(t.api.singbox.getStatus).toHaveBeenCalledTimes(1);
    expect(t.api.systemProxy.disable).toHaveBeenCalledTimes(disables);
    expect(t.api.singbox.select).not.toHaveBeenCalled();
  });

  it('a restart that throws before stopping anything keeps the old core and its proxy, and brings the flag back', async () => {
    const t = await setup();
    await connected(t);
    t.setPending(true);
    t.api.config.generate.mockRejectedValueOnce(new Error('mock generate failure'));
    t.api.singbox.getStatus.mockResolvedValueOnce('connected');

    expect(await t.connection.switchNode(1)).toEqual({ ok: false, error: 'mock generate failure' });
    expect(t.api.singbox.restart).not.toHaveBeenCalled();
    expect(t.api.systemProxy.disable).not.toHaveBeenCalled();
    expect(t.pending()).toBe(true);
  });

  it('a change made during the restart, while the renderer shows disconnected, raises the flag again (N1)', async () => {
    const t = await setup();
    await connected(t);
    t.setPending(true);
    t.api.singbox.restart.mockImplementationOnce(async () => {
      t.setStatus('disconnected'); // main pushes this when the old core exits,
      t.pendingApply.markPendingIfLive(); // a scheduler refresh lands,
      t.setStatus('connected'); // and main pushes this when the new core reports started
      return { success: true };
    });

    expect(await t.connection.switchNode(1)).toEqual({ ok: true });
    expect(t.pending()).toBe(true);
  });
});

describe('a failed switch and the system proxy (Round 1)', () => {
  it('connected, nothing pending: a live switch and a restart that both fail restore the proxy (follow-up 2)', async () => {
    const t = await setup();
    await connected(t);
    // The core answers but stays on A, so the live switch is confirmed wrong at once.
    t.api.singbox.getSelection.mockResolvedValueOnce({ success: true, now: 'A' });
    t.api.singbox.restart.mockResolvedValueOnce({ success: false, error: 'mock restart failure' });

    expect(await t.connection.switchNode(1)).toEqual({ ok: false, error: 'mock restart failure' });
    expect(t.api.singbox.select.mock.calls).toEqual([['proxy', 'B']]);
    expect(order(t.api.singbox.select)[0]).toBeLessThan(restartAt(t));
    expect(t.api.singbox.getStatus).toHaveBeenCalledTimes(1);
    expect(t.api.systemProxy.disable).toHaveBeenCalledTimes(1);
    expect(t.pending()).toBe(false);
  });

  it('a pick while the watchdog brings the core back (connecting) skips the live switch and restarts (B1)', async () => {
    const t = await setup();
    await connected(t);
    t.setStatus('connecting');
    expect(await t.connection.switchNode(1)).toEqual({ ok: true });
    expect(t.api.singbox.restart).toHaveBeenCalledTimes(1);
    expect(t.api.config.generate.mock.calls[0][1]).toBe(1);
    expect(t.api.singbox.select.mock.calls).toEqual([['proxy', 'B']]);
    expect(order(t.api.singbox.select)[0]).toBeGreaterThan(restartAt(t));
    expect(t.api.systemProxy.enable).not.toHaveBeenCalled();
    expect(t.api.systemProxy.disable).not.toHaveBeenCalled();
  });

  it('and when that restart fails, restores the proxy once the core is down (N4)', async () => {
    const t = await setup();
    await connected(t);
    t.setStatus('connecting');
    t.api.singbox.restart.mockResolvedValueOnce({ success: false, error: 'mock restart failure' });
    expect(await t.connection.switchNode(1)).toEqual({ ok: false, error: 'mock restart failure' });
    expect(t.api.singbox.select).not.toHaveBeenCalled();
    expect(t.api.systemProxy.disable).toHaveBeenCalledTimes(1);
    expect(t.pending()).toBe(false);
  });
});

describe('the system proxy follows the restarted core (D12)', () => {
  it('a pending port change moves it after the restart', async () => {
    const t = await setup();
    expect(await t.connection.connect()).toMatchObject({ ok: true });
    expect(t.api.systemProxy.enable.mock.calls).toEqual([['127.0.0.1', 7890]]);
    t.setStatus('connected');
    vi.clearAllMocks();
    t.settings({ mixedPort: 7891 }); // typed in Settings while connected (updateAndFlag)
    t.pendingApply.markPendingIfLive();

    expect(await t.connection.switchNode(1)).toEqual({ ok: true });
    expect(t.api.config.generate.mock.calls[0][2].mixedPort).toBe(7891);
    expect(t.api.systemProxy.enable.mock.calls).toEqual([['127.0.0.1', 7891]]);
    expect(order(t.api.systemProxy.enable)[0]).toBeGreaterThan(restartAt(t));
    expect(order(t.api.systemProxy.enable)[0]).toBeLessThan(order(t.api.singbox.select)[0]);
    expect(t.api.systemProxy.disable).not.toHaveBeenCalled();
    expect(t.pending()).toBe(false);
  });

  it('a failure to move it stops the core, restores the proxy and says why', async () => {
    const t = await setup();
    await connected(t);
    t.settings({ mixedPort: 7891 });
    t.pendingApply.markPendingIfLive();
    t.api.systemProxy.enable.mockResolvedValueOnce(false);

    expect(await t.connection.switchNode(1)).toEqual({
      ok: false,
      error:
        "Couldn't move the Windows system proxy to the new port, so the connection was stopped (apps would not have used it). " +
        'The Logs page has the reason.',
    });
    expect(t.api.singbox.stop).toHaveBeenCalledTimes(1);
    expect(order(t.api.singbox.stop)[0]).toBeGreaterThan(restartAt(t));
    expect(t.api.systemProxy.disable).toHaveBeenCalledTimes(1);
    // Stopped before the node was confirmed.
    expect(t.api.singbox.select).not.toHaveBeenCalled();
  });

  it('TUN mode and an unchanged port leave it alone', async () => {
    const tun = await setup();
    tun.api.app.isAdmin.mockResolvedValue(true);
    tun.settings({ proxyMode: 'tun' });
    expect(await tun.connection.connect()).toMatchObject({ ok: true });
    expect(tun.api.systemProxy.enable).not.toHaveBeenCalled();
    tun.setStatus('connected');
    tun.settings({ mixedPort: 7891 });
    tun.pendingApply.markPendingIfLive();
    expect(await tun.connection.switchNode(1)).toEqual({ ok: true });
    expect(tun.api.singbox.restart).toHaveBeenCalledTimes(1);
    expect(tun.api.systemProxy.enable).not.toHaveBeenCalled();
    expect(tun.api.systemProxy.disable).not.toHaveBeenCalled();

    const same = await setup();
    await connected(same);
    same.useNodeStore.getState().setNodes([NODES[0], { ...NODES[1], password: 'rotated' }]);
    same.pendingApply.markPendingIfLive();
    expect(await same.connection.switchNode(1)).toEqual({ ok: true });
    expect(same.api.singbox.restart).toHaveBeenCalledTimes(1);
    expect(same.api.systemProxy.enable).not.toHaveBeenCalled();
    expect(same.api.systemProxy.disable).not.toHaveBeenCalled();
  });

  it('a pending switch from Manual to System Proxy turns it on, and the reverse turns it off (Deviation 5)', async () => {
    const toSystem = await setup();
    toSystem.settings({ proxyMode: 'manual' });
    await connected(toSystem);
    loseSelectionWithChangePending(toSystem);
    toSystem.settings({ proxyMode: 'system' }); // the mode button; its Apply now is refused
    expect(await toSystem.connection.applyPendingChanges()).toEqual({ ok: false, error: 'Select a node first.' });
    expect(await toSystem.connection.switchNode(0)).toEqual({ ok: true });
    expect(toSystem.api.systemProxy.enable.mock.calls).toEqual([['127.0.0.1', 7890]]);
    expect(order(toSystem.api.systemProxy.enable)[0]).toBeGreaterThan(restartAt(toSystem));
    expect(toSystem.api.singbox.stop).not.toHaveBeenCalled();
    expect(toSystem.pending()).toBe(false);

    const toManual = await setup();
    await connected(toManual);
    loseSelectionWithChangePending(toManual);
    toManual.settings({ proxyMode: 'manual' });
    expect(await toManual.connection.switchNode(0)).toEqual({ ok: true });
    expect(toManual.api.systemProxy.disable).toHaveBeenCalledTimes(1);
    expect(order(toManual.api.systemProxy.disable)[0]).toBeGreaterThan(restartAt(toManual));
    expect(toManual.api.systemProxy.enable).not.toHaveBeenCalled();
    expect(toManual.pending()).toBe(false);
  });
});

describe('Split rules after a restart (Deviation 5)', () => {
  it('a rule target that was pending is selected after the restart; a restart with nothing pending leaves the rules alone', async () => {
    const t = await setup();
    t.api.app.isAdmin.mockResolvedValue(true);
    t.settings({ proxyMode: 'split', splitRules: [SPLIT_RULE] });
    expect(await t.connection.connect()).toMatchObject({ ok: true });
    expect(t.api.singbox.select.mock.calls).toEqual([
      ['proxy', 'A'],
      ['split:rule-1', 'direct'],
    ]);

    // Nothing pending, and the live switch is confirmed wrong: the restart selects the node only.
    t.setStatus('connected');
    t.api.singbox.select.mockClear();
    t.api.singbox.getSelection.mockResolvedValueOnce({ success: true, now: 'A' });
    expect(await t.connection.switchNode(1)).toEqual({ ok: true });
    expect(t.api.singbox.restart).toHaveBeenCalledTimes(1);
    expect(t.api.singbox.select.mock.calls).toEqual([
      ['proxy', 'B'],
      ['proxy', 'B'],
    ]);

    // B is removed and the rule's target changes while Apply now is refused.
    loseSelectionWithChangePending(t);
    t.settings({ splitRules: [{ ...SPLIT_RULE, outbound: 'proxy' }] });
    t.api.singbox.select.mockClear();
    expect(await t.connection.switchNode(0)).toEqual({ ok: true });
    expect(t.api.singbox.restart).toHaveBeenCalledTimes(2);
    expect(t.api.singbox.select.mock.calls).toEqual([
      ['proxy', 'A'],
      ['split:rule-1', 'proxy'],
    ]);
    expect(t.pending()).toBe(false);
  });
});

describe('changes made while a connect is starting (N1)', () => {
  it('a refresh during connect() leaves the flag up once connected', async () => {
    const t = await setup();
    let statusMeanwhile: string | undefined;
    t.api.singbox.start.mockImplementationOnce(async () => {
      // Main pushes nothing until the core reports started.
      statusMeanwhile = t.useNodeStore.getState().connectionStatus;
      t.pendingApply.markPendingIfLive(); // the scheduler's first refresh
      return { success: true };
    });
    expect(await t.connection.connect()).toMatchObject({ ok: true });
    expect(statusMeanwhile).toBe('disconnected');
    expect(t.pending()).toBe(true);
  });

  it('markPendingIfLive() while disconnected raises the flag only while a start is under way', async () => {
    const t = await setup();
    t.pendingApply.markPendingIfLive();
    expect(t.pending()).toBe(false);
    expect(t.pendingApply.changeIsLive()).toBe(false);

    let liveInside: boolean | undefined;
    const value = await t.pendingApply.whileStarting(async () => {
      liveInside = t.pendingApply.changeIsLive();
      t.pendingApply.markPendingIfLive();
      return 42;
    });
    expect(value).toBe(42);
    expect(liveInside).toBe(true);
    expect(t.pending()).toBe(true);

    // A start that throws stops counting too.
    t.setPending(false);
    await expect(
      t.pendingApply.whileStarting(async () => {
        throw new Error('mock start failure');
      })
    ).rejects.toThrow('mock start failure');
    t.pendingApply.markPendingIfLive();
    expect(t.pendingApply.changeIsLive()).toBe(false);
    expect(t.pending()).toBe(false);
  });

  it('a flag raised before connect() reads its input is cleared by a successful connect', async () => {
    const t = await setup();
    t.setPending(true);
    expect(await t.connection.connect()).toMatchObject({ ok: true });
    expect(t.pending()).toBe(false);
  });
});

describe('Apply now with no node selected (N4)', () => {
  it('refuses without stopping the core and keeps the flag; picking a node then applies the change', async () => {
    const t = await setup();
    await connected(t);
    loseSelectionWithChangePending(t);

    expect(await t.connection.applyPendingChanges()).toEqual({ ok: false, error: 'Select a node first.' });
    expect(t.api.singbox.stop).not.toHaveBeenCalled();
    expect(t.api.systemProxy.disable).not.toHaveBeenCalled();
    expect(t.api.singbox.start).not.toHaveBeenCalled();
    expect(t.pending()).toBe(true);

    expect(await t.connection.switchNode(0)).toEqual({ ok: true });
    expect(t.api.singbox.restart).toHaveBeenCalledTimes(1);
    expect(t.api.config.generate.mock.calls[0][0]).toEqual([NODES[1]]);
    expect(t.pending()).toBe(false);
  });
});

describe('splitTargetChangeMode', () => {
  it('reconnects while connecting or while the flag is up, switches live when connected, and does nothing otherwise', async () => {
    const t = await setup();
    const mode = () => t.connection.splitTargetChangeMode();
    t.setStatus('connecting');
    expect(mode()).toBe('reconnect');
    t.setPending(true);
    expect(mode()).toBe('reconnect');
    t.setStatus('connected');
    expect(mode()).toBe('reconnect');
    t.setPending(false);
    expect(mode()).toBe('live');
    t.setStatus('disconnected');
    expect(mode()).toBe('none');
    t.setPending(true);
    expect(mode()).toBe('none');
  });
});

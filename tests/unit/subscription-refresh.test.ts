import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Utf8, buildProxyLink } from '../../src/services/node-link';
import type { ProxyNode, Subscription } from '../../src/types';
import { installMockApi } from '../helpers/mock-api';

/**
 * The three subscription refresh paths (the Update button, Update All and the
 * auto-update scheduler, not the app updater) through the real stores and
 * storeRefreshHooks (audit P0-3). Subscription bodies come from a mocked
 * window.api.network.fetchUrl. Also the "Reconnect to apply" flag a refresh
 * raises while connected, and connect() clearing it.
 *
 * Every node is Shadowsocks on 127.0.0.1 and nothing is spawned: the core
 * calls in connect() go to the mock API.
 */

type Body = string | Error;

/** A subscription body of Shadowsocks links, base64 as providers serve it. */
function linkBody(entries: Array<{ name: string; password?: string }>): string {
  const links = entries.map(({ name, password }) => {
    const { link } = buildProxyLink({
      id: 'unused',
      name,
      type: 'shadowsocks',
      server: '127.0.0.1',
      port: 19199,
      method: 'aes-256-gcm',
      password: password ?? `pw-${name}`,
    });
    return link!;
  });
  return base64Utf8(links.join('\n'));
}

function subscription(id: string, name: string, extra: Partial<Subscription> = {}): Subscription {
  return {
    id,
    name,
    url: `https://subscription.example/${id}`,
    nodeCount: 0,
    autoUpdate: false,
    updateInterval: 12,
    enabled: true,
    ...extra,
  };
}

const MANUAL: ProxyNode = {
  id: 'manual-1',
  name: 'My own server',
  type: 'trojan',
  server: '127.0.0.1',
  port: 19198,
  password: 'trojan-password',
  tls: true,
};

/** Fresh store and service modules over a mock API whose fetchUrl serves `serve()`d bodies. */
async function setup(overrides: Record<string, Record<string, unknown>> = {}) {
  const bodies = new Map<string, Body>();
  const fetchUrl = vi.fn(async (url: string) => {
    const body = bodies.get(url);
    if (body instanceof Error) throw body;
    return body ?? '';
  });
  const mock = installMockApi({}, { ...overrides, network: { fetchUrl } });
  vi.resetModules();
  const { useNodeStore } = await import('../../src/store/nodeStore');
  const { useSubscriptionStore } = await import('../../src/store/subscriptionStore');
  const { usePendingApplyStore } = await import('../../src/store/pendingApplyStore');
  const autoUpdate = await import('../../src/services/auto-update');
  const { storeRefreshHooks } = await import('../../src/services/subscription-refresh');
  const connection = await import('../../src/services/connection');
  return {
    mock,
    fetchUrl,
    serve: (sub: Subscription, body: Body) => bodies.set(sub.url, body),
    useNodeStore,
    useSubscriptionStore,
    usePendingApplyStore,
    autoUpdate,
    storeRefreshHooks,
    connection,
    names: () => useNodeStore.getState().nodes.map((n) => n.name),
    sub: (id: string) => useSubscriptionStore.getState().subscriptions.find((s) => s.id === id)!,
    pending: () => usePendingApplyStore.getState().pending,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Provider A imported once (A1, A2, A3) after a manual node. */
async function withProviderA(t: Setup) {
  const subA = subscription('sub-a', 'Provider A');
  t.useSubscriptionStore.getState().setSubscriptions([subA]);
  t.useNodeStore.getState().setNodes([MANUAL]);
  t.serve(subA, linkBody([{ name: 'A1' }, { name: 'A2' }, { name: 'A3' }]));
  await t.autoUpdate.refreshSubscription(subA, t.storeRefreshHooks());
  return subA;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refreshSubscription (the Update button and the scheduler)', () => {
  it('merges a successful refresh in place, keeps the selection and stamps lastUpdate and nodeCount', async () => {
    const t = await setup();
    const subA = await withProviderA(t);
    const subB = subscription('sub-b', 'Provider B');
    t.useSubscriptionStore.getState().addSubscription(subB);
    t.serve(subB, linkBody([{ name: 'B1' }]));
    await t.autoUpdate.refreshSubscription(subB, t.storeRefreshHooks());
    expect(t.names()).toEqual(['My own server', 'A1', 'A2', 'A3', 'B1']);

    // Select A2. The provider then rotates A2's password, drops A3 and adds A4.
    t.useNodeStore.getState().setSelectedIndex(2);
    const selectedId = t.useNodeStore.getState().selectedNodeId;
    t.useSubscriptionStore.getState().updateSubscription('sub-a', { lastUpdate: 1 });
    t.serve(subA, linkBody([{ name: 'A1' }, { name: 'A2', password: 'rotated' }, { name: 'A4' }]));
    const onError = vi.fn();
    await t.autoUpdate.refreshSubscription(subA, t.storeRefreshHooks(onError));

    const { nodes, selectedNodeId, selectedIndex } = t.useNodeStore.getState();
    expect(t.names()).toEqual(['My own server', 'A1', 'A2', 'A4', 'B1']);
    expect(selectedNodeId).toBe(selectedId);
    expect(selectedIndex).toBe(2);
    expect(nodes[2].password).toBe('rotated');
    expect(t.sub('sub-a').nodeCount).toBe(3);
    expect(t.sub('sub-a').lastUpdate).toBeGreaterThan(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a failed or empty fetch keeps the nodes and reports through onError', async () => {
    const t = await setup();
    const subA = await withProviderA(t);
    t.useNodeStore.getState().setSelectedIndex(1);
    const nodes = t.useNodeStore.getState().nodes;
    const stamped = t.sub('sub-a').lastUpdate;

    const cases: Array<[Body, string]> = [
      [new Error('HTTP 403'), 'HTTP 403'],
      ['', 'Empty response from subscription URL'],
      ['hello: world\n', 'No valid proxy nodes found in subscription'],
    ];
    for (const [body, error] of cases) {
      const onError = vi.fn();
      t.serve(subA, body);
      await t.autoUpdate.refreshSubscription(subA, t.storeRefreshHooks(onError));
      expect(onError).toHaveBeenCalledWith('sub-a', error);
      expect(t.useNodeStore.getState().nodes).toBe(nodes);
      expect(t.useNodeStore.getState().selectedIndex).toBe(1);
      expect(t.sub('sub-a').lastUpdate).toBe(stamped);
    }
  });
});

describe('refreshAllSubscriptions (Update All)', () => {
  it('merges each subscription on its own: failed, empty and disabled ones keep their nodes and are listed', async () => {
    const t = await setup();
    const ok = subscription('sub-ok', 'Works');
    const blocked = subscription('sub-blocked', 'Blocked');
    const empty = subscription('sub-empty', 'Empty');
    const off = subscription('sub-off', 'Switched off', { enabled: false });
    t.useSubscriptionStore.getState().setSubscriptions([ok, blocked, empty, off]);
    // First import of each. The Update button refreshes a disabled subscription too.
    t.serve(ok, linkBody([{ name: 'OK1' }, { name: 'OK2' }]));
    t.serve(blocked, linkBody([{ name: 'F1' }]));
    t.serve(empty, linkBody([{ name: 'E1' }]));
    t.serve(off, linkBody([{ name: 'D1' }]));
    for (const s of [ok, blocked, empty, off]) await t.autoUpdate.refreshSubscription(s, t.storeRefreshHooks());
    // A manual node first, and an orphan whose subscription was deleted last.
    const orphan: ProxyNode = { ...MANUAL, id: 'orphan-1', name: 'Orphan', subscriptionId: 'sub-deleted' };
    t.useNodeStore.getState().setNodes([MANUAL, ...t.useNodeStore.getState().nodes, orphan]);
    expect(t.names()).toEqual(['My own server', 'OK1', 'OK2', 'F1', 'E1', 'D1', 'Orphan']);
    // The selected node belongs to the subscription that is about to fail.
    t.useNodeStore.getState().setSelectedIndex(3);
    const selectedId = t.useNodeStore.getState().selectedNodeId;
    const before = t.useNodeStore.getState().nodes;
    const ok2Id = before[2].id;
    for (const s of [ok, blocked, empty, off]) t.useSubscriptionStore.getState().updateSubscription(s.id, { lastUpdate: 1 });

    t.serve(ok, linkBody([{ name: 'OK2' }, { name: 'OK3' }])); // OK1 removed, OK3 added
    t.serve(blocked, new Error('HTTP 403'));
    t.serve(empty, '');
    t.serve(off, linkBody([{ name: 'D2' }])); // must not be fetched
    t.fetchUrl.mockClear();

    const errors = await t.autoUpdate.refreshAllSubscriptions(
      t.useSubscriptionStore.getState().subscriptions,
      t.storeRefreshHooks()
    );

    expect(errors).toEqual(['Blocked: HTTP 403', 'Empty: Empty response from subscription URL']);
    expect(t.fetchUrl.mock.calls.map(([url]) => url).sort()).toEqual([ok.url, blocked.url, empty.url].sort());
    expect(t.names()).toEqual(['My own server', 'OK2', 'OK3', 'F1', 'E1', 'D1', 'Orphan']);
    const after = t.useNodeStore.getState().nodes;
    // The successful one is merged: OK2 keeps its id.
    expect(after[1].id).toBe(ok2Id);
    // Everything outside it is the same object as before, in the same order.
    expect(after.filter((n) => n.subscriptionId !== 'sub-ok')).toEqual(
      before.filter((n) => n.subscriptionId !== 'sub-ok')
    );
    after.filter((n) => n.subscriptionId !== 'sub-ok').forEach((n) => expect(before).toContain(n));
    // The selection stays on the failing subscription's node.
    expect(t.useNodeStore.getState().selectedNodeId).toBe(selectedId);
    expect(after[t.useNodeStore.getState().selectedIndex].name).toBe('F1');
    // Only the one that updated is stamped.
    expect(t.sub('sub-ok').lastUpdate).toBeGreaterThan(1);
    expect(t.sub('sub-ok').nodeCount).toBe(2);
    for (const id of ['sub-blocked', 'sub-empty', 'sub-off']) expect(t.sub(id).lastUpdate).toBe(1);
  });

  it('returns nothing to show when every enabled subscription updates', async () => {
    const t = await setup();
    await withProviderA(t);
    t.serve(t.sub('sub-a'), linkBody([{ name: 'A1' }, { name: 'A2' }]));
    expect(await t.autoUpdate.refreshAllSubscriptions(t.useSubscriptionStore.getState().subscriptions, t.storeRefreshHooks())).toEqual([]);
    expect(t.names()).toEqual(['My own server', 'A1', 'A2']);
  });
});

describe('startAutoUpdateScheduler (subscriptions, not the app updater)', () => {
  it('refreshes a due subscription 5 s after start, through the store hooks', async () => {
    const t = await setup();
    vi.useFakeTimers();
    const due = subscription('sub-due', 'Due', { autoUpdate: true }); // never updated: due now
    const later = subscription('sub-later', 'Not due', { autoUpdate: true, lastUpdate: Date.now() });
    const manualOnly = subscription('sub-manual', 'No auto-update');
    t.useSubscriptionStore.getState().setSubscriptions([due, later, manualOnly]);
    t.serve(due, linkBody([{ name: 'S1' }]));
    t.serve(later, linkBody([{ name: 'L1' }]));
    t.serve(manualOnly, linkBody([{ name: 'M1' }]));

    const stop = t.autoUpdate.startAutoUpdateScheduler(t.storeRefreshHooks());
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(t.fetchUrl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(t.fetchUrl.mock.calls.map(([url]) => url)).toEqual([due.url]);
      expect(t.names()).toEqual(['S1']);
      expect(t.sub('sub-due')).toMatchObject({ nodeCount: 1, lastUpdate: Date.now() });
    } finally {
      stop();
    }
  });

  it('backs a failing subscription off for 30 minutes instead of retrying every minute; resetSubscriptionBackoff clears that', async () => {
    const t = await setup();
    vi.useFakeTimers();
    const blocked = subscription('sub-blocked', 'Blocked', { autoUpdate: true });
    t.useSubscriptionStore.getState().setSubscriptions([blocked]);
    t.serve(blocked, new Error('HTTP 403'));
    const onError = vi.fn();

    const stop = t.autoUpdate.startAutoUpdateScheduler(t.storeRefreshHooks(onError));
    try {
      await vi.advanceTimersByTimeAsync(5_000); // startup tick: fails
      expect(t.fetchUrl).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('sub-blocked', 'HTTP 403');

      await vi.advanceTimersByTimeAsync(60_000); // the next minute tick leaves it alone
      expect(t.fetchUrl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(28 * 60_000); // still inside the 30 minutes
      expect(t.fetchUrl).toHaveBeenCalledTimes(1);

      // Editing the subscription clears the penalty, so the next tick retries.
      t.autoUpdate.resetSubscriptionBackoff('sub-blocked');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.fetchUrl).toHaveBeenCalledTimes(2);

      // That failed too: the next retry comes once 30 minutes are up, not before.
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(t.fetchUrl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(t.fetchUrl).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });
});

describe('the "Reconnect to apply" flag', () => {
  it('a refresh that changes the nodes while connected raises it', async () => {
    const t = await setup();
    const subA = await withProviderA(t);
    t.useNodeStore.getState().setConnectionStatus('connected');
    t.serve(subA, linkBody([{ name: 'A1' }, { name: 'A2', password: 'rotated' }, { name: 'A3' }]));
    await t.autoUpdate.refreshSubscription(subA, t.storeRefreshHooks());
    expect(t.pending()).toBe(true);
  });

  it('so does Update All, and so does a change while the watchdog restarts the core (connecting)', async () => {
    const t = await setup();
    const subA = await withProviderA(t);
    t.useNodeStore.getState().setConnectionStatus('connecting');
    t.serve(subA, linkBody([{ name: 'A1' }]));
    await t.autoUpdate.refreshAllSubscriptions(t.useSubscriptionStore.getState().subscriptions, t.storeRefreshHooks());
    expect(t.pending()).toBe(true);
  });

  it('a change while disconnected does not raise it: the next connect uses the new nodes anyway', async () => {
    const t = await setup();
    const subA = await withProviderA(t);
    expect(t.pending()).toBe(false); // the first import was disconnected too
    t.serve(subA, linkBody([{ name: 'A1', password: 'rotated' }]));
    await t.autoUpdate.refreshSubscription(subA, t.storeRefreshHooks());
    expect(t.names()).toEqual(['My own server', 'A1']);
    expect(t.pending()).toBe(false);
  });

  it('a refresh that changes nothing does not raise it', async () => {
    const t = await setup();
    const subA = await withProviderA(t);
    t.useNodeStore.getState().setConnectionStatus('connected');
    const nodes = t.useNodeStore.getState().nodes;
    t.serve(subA, linkBody([{ name: 'A1' }, { name: 'A2' }, { name: 'A3' }]));
    await t.autoUpdate.refreshSubscription(subA, t.storeRefreshHooks());
    expect(t.useNodeStore.getState().nodes).toBe(nodes);
    expect(t.pending()).toBe(false);
  });

  it('connect() clears it once the new core is up; a failed start leaves it raised', async () => {
    let active: string | undefined;
    const t = await setup({
      singbox: {
        select: vi.fn(async (_selector: string, outbound: string) => {
          active = outbound;
          return { success: true };
        }),
        getSelection: vi.fn(async () => ({ success: true, now: active })),
      },
    });
    await withProviderA(t);
    t.useNodeStore.getState().setSelectedIndex(1);
    t.usePendingApplyStore.getState().setPending(true);

    t.mock.api.singbox.start.mockResolvedValueOnce({ success: false, error: 'mock start failure' });
    expect(await t.connection.connect()).toMatchObject({ ok: false });
    expect(t.pending()).toBe(true);

    expect(await t.connection.connect()).toMatchObject({ ok: true });
    expect(active).toBe('A1');
    expect(t.pending()).toBe(false);
  });

  it('applyPendingChanges drops the flag when nothing is live, and reconnects when something is', async () => {
    let active: string | undefined;
    const t = await setup({
      singbox: {
        select: vi.fn(async (_selector: string, outbound: string) => {
          active = outbound;
          return { success: true };
        }),
        getSelection: vi.fn(async () => ({ success: true, now: active })),
      },
    });
    await withProviderA(t);
    t.useNodeStore.getState().setSelectedIndex(1);

    t.usePendingApplyStore.getState().setPending(true);
    expect(await t.connection.applyPendingChanges()).toBeNull();
    expect(t.pending()).toBe(false);
    expect(t.mock.api.singbox.stop).not.toHaveBeenCalled();

    t.useNodeStore.getState().setConnectionStatus('connected');
    t.usePendingApplyStore.getState().setPending(true);
    vi.useFakeTimers(); // reconnect() pauses 800 ms between stop and start
    const applying = t.connection.applyPendingChanges();
    await vi.advanceTimersByTimeAsync(800);
    expect(await applying).toMatchObject({ ok: true });
    expect(t.mock.api.singbox.stop).toHaveBeenCalledTimes(1);
    expect(t.mock.api.singbox.start).toHaveBeenCalledTimes(1);
    expect(t.pending()).toBe(false);
  });
});

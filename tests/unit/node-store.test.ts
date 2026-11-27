import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProxyNode } from '../../src/types';
import { installMockApi } from '../helpers/mock-api';

/**
 * src/store/nodeStore.ts: the selection is held by id (selectedNodeId) and the
 * index is derived from it (audit P0-3), and data saved before this round,
 * which has selectedIndex only, migrates without losing the selection, as does
 * data an older build wrote after this one. The store module is imported fresh
 * for each test over a mocked window.api.store, as the app does on launch.
 */

async function freshStore(stored: Record<string, unknown> = {}) {
  const mock = installMockApi(stored);
  vi.resetModules();
  const { useNodeStore } = await import('../../src/store/nodeStore');
  return { mock, useNodeStore };
}

/** Lets the saves that actions start without awaiting them finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A Shadowsocks node on loopback; nothing dials it. */
function ss(id: string, name: string, subscriptionId?: string): ProxyNode {
  return {
    id,
    name,
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19199,
    method: 'aes-256-gcm',
    password: `pw-${id}`,
    ...(subscriptionId ? { subscriptionId } : {}),
  };
}

interface SelectionState {
  nodes: ProxyNode[];
  selectedNodeId: string | null;
  selectedIndex: number;
}

/** The selection is `id`, and the index is that node's position (or -1). */
function expectSelection(state: SelectionState, id: string | null) {
  expect(state.selectedNodeId).toBe(id);
  if (id === null) {
    expect(state.selectedIndex).toBe(-1);
  } else {
    expect(state.selectedIndex).toBe(state.nodes.findIndex((n) => n.id === id));
    expect(state.selectedIndex).toBeGreaterThanOrEqual(0);
  }
}

/**
 * Nodes as an install from before this round saved them: two subscriptions
 * and a manual node, ids from the app's own generator, no test results (those
 * were never saved). Dummy credentials; everything points at loopback.
 */
const STORED_NODES: ProxyNode[] = [
  {
    id: 'm1x8k2q9h3a7f',
    name: '🇭🇰 香港 01',
    type: 'vmess',
    server: '127.0.0.1',
    port: 19193,
    uuid: '2420e4a1-e97c-4780-a7a0-f47b2a402ba7',
    alterId: 0,
    security: 'auto',
    tls: true,
    sni: 'example.com',
    transportType: 'ws',
    transportPath: '/ws',
    subscriptionId: 'm1x8k0a1sub01',
    country: 'HK',
  },
  {
    id: 'm1x8k2q9j5c2d',
    name: '🇯🇵 日本 02',
    type: 'shadowsocks',
    server: '127.0.0.1',
    port: 19194,
    method: 'aes-256-gcm',
    password: 'ss-password',
    subscriptionId: 'm1x8k0a1sub01',
    country: 'JP',
  },
  {
    id: 'm1x9p4r7t1v6w',
    name: 'US hy2',
    type: 'hysteria2',
    server: '127.0.0.1',
    port: 19195,
    password: 'hy2-password',
    tls: true,
    sni: 'example.com',
    subscriptionId: 'm1x9p0b2sub02',
    country: 'US',
  },
  {
    id: 'm1y2c3d4e5f6g',
    name: 'My own server',
    type: 'trojan',
    server: '127.0.0.1',
    port: 19196,
    password: 'trojan-password',
    tls: true,
    sni: 'example.com',
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('nodeStore: the selection follows the node, not the index', () => {
  it('every action keeps the selected id, and selectedIndex follows', async () => {
    const { useNodeStore } = await freshStore();
    const s = () => useNodeStore.getState();
    const [n0, n1, n2, n3, n4] = [
      ss('n0', 'Node 0', 'sub-y'),
      ss('n1', 'Node 1', 'sub-x'),
      ss('n2', 'Node 2', 'sub-y'),
      ss('n3', 'Node 3', 'sub-x'),
      ss('n4', 'Node 4'),
    ];

    s().setNodes([n0, n1, n2, n3, n4]);
    s().setSelectedIndex(2);
    expectSelection(s(), 'n2');

    s().reorderNodes(2, 4); // n0 n1 n3 n4 n2
    expectSelection(s(), 'n2');
    expect(s().selectedIndex).toBe(4);

    s().reorderNodes(0, 4); // n1 n3 n4 n2 n0
    expect(s().selectedIndex).toBe(3);

    s().moveNodeToTop('n4'); // n4 n1 n3 n2 n0
    expectSelection(s(), 'n2');
    expect(s().selectedIndex).toBe(3);

    s().moveNodeToTop('n2'); // n2 n4 n1 n3 n0
    expect(s().selectedIndex).toBe(0);

    s().removeNode('n4'); // n2 n1 n3 n0
    s().addNode(ss('n5', 'Node 5')); // n2 n1 n3 n0 n5
    s().removeNodes(['n1', 'n0']); // n2 n3 n5
    expectSelection(s(), 'n2');

    s().removeNodesBySubscription('sub-x'); // n2 n5
    s().updateNode('n2', { name: 'Renamed' });
    expectSelection(s(), 'n2');
    expect(s().nodes.map((n) => n.id)).toEqual(['n2', 'n5']);

    s().setNodes([ss('n5', 'Node 5'), ss('n6', 'Node 6'), ss('n2', 'Node 2')]);
    expectSelection(s(), 'n2');
    expect(s().selectedIndex).toBe(2);
  });

  it('removing the selected node clears the selection, whichever action removes it', async () => {
    const removals: Array<(state: any) => void> = [
      (state) => state.removeNode('n1'),
      (state) => state.removeNodes(['n1', 'n2']),
      (state) => state.removeNodesBySubscription('sub-x'),
      (state) => state.setNodes([ss('n0', 'Node 0'), ss('n2', 'Node 2')]),
    ];
    for (const remove of removals) {
      const { useNodeStore } = await freshStore();
      useNodeStore.getState().setNodes([ss('n0', 'Node 0'), ss('n1', 'Node 1', 'sub-x'), ss('n2', 'Node 2')]);
      useNodeStore.getState().setSelectedIndex(1);
      expectSelection(useNodeStore.getState(), 'n1');
      remove(useNodeStore.getState());
      expectSelection(useNodeStore.getState(), null);
      // Let the saves the actions started finish before the mock API goes away.
      await settle();
      vi.unstubAllGlobals();
    }
  });

  it('addNode selects the new node when nothing is selected, and only then', async () => {
    const { useNodeStore } = await freshStore();
    const s = () => useNodeStore.getState();
    s().addNode(ss('a', 'A'));
    expectSelection(s(), 'a');
    s().addNode(ss('b', 'B'));
    expectSelection(s(), 'a');
    s().removeNode('a');
    expectSelection(s(), null);
    s().addNode(ss('c', 'C'));
    expectSelection(s(), 'c');
    expect(s().selectedIndex).toBe(1);
  });

  it('setNodes re-derives the index from the id', async () => {
    const { useNodeStore } = await freshStore();
    const s = () => useNodeStore.getState();
    s().setNodes([ss('n0', 'Node 0'), ss('n1', 'Node 1'), ss('n2', 'Node 2')]);
    s().setSelectedIndex(1);
    s().setNodes([ss('n2', 'Node 2'), ss('n1', 'Node 1')]);
    expectSelection(s(), 'n1');
    expect(s().selectedIndex).toBe(1);
    s().setNodes([ss('n9', 'Node 9')]);
    expectSelection(s(), null);
  });

  it('setSelectedIndex selects the node at that index by its id; an index with no node selects nothing', async () => {
    const { useNodeStore } = await freshStore();
    const s = () => useNodeStore.getState();
    s().setNodes([ss('n0', 'Node 0'), ss('n1', 'Node 1')]);
    s().setSelectedIndex(1);
    expectSelection(s(), 'n1');
    s().setSelectedIndex(5);
    expectSelection(s(), null);
    s().setSelectedIndex(0);
    s().setSelectedIndex(-1);
    expectSelection(s(), null);
  });

  it('saves nodes, selectedNodeId (null when nothing is selected, never undefined) and the derived selectedIndex', async () => {
    const { mock, useNodeStore } = await freshStore();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = () => useNodeStore.getState();

    await s().saveToStore();
    expect(mock.store.get('selectedNodeId')).toBeNull();
    expect(mock.store.get('selectedIndex')).toBe(-1);

    s().setNodes([ss('n0', 'Node 0'), ss('n1', 'Node 1')]);
    await settle();
    expect(mock.store.get('nodes')).toEqual([ss('n0', 'Node 0'), ss('n1', 'Node 1')]);
    expect(mock.store.get('selectedNodeId')).toBeNull();
    expect(mock.store.get('selectedIndex')).toBe(-1);

    s().setSelectedIndex(1);
    await settle();
    expect(mock.store.get('selectedNodeId')).toBe('n1');
    expect(mock.store.get('selectedIndex')).toBe(1);

    s().reorderNodes(1, 0);
    await settle();
    expect(mock.store.get('selectedNodeId')).toBe('n1');
    expect(mock.store.get('selectedIndex')).toBe(0);

    // The mock refuses undefined as electron-store does; nothing was refused.
    expect(mock.sets.every(([, value]) => value !== undefined)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('replaceSubscriptionNodes merges in place, keeps the selection and says whether anything changed', async () => {
    const { mock, useNodeStore } = await freshStore();
    const s = () => useNodeStore.getState();
    const a1 = ss('a1', 'A1', 'sub-a');
    const a2 = ss('a2', 'A2', 'sub-a');
    const b1 = ss('b1', 'B1', 'sub-b');
    s().setNodes([a1, a2, b1]);
    s().setSelectedIndex(1);
    await settle();
    const writes = mock.sets.length;

    // The provider reordered them and rotated the passwords; the fetcher gave new ids.
    const fresh = [
      { ...a2, id: 'fresh-2', password: 'rotated-2' },
      { ...a1, id: 'fresh-1', password: 'rotated-1' },
    ];
    expect(s().replaceSubscriptionNodes('sub-a', fresh)).toBe(true);
    expect(s().nodes.map((n) => [n.id, n.password])).toEqual([
      ['a1', 'rotated-1'],
      ['a2', 'rotated-2'],
      ['b1', 'pw-b1'],
    ]);
    expectSelection(s(), 'a2');
    expect(s().selectedIndex).toBe(1);
    await settle();
    expect(mock.sets.length).toBe(writes + 3);
    expect(mock.store.get('nodes')).toEqual(s().nodes);
    expect(mock.store.get('selectedNodeId')).toBe('a2');

    // The same refresh again: false, the same array, nothing written.
    const nodesBefore = s().nodes;
    const again = fresh.map((n) => ({ ...n, id: `again-${n.id}` }));
    expect(s().replaceSubscriptionNodes('sub-a', again)).toBe(false);
    await settle();
    expect(s().nodes).toBe(nodesBefore);
    expect(mock.sets.length).toBe(writes + 3);

    // A refresh without the selected node clears the selection.
    expect(s().replaceSubscriptionNodes('sub-a', [{ ...a1, id: 'fresh-3', password: 'rotated-1' }])).toBe(true);
    expectSelection(s(), null);
    expect(s().nodes.map((n) => n.id)).toEqual(['a1', 'b1']);
  });
});

describe('nodeStore: loading data saved before selectedNodeId existed', () => {
  it('selectedIndex 1 and no selectedNodeId → nodes[1], by id, saved once', async () => {
    const { mock, useNodeStore } = await freshStore({ nodes: STORED_NODES, selectedIndex: 1 });
    await useNodeStore.getState().loadFromStore();
    const state = useNodeStore.getState();
    expect(state.nodes).toEqual(STORED_NODES);
    expectSelection(state, STORED_NODES[1].id);
    expect(state.selectedIndex).toBe(1);
    expect(mock.sets.map(([key]) => key)).toEqual(['nodes', 'selectedNodeId', 'selectedIndex']);
    expect(mock.store.get('nodes')).toEqual(STORED_NODES);
    expect(mock.store.get('selectedNodeId')).toBe(STORED_NODES[1].id);
    expect(mock.store.get('selectedIndex')).toBe(1);
  });

  it('the next launch reads the selection by id and writes nothing', async () => {
    const first = await freshStore({ nodes: STORED_NODES, selectedIndex: 2 });
    await first.useNodeStore.getState().loadFromStore();
    const saved = Object.fromEntries(first.mock.store);
    vi.unstubAllGlobals();

    const second = await freshStore(saved);
    await second.useNodeStore.getState().loadFromStore();
    expectSelection(second.useNodeStore.getState(), STORED_NODES[2].id);
    expect(second.mock.sets).toEqual([]);
  });

  it('web mode, which reads the absent key as null, migrates the same way (Deviation B5-02)', async () => {
    const { mock, useNodeStore } = await freshStore({ nodes: STORED_NODES, selectedIndex: 3, selectedNodeId: null });
    await useNodeStore.getState().loadFromStore();
    expectSelection(useNodeStore.getState(), STORED_NODES[3].id);
    expect(useNodeStore.getState().selectedIndex).toBe(3);
    expect(mock.sets.map(([key]) => key)).toEqual(['nodes', 'selectedNodeId', 'selectedIndex']);
    expect(mock.store.get('selectedNodeId')).toBe(STORED_NODES[3].id);
  });

  it('selectedIndex -1 → nothing selected; the new key is still written once', async () => {
    const { mock, useNodeStore } = await freshStore({ nodes: STORED_NODES, selectedIndex: -1 });
    await useNodeStore.getState().loadFromStore();
    expectSelection(useNodeStore.getState(), null);
    expect(useNodeStore.getState().nodes).toEqual(STORED_NODES);
    expect(mock.sets.map(([key]) => key)).toEqual(['nodes', 'selectedNodeId', 'selectedIndex']);
    expect(mock.store.get('selectedNodeId')).toBeNull();
  });

  it('an index out of range, or not an integer, → nothing selected, nodes intact', async () => {
    for (const selectedIndex of [4, 99, 1.5, '1', null, undefined]) {
      const stored: Record<string, unknown> = { nodes: STORED_NODES };
      if (selectedIndex !== undefined) stored.selectedIndex = selectedIndex;
      const { useNodeStore } = await freshStore(stored);
      await useNodeStore.getState().loadFromStore();
      expectSelection(useNodeStore.getState(), null);
      expect(useNodeStore.getState().nodes).toEqual(STORED_NODES);
      vi.unstubAllGlobals();
    }
  });

  it('no nodes key, or one that is not a list → an empty list', async () => {
    for (const stored of [{}, { nodes: null }, { nodes: { not: 'a list' } }, { selectedIndex: 0 }]) {
      const { useNodeStore } = await freshStore(stored);
      await useNodeStore.getState().loadFromStore();
      expect(useNodeStore.getState().nodes).toEqual([]);
      expectSelection(useNodeStore.getState(), null);
      vi.unstubAllGlobals();
    }
  });

  it('a stored selectedNodeId with the index saved next to it, or with an index that names no node → the id, and nothing is written', async () => {
    // 2 is the id's position, the pair this store saves. The others name no
    // node, so they can't point anywhere else.
    for (const selectedIndex of [2, -1, 99, 1.5, null, undefined]) {
      const stored: Record<string, unknown> = { nodes: STORED_NODES, selectedNodeId: STORED_NODES[2].id };
      if (selectedIndex !== undefined) stored.selectedIndex = selectedIndex;
      const { mock, useNodeStore } = await freshStore(stored);
      await useNodeStore.getState().loadFromStore();
      expectSelection(useNodeStore.getState(), STORED_NODES[2].id);
      expect(useNodeStore.getState().selectedIndex).toBe(2);
      expect(mock.sets).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it('a stored selectedNodeId that no node has, and no index that names a node → nothing selected, nothing written', async () => {
    for (const selectedIndex of [-1, 4, undefined]) {
      const stored: Record<string, unknown> = { nodes: STORED_NODES, selectedNodeId: 'gone' };
      if (selectedIndex !== undefined) stored.selectedIndex = selectedIndex;
      const { mock, useNodeStore } = await freshStore(stored);
      await useNodeStore.getState().loadFromStore();
      expectSelection(useNodeStore.getState(), null);
      expect(useNodeStore.getState().nodes).toEqual(STORED_NODES);
      expect(mock.sets).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it('a selected node without an id gets a fresh one and stays selected', async () => {
    const { id: _dropped, ...withoutId } = STORED_NODES[1];
    const nodes = [STORED_NODES[0], withoutId, STORED_NODES[2]];
    const { mock, useNodeStore } = await freshStore({ nodes, selectedIndex: 1 });
    await useNodeStore.getState().loadFromStore();
    const state = useNodeStore.getState();
    expect(state.selectedIndex).toBe(1);
    // The app's id shape: base-36 time, then base-36 random digits.
    expect(state.selectedNodeId).toMatch(/^[0-9a-z]{8,}$/);
    expect(state.nodes[1]).toEqual({ ...withoutId, id: state.selectedNodeId });
    expect(state.nodes[0]).toEqual(STORED_NODES[0]);
    expect(state.nodes[2]).toEqual(STORED_NODES[2]);
    expect(mock.store.get('nodes')).toEqual(state.nodes);
    expect(mock.store.get('selectedNodeId')).toBe(state.selectedNodeId);
  });

  it('a selected node whose id an earlier node also has gets a fresh one; a later duplicate changes nothing', async () => {
    const earlier = [STORED_NODES[0], { ...STORED_NODES[1], id: STORED_NODES[0].id }, STORED_NODES[2]];
    const first = await freshStore({ nodes: earlier, selectedIndex: 1 });
    await first.useNodeStore.getState().loadFromStore();
    const state = first.useNodeStore.getState();
    expect(state.selectedIndex).toBe(1);
    expect(state.selectedNodeId).not.toBe(STORED_NODES[0].id);
    expect(state.nodes[1]).toEqual({ ...STORED_NODES[1], id: state.selectedNodeId });
    expect(state.nodes[0]).toEqual(STORED_NODES[0]);
    vi.unstubAllGlobals();

    const later = [STORED_NODES[0], STORED_NODES[1], { ...STORED_NODES[2], id: STORED_NODES[1].id }];
    const second = await freshStore({ nodes: later, selectedIndex: 1 });
    await second.useNodeStore.getState().loadFromStore();
    expectSelection(second.useNodeStore.getState(), STORED_NODES[1].id);
    expect(second.useNodeStore.getState().selectedIndex).toBe(1);
    expect(second.useNodeStore.getState().nodes).toEqual(later);
  });
});

/**
 * The installed 1.4.0 and a dev build of this one share
 * %APPDATA%\singbox-proxy-manager. 1.4.0 reads and writes only `nodes` and
 * `selectedIndex`, so after it has run, the selectedNodeId this build saved is
 * still there, stale. Each test saves through this build first, then writes
 * what 1.4.0's own code would write on top.
 */
describe('nodeStore: an older build ran on the data since this one saved it', () => {
  /** The keys this build saves on its first launch over pre-round data with `selectedIndex`. */
  async function savedByThisBuild(selectedIndex: number): Promise<Record<string, unknown>> {
    const first = await freshStore({ nodes: STORED_NODES, selectedIndex });
    await first.useNodeStore.getState().loadFromStore();
    const saved = Object.fromEntries(first.mock.store);
    vi.unstubAllGlobals();
    expect(saved.selectedNodeId).toBe(STORED_NODES[selectedIndex].id);
    return saved;
  }

  it("1.4.0 refreshed the selected node's subscription → the node at the stored index, the one 1.4.0 showed; saved once", async () => {
    const saved = await savedByThisBuild(1); // 🇯🇵 日本 02, first subscription
    // 1.4.0's refresh: setNodes([...others, ...fresh]) with the fetcher's new
    // ids, selectedIndex left as it was. So the stored id names no node.
    const sub = STORED_NODES[1].subscriptionId;
    const fresh = STORED_NODES.filter((n) => n.subscriptionId === sub).map((n, i) => ({ ...n, id: `m2b7fresh0${i}` }));
    const nodes = [...STORED_NODES.filter((n) => n.subscriptionId !== sub), ...fresh];
    const { mock, useNodeStore } = await freshStore({ ...saved, nodes });
    await useNodeStore.getState().loadFromStore();
    expect(useNodeStore.getState().nodes).toEqual(nodes);
    expectSelection(useNodeStore.getState(), nodes[1].id);
    expect(mock.sets.map(([key]) => key)).toEqual(['nodes', 'selectedNodeId', 'selectedIndex']);
    expect(mock.store.get('selectedNodeId')).toBe(nodes[1].id);
    expect(mock.store.get('selectedIndex')).toBe(1);
  });

  it('a node picked in 1.4.0 → that node, saved once; the launch after reads it by id', async () => {
    const saved = await savedByThisBuild(2); // US hy2
    // 1.4.0's setSelectedIndex(0) saves nodes and the new index; the id stays.
    const { mock, useNodeStore } = await freshStore({ ...saved, selectedIndex: 0 });
    await useNodeStore.getState().loadFromStore();
    expect(useNodeStore.getState().nodes).toEqual(STORED_NODES);
    expectSelection(useNodeStore.getState(), STORED_NODES[0].id);
    expect(mock.sets.map(([key]) => key)).toEqual(['nodes', 'selectedNodeId', 'selectedIndex']);
    const resaved = Object.fromEntries(mock.store);
    vi.unstubAllGlobals();

    const next = await freshStore(resaved);
    await next.useNodeStore.getState().loadFromStore();
    expectSelection(next.useNodeStore.getState(), STORED_NODES[0].id);
    expect(next.mock.sets).toEqual([]);
  });

  it('a 1.4.0 change that kept its index on the selected node → the id, nothing written', async () => {
    const saved = await savedByThisBuild(2); // US hy2
    // 1.4.0's moveNodeToTop('My own server') moves its index along with the selected node.
    const nodes = [STORED_NODES[3], STORED_NODES[0], STORED_NODES[1], STORED_NODES[2]];
    const { mock, useNodeStore } = await freshStore({ ...saved, nodes, selectedIndex: 3 });
    await useNodeStore.getState().loadFromStore();
    expectSelection(useNodeStore.getState(), STORED_NODES[2].id);
    expect(useNodeStore.getState().selectedIndex).toBe(3);
    expect(mock.sets).toEqual([]);
  });
});

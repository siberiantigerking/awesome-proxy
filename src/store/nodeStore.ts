import { create } from 'zustand';
import type { ProxyNode, ConnectionStatus, NodeTestKind } from '../types';
import { mergeSubscriptionNodes } from '../services/subscription-merge';

interface NodeStore {
  nodes: ProxyNode[];
  /**
   * The selected node's id, or null when nothing is selected. This is the
   * selection; `selectedIndex` is derived from it.
   *
   * The selection used to be a bare index, which every change to the list had
   * to remember to adjust. A subscription refresh didn't, so the index went on
   * pointing at whichever node moved into that slot, and the next reconnect
   * routed through a node the user never picked (audit P0-3). An id stays with
   * its node through refreshes, reordering and the deletion of other nodes.
   */
  selectedNodeId: string | null;
  /**
   * Index of the selected node in `nodes`, or -1. Every action that changes
   * the list or the selection recomputes it from selectedNodeId
   * (selectionFor); it is never set on its own. It stays because the pages,
   * connection.ts and node-tests.ts address the selected node by index.
   */
  selectedIndex: number;
  connectionStatus: ConnectionStatus;

  // Actions
  setNodes: (nodes: ProxyNode[]) => void;
  addNode: (node: ProxyNode) => void;
  updateNode: (id: string, updates: Partial<ProxyNode>) => void;
  removeNode: (id: string) => void;
  removeNodes: (ids: string[]) => void;
  setSelectedIndex: (index: number) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  updateLatency: (id: string, latency: number, kind?: NodeTestKind) => void;
  updateSpeed: (id: string, mbps: number) => void;
  updateUdp: (id: string, ok: boolean) => void;
  getSelectedNode: () => ProxyNode | null;
  reorderNodes: (fromIndex: number, toIndex: number) => void;
  moveNodeToTop: (id: string) => void;
  removeNodesBySubscription: (subscriptionId: string) => void;
  /**
   * Merge a subscription's freshly fetched nodes into the list in place
   * (services/subscription-merge.ts). Returns false, without saving, when the
   * refresh changed nothing.
   */
  replaceSubscriptionNodes: (subscriptionId: string, fresh: ProxyNode[]) => boolean;

  // Persistence
  loadFromStore: () => Promise<void>;
  saveToStore: () => Promise<void>;
}

/**
 * The selection fields for `id` in `nodes`: the first node with that id, or
 * nothing selected when no node has it any more. So removing the selected
 * node clears the selection, as deleting it always did.
 */
function selectionFor(nodes: ProxyNode[], id: string | null): { selectedNodeId: string | null; selectedIndex: number } {
  // `?.`: stored entries are only known to sit in an array, and a throw while
  // loading would leave the list empty for the next save to write back.
  const index = id === null ? -1 : nodes.findIndex((n) => n?.id === id);
  return { selectedNodeId: index >= 0 ? id : null, selectedIndex: index };
}

/** The id pattern the rest of the app uses (node-parser.ts, NodeManager.tsx). */
function newNodeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

export const useNodeStore = create<NodeStore>((set, get) => ({
  nodes: [],
  selectedNodeId: null,
  selectedIndex: -1,
  connectionStatus: 'disconnected',

  setNodes: (nodes) => {
    set({ nodes, ...selectionFor(nodes, get().selectedNodeId) });
    get().saveToStore();
  },

  addNode: (node) => {
    set((state) => {
      const nodes = [...state.nodes, node];
      // Auto-select the first node so it appears as the active node on the
      // dashboard immediately instead of requiring a manual selection.
      return { nodes, ...selectionFor(nodes, state.selectedNodeId ?? node.id) };
    });
    get().saveToStore();
  },

  updateNode: (id, updates) => {
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    }));
    get().saveToStore();
  },

  removeNode: (id) => {
    const { nodes, selectedNodeId } = get();
    if (!nodes.some((n) => n.id === id)) return;

    const newNodes = nodes.filter((n) => n.id !== id);
    set({ nodes: newNodes, ...selectionFor(newNodes, selectedNodeId) });
    get().saveToStore();
  },

  removeNodes: (ids) => {
    const { nodes, selectedNodeId } = get();
    const newNodes = nodes.filter((n) => !ids.includes(n.id));
    set({ nodes: newNodes, ...selectionFor(newNodes, selectedNodeId) });
    get().saveToStore();
  },

  // Selects the node at `index`, by its id.
  setSelectedIndex: (index) => {
    const { nodes } = get();
    set(selectionFor(nodes, nodes[index]?.id ?? null));
    get().saveToStore();
  },

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  // Test results are deliberately NOT persisted: a latency from last week is
  // worse than no number at all, and they'd bloat the store on large lists.
  updateLatency: (id, latency, kind = 'tcp') => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, latency, latencyKind: kind, lastTested: Date.now() } : n
      ),
    }));
  },

  updateSpeed: (id, mbps) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, speedMbps: mbps, lastTested: Date.now() } : n
      ),
    }));
  },

  updateUdp: (id, ok) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, udpOk: ok, lastTested: Date.now() } : n
      ),
    }));
  },

  getSelectedNode: () => {
    const { nodes, selectedIndex } = get();
    if (selectedIndex >= 0 && selectedIndex < nodes.length) {
      return nodes[selectedIndex];
    }
    return null;
  },

  reorderNodes: (fromIndex, toIndex) => {
    set((state) => {
      const newNodes = [...state.nodes];
      const [moved] = newNodes.splice(fromIndex, 1);
      newNodes.splice(toIndex, 0, moved);
      return { nodes: newNodes, ...selectionFor(newNodes, state.selectedNodeId) };
    });
    get().saveToStore();
  },

  moveNodeToTop: (id) => {
    set((state) => {
      const index = state.nodes.findIndex((n) => n.id === id);
      if (index <= 0) return state; // not found or already at top

      const newNodes = [...state.nodes];
      const [moved] = newNodes.splice(index, 1);
      newNodes.unshift(moved);
      return { nodes: newNodes, ...selectionFor(newNodes, state.selectedNodeId) };
    });
    get().saveToStore();
  },

  removeNodesBySubscription: (subscriptionId) => {
    const { nodes, selectedNodeId } = get();
    const newNodes = nodes.filter((n) => n.subscriptionId !== subscriptionId);
    if (newNodes.length === nodes.length) return; // nothing removed

    set({ nodes: newNodes, ...selectionFor(newNodes, selectedNodeId) });
    get().saveToStore();
  },

  replaceSubscriptionNodes: (subscriptionId, fresh) => {
    const { nodes, changed } = mergeSubscriptionNodes(get().nodes, subscriptionId, fresh);
    if (!changed) return false;

    // A twin keeps its node's id, so a refreshed selected node stays selected.
    set({ nodes, ...selectionFor(nodes, get().selectedNodeId) });
    get().saveToStore();
    return true;
  },

  loadFromStore: async () => {
    try {
      const storedNodes = await window.api.store.get('nodes');
      const storedIndex = await window.api.store.get('selectedIndex');
      const storedId = await window.api.store.get('selectedNodeId');
      let nodes: ProxyNode[] = Array.isArray(storedNodes) ? storedNodes : [];

      // This store saves the id and the index as a pair, the index being the
      // id's first position (selectionFor), so on data it saved they agree.
      const idIndex = typeof storedId === 'string' ? nodes.findIndex((n) => n?.id === storedId) : -1;
      const indexNamesNode =
        Number.isInteger(storedIndex) &&
        storedIndex >= 0 &&
        storedIndex < nodes.length &&
        !!nodes[storedIndex] &&
        typeof nodes[storedIndex] === 'object';

      let selectedNodeId: string | null = null;
      let fromIndex = false;
      if (idIndex >= 0 && (!indexNamesNode || storedIndex === idIndex)) {
        // The pair as saved, or an index that names no node and so can't
        // point elsewhere.
        selectedNodeId = storedId;
      } else if (indexNamesNode) {
        // Otherwise the index is the selection, in two cases. The data was
        // saved before selectedNodeId existed: the key is then absent,
        // undefined from electron-store, null in web mode (web-api.ts reads an
        // absent key from localStorage as null). Or an older build has saved
        // the list since: 1.4.0, installed next to a dev build of this one,
        // shares its data folder, saves only nodes and selectedIndex and
        // leaves the id behind. Its refresh gives a subscription's nodes new
        // ids, so the id can name no node any more, and a node picked there
        // moves the index off the id's node. Either way the index is the later
        // choice: the node that build showed as selected. A save of this store
        // cut off between its writes can also leave the two disagreeing; the
        // index wins then too, and the Dashboard shows the node it names.
        let node = nodes[storedIndex];
        // The index has to come out of the id again unchanged. With no id, or
        // with one an earlier node also has, it would land elsewhere, so the
        // node gets an id of its own first.
        if (typeof node.id !== 'string' || !node.id || nodes.findIndex((n) => n?.id === node.id) !== storedIndex) {
          node = { ...node, id: newNodeId() };
          nodes = nodes.map((n, i) => (i === storedIndex ? node : n));
        }
        selectedNodeId = node.id;
        fromIndex = true;
      }

      set({ nodes, ...selectionFor(nodes, selectedNodeId) });
      // Save once when the key is new or the index decided, so the stored id
      // names the selection again and later launches read it by id.
      if (storedId === undefined || fromIndex) await get().saveToStore();
    } catch (err) {
      console.error('Failed to load nodes from store:', err);
    }
  },

  saveToStore: async () => {
    try {
      const { nodes, selectedNodeId, selectedIndex } = get();
      await window.api.store.set('nodes', nodes);
      // "Nothing selected" is null, never undefined: electron-store refuses to
      // store undefined ("Use `delete()` to clear values").
      await window.api.store.set('selectedNodeId', selectedNodeId);
      // Still written, though derived: main's core-upgrade check
      // (checkNewCoreAgainstConfigs) reads it, and so do older builds. They
      // write it too, without the id, which is how loadFromStore can tell
      // that one has run since.
      await window.api.store.set('selectedIndex', selectedIndex);
    } catch (err) {
      console.error('Failed to save nodes to store:', err);
    }
  },
}));
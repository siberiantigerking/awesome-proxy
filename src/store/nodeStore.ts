import { create } from 'zustand';
import type { ProxyNode, ConnectionStatus, NodeTestKind } from '../types';

interface NodeStore {
  nodes: ProxyNode[];
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

  // Persistence
  loadFromStore: () => Promise<void>;
  saveToStore: () => Promise<void>;
}

export const useNodeStore = create<NodeStore>((set, get) => ({
  nodes: [],
  selectedIndex: -1,
  connectionStatus: 'disconnected',

  setNodes: (nodes) => {
    set({ nodes });
    get().saveToStore();
  },

  addNode: (node) => {
    set((state) => {
      const nodes = [...state.nodes, node];
      // Auto-select the first node so it appears as the active node on the
      // dashboard immediately instead of requiring a manual selection.
      const selectedIndex = state.selectedIndex < 0 ? nodes.length - 1 : state.selectedIndex;
      return { nodes, selectedIndex };
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
    const { nodes, selectedIndex } = get();
    const index = nodes.findIndex((n) => n.id === id);
    if (index === -1) return;

    const newNodes = nodes.filter((n) => n.id !== id);
    let newIndex = selectedIndex;
    if (index < selectedIndex) {
      newIndex = selectedIndex - 1;
    } else if (index === selectedIndex) {
      newIndex = -1;
    } else if (selectedIndex >= newNodes.length) {
      newIndex = newNodes.length - 1;
    }

    set({ nodes: newNodes, selectedIndex: newIndex });
    get().saveToStore();
  },

  removeNodes: (ids) => {
    const { nodes, selectedIndex } = get();
    const selectedNode = nodes[selectedIndex];
    const newNodes = nodes.filter((n) => !ids.includes(n.id));
    const newIndex = selectedNode ? newNodes.findIndex((n) => n.id === selectedNode.id) : -1;

    set({ nodes: newNodes, selectedIndex: newIndex });
    get().saveToStore();
  },

  setSelectedIndex: (index) => {
    set({ selectedIndex: index });
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

      // Adjust selected index
      let newIndex = state.selectedIndex;
      if (state.selectedIndex === fromIndex) {
        newIndex = toIndex;
      } else if (fromIndex < state.selectedIndex && toIndex >= state.selectedIndex) {
        newIndex--;
      } else if (fromIndex > state.selectedIndex && toIndex <= state.selectedIndex) {
        newIndex++;
      }

      return { nodes: newNodes, selectedIndex: newIndex };
    });
    get().saveToStore();
  },

  moveNodeToTop: (id) => {
    set((state) => {
      const index = state.nodes.findIndex((n) => n.id === id);
      if (index <= 0) return state; // not found or already at top

      const selectedNode = state.selectedIndex >= 0 ? state.nodes[state.selectedIndex] : null;
      const newNodes = [...state.nodes];
      const [moved] = newNodes.splice(index, 1);
      newNodes.unshift(moved);

      // Keep the selection pointing at the same node after reordering.
      const newIndex = selectedNode ? newNodes.findIndex((n) => n.id === selectedNode.id) : -1;
      return { nodes: newNodes, selectedIndex: newIndex };
    });
    get().saveToStore();
  },

  removeNodesBySubscription: (subscriptionId) => {
    const { nodes, selectedIndex } = get();
    const selectedNode = selectedIndex >= 0 ? nodes[selectedIndex] : null;
    const newNodes = nodes.filter((n) => n.subscriptionId !== subscriptionId);
    if (newNodes.length === nodes.length) return; // nothing removed

    const newIndex = selectedNode ? newNodes.findIndex((n) => n.id === selectedNode.id) : -1;
    set({ nodes: newNodes, selectedIndex: newIndex });
    get().saveToStore();
  },

  loadFromStore: async () => {
    try {
      const nodes = await window.api.store.get('nodes');
      const selectedIndex = await window.api.store.get('selectedIndex');
      if (nodes) set({ nodes });
      if (selectedIndex !== undefined && selectedIndex !== null) set({ selectedIndex });
    } catch (err) {
      console.error('Failed to load nodes from store:', err);
    }
  },

  saveToStore: async () => {
    try {
      const { nodes, selectedIndex } = get();
      await window.api.store.set('nodes', nodes);
      await window.api.store.set('selectedIndex', selectedIndex);
    } catch (err) {
      console.error('Failed to save nodes to store:', err);
    }
  },
}));
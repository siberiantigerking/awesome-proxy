import { create } from 'zustand';
import type { Subscription } from '../types';

interface SubscriptionStore {
  subscriptions: Subscription[];

  // Actions
  setSubscriptions: (subs: Subscription[]) => void;
  addSubscription: (sub: Subscription) => void;
  updateSubscription: (id: string, updates: Partial<Subscription>) => void;
  removeSubscription: (id: string) => void;

  // Persistence
  loadFromStore: () => Promise<void>;
  saveToStore: () => Promise<void>;
}

export const useSubscriptionStore = create<SubscriptionStore>((set, get) => ({
  subscriptions: [],

  setSubscriptions: (subscriptions) => {
    set({ subscriptions });
    get().saveToStore();
  },

  addSubscription: (sub) => {
    set((state) => ({ subscriptions: [...state.subscriptions, sub] }));
    get().saveToStore();
  },

  updateSubscription: (id, updates) => {
    set((state) => ({
      subscriptions: state.subscriptions.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    }));
    get().saveToStore();
  },

  removeSubscription: (id) => {
    set((state) => ({
      subscriptions: state.subscriptions.filter((s) => s.id !== id),
    }));
    get().saveToStore();
  },

  loadFromStore: async () => {
    try {
      const subscriptions = await window.api.store.get('subscriptions');
      if (subscriptions) set({ subscriptions });
    } catch (err) {
      console.error('Failed to load subscriptions from store:', err);
    }
  },

  saveToStore: async () => {
    try {
      const { subscriptions } = get();
      await window.api.store.set('subscriptions', subscriptions);
    } catch (err) {
      console.error('Failed to save subscriptions to store:', err);
    }
  },
}));
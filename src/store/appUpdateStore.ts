import { create } from 'zustand';
import type { AppUpdateStatus } from '../types';

interface AppUpdateStore {
  status: AppUpdateStatus;
  setStatus: (status: AppUpdateStatus) => void;
}

/**
 * Renderer mirror of the app updater's status. The main process owns the real
 * state (electron/app-updater.ts) and pushes every change, so nothing here is
 * persisted.
 */
export const useAppUpdateStore = create<AppUpdateStore>((set) => ({
  status: { state: 'idle', currentVersion: '' },
  setStatus: (status) => set({ status }),
}));

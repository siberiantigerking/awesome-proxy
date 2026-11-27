import { create } from 'zustand';
import type { CoreCrashInfo } from '../types';

interface CoreCrashStore {
  /** The last give-up notice from the core watchdog, or null. */
  crash: CoreCrashInfo | null;
  setCrash: (crash: CoreCrashInfo) => void;
  clearCrash: () => void;
}

/**
 * Backs the Dashboard's "sing-box stopped unexpectedly" banner. Main pushes the
 * notice (singbox:crashed) when its watchdog gives up; the banner stays until
 * the next successful connect or until the user dismisses it. Not persisted:
 * it describes this session only.
 */
export const useCoreCrashStore = create<CoreCrashStore>((set) => ({
  crash: null,
  setCrash: (crash) => set({ crash }),
  clearCrash: () => set({ crash: null }),
}));

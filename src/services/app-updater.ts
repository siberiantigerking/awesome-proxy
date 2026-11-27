import { useAppUpdateStore } from '../store/appUpdateStore';
import { useSettingsStore } from '../store/settingsStore';
import type { AppUpdateStatus } from '../types';

/**
 * Renderer side of the in-app APP updater: updates Awesome Proxy itself from
 * its GitHub releases (electron/app-updater.ts does the work).
 *
 * Not ./auto-update.ts, which refreshes subscriptions, and not the sing-box
 * core upgrade in Settings (window.api.singbox.upgrade).
 */

/**
 * Delay before the startup check. Long enough for an elevated relaunch to
 * resume its pending TUN/Split connect first, so the check can go through the
 * proxy instead of a network where GitHub may be blocked.
 */
const STARTUP_CHECK_DELAY_MS = 15 * 1000;

const NO_RESPONSE_MESSAGE = "The updater didn't respond. Restart Awesome Proxy and try again.";

/** False in web mode, where window.api has no `updater`. */
export function isAppUpdaterAvailable(): boolean {
  return !!window.api?.updater;
}

/** Mirror main's status pushes into the store. Returns an unsubscribe function. */
export function subscribeToAppUpdates(): () => void {
  const updater = window.api?.updater;
  if (!updater) return () => {};
  return updater.onStatus((status) => useAppUpdateStore.getState().setStatus(status));
}

/**
 * Quiet check shortly after launch, when "Check for updates on startup" is on.
 * Main only reports what it finds (a dot on Settings); it never downloads.
 * Returns a cancel function.
 */
export function scheduleStartupUpdateCheck(): () => void {
  const updater = window.api?.updater;
  if (!updater) return () => {};
  const timer = setTimeout(() => {
    // Read when the timer fires, so switching the option off right after
    // launch still counts.
    if (useSettingsStore.getState().settings.checkUpdatesOnStartup === false) return;
    updater.check({ background: true }).catch((err) => {
      console.warn('Startup update check failed:', err);
    });
  }, STARTUP_CHECK_DELAY_MS);
  return () => clearTimeout(timer);
}

async function run(call: () => Promise<AppUpdateStatus>): Promise<void> {
  const store = useAppUpdateStore.getState();
  try {
    store.setStatus(await call());
  } catch (err) {
    console.error('App updater call failed:', err);
    store.setStatus({
      state: 'error',
      currentVersion: useAppUpdateStore.getState().status.currentVersion,
      error: { kind: 'unknown', message: NO_RESPONSE_MESSAGE },
    });
  }
}

export function checkForAppUpdate(): Promise<void> {
  const updater = window.api?.updater;
  return updater ? run(() => updater.check()) : Promise.resolve();
}

export function downloadAppUpdate(): Promise<void> {
  const updater = window.api?.updater;
  return updater ? run(() => updater.download()) : Promise.resolve();
}

export function installAppUpdate(): Promise<void> {
  const updater = window.api?.updater;
  return updater ? run(() => updater.install()) : Promise.resolve();
}

/** Opens the releases page in the browser. The URL is fixed in main. */
export function openReleasesPage(): void {
  window.api?.updater?.openReleasesPage().catch(() => {
    /* best-effort; main logs the failure */
  });
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_REMOTE_DNS,
  V1_BLOCK,
  V1_FRESH_INSTALL,
  V2_PREFER,
  V3_BLOCK,
  V3_IPV4_ONLY,
  V4_STRICT_OFF,
  V5_CURRENT,
  V5_CUSTOM_DNS,
  V6_CURRENT,
  V6_DIRECT_DNS,
  V6_REMOTE_DNS,
} from '../fixtures/settings-history';
import { installMockApi } from '../helpers/mock-api';

/**
 * Settings migrations in src/store/settingsStore.ts, run against a mocked
 * window.api.store holding what each schema version stored. The store module
 * is imported fresh for every case, as the app does on launch.
 *
 * v6 (audit P0-8): the old dns.google / dns.alidns.com defaults, which the
 * generator never used, move to the IP literals it did use, so an untouched
 * install keeps exactly the DNS it had. An edited value is kept.
 */

async function load(stored: Record<string, unknown> | undefined) {
  const mock = installMockApi(stored === undefined ? {} : { settings: stored });
  vi.resetModules();
  const { useSettingsStore } = await import('../../src/store/settingsStore');
  await useSettingsStore.getState().loadFromStore();
  const settings = useSettingsStore.getState().settings as Record<string, unknown>;
  const saves = mock.sets.filter(([key]) => key === 'settings').map(([, value]) => value);
  return { settings, saves };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings migrations (v1 → v6)', () => {
  it('V1_BLOCK → block, version 6, the old DNS defaults mapped, saved once', async () => {
    const { settings, saves } = await load(V1_BLOCK);
    expect(settings.ipv6Strategy).toBe('block');
    expect(settings.settingsVersion).toBe(6);
    expect(saves).toEqual([settings]);
    // The untouched DNS defaults move to the servers the generator always
    // used; nothing else moved.
    expect(settings).toMatchObject({
      ...V1_BLOCK,
      remoteDns: V6_REMOTE_DNS,
      directDns: V6_DIRECT_DNS,
      settingsVersion: 6,
    });
  });

  it('V1_FRESH_INSTALL → block with the newer defaults merged in, DNS on the literals, version 6', async () => {
    const { settings, saves } = await load(V1_FRESH_INSTALL);
    expect(settings).toMatchObject({
      ...V1_FRESH_INSTALL,
      ipv6Strategy: 'block',
      tunStack: 'mixed',
      tunBypassLocalNetworks: false,
      separatePorts: false,
      splitRules: [],
      splitApps: [],
      splitMode: 'proxy',
      checkUpdatesOnStartup: true,
      remoteDns: V6_REMOTE_DNS,
      directDns: V6_DIRECT_DNS,
      settingsVersion: 6,
    });
    expect(saves).toEqual([settings]);
  });

  it('V2_PREFER → block', async () => {
    const { settings, saves } = await load(V2_PREFER);
    expect(settings.ipv6Strategy).toBe('block');
    expect(settings.settingsVersion).toBe(6);
    expect(settings).not.toHaveProperty('tunStrictRoute');
    // strict_route was left on, so there was no workaround to carry over.
    expect(settings.tunBypassLocalNetworks).toBe(false);
    expect(settings.remoteDns).toBe(V6_REMOTE_DNS);
    expect(settings.directDns).toBe(V6_DIRECT_DNS);
    expect(saves).toEqual([settings]);
  });

  it('V3_BLOCK → block (an explicit choice, kept)', async () => {
    const { settings, saves } = await load(V3_BLOCK);
    expect(settings.ipv6Strategy).toBe('block');
    expect(settings.settingsVersion).toBe(6);
    expect(settings.remoteDns).toBe(V6_REMOTE_DNS);
    expect(settings.directDns).toBe(V6_DIRECT_DNS);
    expect(saves).toEqual([settings]);
  });

  it('V3_IPV4_ONLY → block', async () => {
    const { settings, saves } = await load(V3_IPV4_ONLY);
    expect(settings.ipv6Strategy).toBe('block');
    expect(settings.settingsVersion).toBe(6);
    expect(settings.remoteDns).toBe(V6_REMOTE_DNS);
    expect(settings.directDns).toBe(V6_DIRECT_DNS);
    expect(saves).toEqual([settings]);
  });

  it('V4_STRICT_OFF → ipv4-only kept, the strict_route workaround becomes tunBypassLocalNetworks', async () => {
    const { settings, saves } = await load(V4_STRICT_OFF);
    expect(settings.ipv6Strategy).toBe('ipv4-only');
    expect(settings.tunBypassLocalNetworks).toBe(true);
    expect(settings).not.toHaveProperty('tunStrictRoute');
    expect(settings.settingsVersion).toBe(6);
    expect(settings.remoteDns).toBe(V6_REMOTE_DNS);
    expect(settings.directDns).toBe(V6_DIRECT_DNS);
    expect(saves).toEqual([settings]);
  });

  it('V5_CURRENT → the untouched DNS default mapped, the edited one kept, the retired key stripped, saved once', async () => {
    const { settings, saves } = await load(V5_CURRENT);
    const { tunStrictRoute: _retired, ...rest } = V5_CURRENT;
    expect(settings).toEqual({ ...rest, directDns: V6_DIRECT_DNS, settingsVersion: 6 });
    expect(settings.remoteDns).toBe('tls://8.8.8.8');
    expect(saves).toEqual([settings]);
  });

  it('V5_CUSTOM_DNS → both edited servers kept, version 6, saved once', async () => {
    const { settings, saves } = await load(V5_CUSTOM_DNS);
    expect(settings).toEqual({ ...V5_CUSTOM_DNS, settingsVersion: 6 });
    expect(saves).toEqual([settings]);
  });

  it('V6_CURRENT → unchanged, including a legacy DNS string chosen again, and not saved', async () => {
    const { settings, saves } = await load(V6_CURRENT);
    expect(settings).toEqual(V6_CURRENT);
    expect(settings.remoteDns).toBe(LEGACY_REMOTE_DNS);
    expect(saves).toEqual([]);
  });

  it('nothing stored → defaults, nothing saved', async () => {
    const { settings, saves } = await load(undefined);
    expect(settings).toMatchObject({
      settingsVersion: 6,
      proxyMode: 'system',
      ipv6Strategy: 'block',
      tunStack: 'mixed',
      remoteDns: V6_REMOTE_DNS,
      directDns: V6_DIRECT_DNS,
    });
    expect(saves).toEqual([]);
  });
});

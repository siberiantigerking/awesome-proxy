import React from 'react';
import { Monitor, Shield, Globe, Server, Palette } from '../components/Icons';
import { useSettingsStore } from '../store/settingsStore';
import { useNodeStore } from '../store/nodeStore';
import { SPLIT_PRESETS } from '../services/split-presets';
import { buildOutboundTags } from '../services/outbound-tags';
import { reconnect } from '../services/connection';
import type { ProxyMode, LogLevel, Theme, SplitRule, AppSettings } from '../types';

export default function Settings() {
  const { settings, updateSettings, singboxVersion, appVersion } = useSettingsStore();
  const [isAdmin, setIsAdmin] = React.useState<boolean | null>(null);
  const [reconnecting, setReconnecting] = React.useState(false);
  const [modeError, setModeError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (window.api?.app?.isAdmin) {
          const admin = await window.api.app.isAdmin();
          if (active) setIsAdmin(admin);
        }
      } catch {
        /* web mode: no admin concept */
      }
    })();
    return () => { active = false; };
  }, []);

  const handleSelectMode = async (mode: ProxyMode) => {
    const prev = settings.proxyMode;
    if (mode === prev) return;
    updateSettings({ proxyMode: mode });

    // If we're connected, the running core uses the OLD mode's inbounds. A mode
    // change requires a real restart (different inbounds + system-proxy state),
    // so reconnect automatically instead of forcing a manual disconnect.
    const connected = useNodeStore.getState().connectionStatus === 'connected';
    if (connected) {
      setReconnecting(true);
      try {
        const res = await reconnect();
        if (!res.ok && !res.elevating && res.error) {
          // Surface failures to the user via the banner area.
          setModeError(res.error);
        } else {
          setModeError(null);
        }
      } finally {
        setReconnecting(false);
      }
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-surface-100">Settings</h2>

      {/* Proxy Mode */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">Proxy Mode</h3>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            { value: 'system', label: 'System', desc: 'Windows proxy. No admin.' },
            { value: 'tun', label: 'TUN', desc: 'All traffic. Needs admin.' },
            { value: 'split', label: 'Split', desc: 'Per-app routing. Needs admin.' },
            { value: 'manual', label: 'Manual', desc: 'Local port only.' },
          ] as { value: ProxyMode; label: string; desc: string }[]).map((mode) => (
            <button
              key={mode.value}
              onClick={() => handleSelectMode(mode.value)}
              className={`p-3 rounded-lg border text-left transition-all ${
                settings.proxyMode === mode.value
                  ? 'bg-primary-600/15 border-primary-500/30'
                  : 'bg-surface-800/50 border-surface-700/30 hover:bg-surface-800'
              }`}
            >
              <p className={`text-sm font-medium ${settings.proxyMode === mode.value ? 'text-primary-300' : 'text-surface-300'}`}>
                {mode.label}
              </p>
              <p className="text-[11px] text-surface-500 mt-0.5">{mode.desc}</p>
            </button>
          ))}
        </div>

        {/* Mode explanations */}
        <div className="text-[11px] text-surface-500 space-y-1 pt-1">
          <p><span className="text-surface-400 font-medium">System Proxy</span> — sets Windows' HTTP/SOCKS proxy to the local port. Most apps follow it automatically. Best default. No admin.</p>
          <p><span className="text-surface-400 font-medium">TUN</span> — virtual adapter that captures all traffic, including apps that ignore the system proxy. Needs admin.</p>
          <p><span className="text-surface-400 font-medium">Split</span> — per-application routing: choose which apps go through the proxy (or bypass it) while the rest go the opposite way. Uses TUN under the hood, so it needs admin.</p>
          <p><span className="text-surface-400 font-medium">Manual</span> — only starts the local mixed-proxy port (e.g. 127.0.0.1:{settings.mixedPort}); doesn't touch system settings. Point apps at it yourself.</p>
        </div>

        {reconnecting && (
          <p className="text-[11px] text-primary-400">Applying mode change — reconnecting…</p>
        )}
        {modeError && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] text-red-300">{modeError}</p>
          </div>
        )}

        {(settings.proxyMode === 'tun' || settings.proxyMode === 'split') && isAdmin === false && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 flex items-center justify-between gap-3">
            <p className="text-[11px] text-yellow-300">
              This mode needs administrator rights. You'll be prompted to elevate when you connect, or elevate now:
            </p>
            {window.api?.app?.relaunchAsAdmin && (
              <button
                onClick={() => window.api.app.relaunchAsAdmin()}
                className="text-[11px] px-2 py-1 rounded bg-yellow-500/20 text-yellow-200 hover:bg-yellow-500/30 shrink-0"
              >
                Restart as admin
              </button>
            )}
          </div>
        )}
        {(settings.proxyMode === 'tun' || settings.proxyMode === 'split') && isAdmin === true && (
          <p className="text-[11px] text-green-400">Running as administrator — this mode is available.</p>
        )}

        {/* Split mode domain-based rules */}
        {settings.proxyMode === 'split' && (
          <SplitRuleEditor />
        )}
      </section>

      {/* Ports */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">Ports</h3>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-surface-400 mb-1 block">Mixed Port</label>
            <input
              type="number"
              value={settings.mixedPort}
              onChange={(e) => updateSettings({ mixedPort: parseInt(e.target.value) || 7890 })}
              className="input-field"
            />
          </div>
          <div>
            <label className="text-xs text-surface-400 mb-1 block">SOCKS Port</label>
            <input
              type="number"
              value={settings.socksPort}
              onChange={(e) => updateSettings({ socksPort: parseInt(e.target.value) || 1080 })}
              className="input-field"
            />
          </div>
          <div>
            <label className="text-xs text-surface-400 mb-1 block">HTTP Port</label>
            <input
              type="number"
              value={settings.httpPort}
              onChange={(e) => updateSettings({ httpPort: parseInt(e.target.value) || 8080 })}
              className="input-field"
            />
          </div>
        </div>
      </section>

      {/* IPv6 handling */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">IPv6 Handling (TUN / Split)</h3>
        </div>
        <select
          value={settings.ipv6Strategy || 'prefer-ipv4'}
          onChange={(e) => updateSettings({ ipv6Strategy: e.target.value as AppSettings['ipv6Strategy'] })}
          className="input-field"
        >
          <option value="prefer-ipv4">Prefer IPv4, allow IPv6 — no leak (recommended)</option>
          <option value="block">Block IPv6 — no leak, forces IPv6 fully off</option>
          <option value="ipv4-only">IPv4 only (legacy) — IPv6 bypasses the tunnel</option>
        </select>

        <div className="text-[11px] text-surface-500 space-y-1">
          {settings.ipv6Strategy === 'block' && (
            <p>
              Apps are never given IPv6 addresses, so they use IPv4 and never stall. Any app that
              dials a hardcoded IPv6 address is captured by the tunnel and refused, so your real
              IPv6 address can't leak. IPv6-only sites won't load, and the machine keeps a
              dead IPv6 route — on an IPv6 network that can make things feel slower.
            </p>
          )}
          {(settings.ipv6Strategy || 'prefer-ipv4') === 'prefer-ipv4' && (
            <p>
              IPv6 is captured by the tunnel and routed through the proxy, so your real IPv6
              address still can't leak, while IPv4 is preferred whenever a site supports both.
              IPv6-only sites work <em>only</em> if your node supports IPv6.
            </p>
          )}
          {settings.ipv6Strategy === 'ipv4-only' && (
            <p className="text-yellow-300">
              IPv6 is not captured by the tunnel. On an IPv6-capable network it goes out over your
              real connection, which can expose your actual IP address (including via WebRTC).
              Only use this if the other options cause problems.
            </p>
          )}
          <p className="text-surface-600">
            Note: in System Proxy and Manual mode the browser's WebRTC sends UDP outside the proxy
            entirely, so IPv6/WebRTC leaks can't be prevented from here — use TUN or Split if that
            matters.
          </p>
        </div>
      </section>

      {/* LAN sharing */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">Local Network Sharing</h3>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-surface-700 dark:text-surface-300">
              Allow devices on your LAN to use this proxy
            </p>
            <p className="text-[11px] text-surface-400 dark:text-surface-500">
              Binds the mixed port to 0.0.0.0 instead of 127.0.0.1.
            </p>
          </div>
          <input
            type="checkbox"
            checked={!!settings.allowLan}
            onChange={(e) => updateSettings({ allowLan: e.target.checked })}
            className="w-4 h-4 rounded shrink-0"
          />
        </div>

        {settings.allowLan && (
          <>
            <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
              <p className="text-[11px] text-yellow-300">
                <span className="font-medium">Security warning:</span> this proxy has no
                authentication. Anyone who can reach {`port ${settings.mixedPort}`} on this machine
                can route traffic through it. Only enable on networks you trust, and expect
                Windows Firewall to ask for permission the first time.
              </p>
            </div>
            <LanAddressHint port={settings.mixedPort} />
          </>
        )}

        {settings.proxyMode !== 'system' && settings.proxyMode !== 'manual' && settings.allowLan && (
          <p className="text-[11px] text-surface-500">
            Note: other devices must point their own proxy settings at this machine. TUN/Split only
            capture traffic from <em>this</em> computer.
          </p>
        )}
      </section>

      {/* DNS */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">DNS Settings</h3>
        </div>
        <div>
          <label className="text-xs text-surface-400 mb-1 block">Remote DNS</label>
          <input
            type="text"
            value={settings.remoteDns}
            onChange={(e) => updateSettings({ remoteDns: e.target.value })}
            placeholder="https://dns.google/dns-query"
            className="input-field font-mono text-xs"
          />
        </div>
        <div>
          <label className="text-xs text-surface-400 mb-1 block">Direct DNS</label>
          <input
            type="text"
            value={settings.directDns}
            onChange={(e) => updateSettings({ directDns: e.target.value })}
            placeholder="https://dns.alidns.com/dns-query"
            className="input-field font-mono text-xs"
          />
        </div>
      </section>

      {/* Routing */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Monitor size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">Routing</h3>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="bypass-china"
            checked={settings.bypassChina}
            onChange={(e) => updateSettings({ bypassChina: e.target.checked })}
            className="w-4 h-4 rounded"
          />
          <label htmlFor="bypass-china" className="text-sm text-surface-300">
            Bypass China IP addresses (direct connection)
          </label>
        </div>
        <div>
          <label className="text-xs text-surface-400 mb-1 block">Log Level</label>
          <select
            value={settings.logLevel}
            onChange={(e) => updateSettings({ logLevel: e.target.value as LogLevel })}
            className="input-field"
          >
            <option value="trace">Trace</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="fatal">Fatal</option>
            <option value="panic">Panic</option>
          </select>
        </div>
      </section>

      {/* App Settings */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Palette size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-700 dark:text-surface-200">Application</h3>
        </div>
        <div className="space-y-3">
          <div>
            <p className="text-sm text-surface-700 dark:text-surface-300 mb-2">Theme</p>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' },
              ] as { value: Theme; label: string }[]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateSettings({ theme: opt.value })}
                  className={`p-2 rounded-lg border text-sm transition-all ${
                    settings.theme === opt.value
                      ? 'bg-primary-600/15 border-primary-500/40 text-primary-600 dark:text-primary-300'
                      : 'bg-surface-100 border-surface-200 text-surface-600 hover:bg-surface-200 dark:bg-surface-800/50 dark:border-surface-700/30 dark:text-surface-300 dark:hover:bg-surface-800'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-surface-700 dark:text-surface-300">Start with Windows</p>
              <p className="text-[11px] text-surface-400 dark:text-surface-500">Auto-launch on system startup</p>
            </div>
            <input
              type="checkbox"
              checked={settings.autoStart}
              onChange={(e) => {
                updateSettings({ autoStart: e.target.checked });
                window.api?.app.setAutoStart(e.target.checked);
              }}
              className="w-4 h-4 rounded"
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-surface-700 dark:text-surface-300">Start minimized</p>
              <p className="text-[11px] text-surface-400 dark:text-surface-500">Start in system tray</p>
            </div>
            <input
              type="checkbox"
              checked={settings.startMinimized}
              onChange={(e) => {
                updateSettings({ startMinimized: e.target.checked });
                window.api?.app.setStartMinimized(e.target.checked);
              }}
              className="w-4 h-4 rounded"
            />
          </div>
        </div>
      </section>

      {/* About */}
      <section className="card space-y-3">
        <h3 className="text-sm font-medium text-surface-700 dark:text-surface-200">About</h3>
        <div className="text-xs text-surface-400 dark:text-surface-500 space-y-1">
          <p>Awesome Proxy v{appVersion}</p>
          <p>sing-box core: {singboxVersion}</p>
        </div>
        <CoreUpdater />
      </section>
    </div>
  );
}

// ==================== sing-box Core Updater ====================

type UpgradeStage = 'idle' | 'checking' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';

function CoreUpdater() {
  const { singboxVersion, setSingboxVersion } = useSettingsStore();
  const [stage, setStage] = React.useState<UpgradeStage>('idle');
  const [percent, setPercent] = React.useState(0);
  const [message, setMessage] = React.useState<string | null>(null);
  const [latest, setLatest] = React.useState<string | null>(null);
  const [hasUpdate, setHasUpdate] = React.useState<boolean | null>(null);

  // Subscribe to upgrade progress events from the main process.
  React.useEffect(() => {
    if (!window.api?.singbox?.onUpgradeProgress) return;
    window.api.singbox.onUpgradeProgress((data) => {
      if (data.stage === 'downloading') {
        setStage('downloading');
        setPercent(data.percent ?? 0);
      } else if (data.stage === 'extracting') {
        setStage('extracting');
      } else if (data.stage === 'installing') {
        setStage('installing');
      } else if (data.stage === 'checking') {
        setStage('checking');
      }
    });
  }, []);

  const busy = stage === 'checking' || stage === 'downloading' || stage === 'extracting' || stage === 'installing';

  const handleCheck = async () => {
    if (!window.api?.singbox?.checkUpdate) return;
    setStage('checking');
    setMessage(null);
    try {
      const res = await window.api.singbox.checkUpdate();
      if (!res.success) {
        setStage('error');
        setMessage(res.error || 'Failed to check for updates.');
        return;
      }
      setLatest(res.latest || null);
      setHasUpdate(!!res.hasUpdate);
      setStage('idle');
      setMessage(
        res.hasUpdate
          ? `Update available: v${res.latest} (current v${res.current})`
          : `You're on the latest version (v${res.current}).`
      );
    } catch (err: any) {
      setStage('error');
      setMessage(err?.message || 'Failed to check for updates.');
    }
  };

  const handleUpgrade = async () => {
    if (!window.api?.singbox?.upgrade) return;
    setStage('downloading');
    setPercent(0);
    setMessage(null);
    try {
      const res = await window.api.singbox.upgrade();
      if (!res.success) {
        setStage('error');
        setMessage(res.error || 'Upgrade failed.');
        return;
      }
      if (res.upgraded) {
        setStage('done');
        setHasUpdate(false);
        if (res.current) setSingboxVersion(res.current);
        setMessage(`Upgraded to v${res.current}. Reconnect to use the new core.`);
      } else {
        setStage('done');
        setMessage(`Already on the latest version (v${res.current}).`);
      }
    } catch (err: any) {
      setStage('error');
      setMessage(err?.message || 'Upgrade failed.');
    }
  };

  // Core upgrade is a desktop-only feature.
  if (!window.api?.singbox?.checkUpdate) return null;

  const stageLabel: Record<UpgradeStage, string> = {
    idle: '',
    checking: 'Checking for updates…',
    downloading: `Downloading… ${percent}%`,
    extracting: 'Extracting…',
    installing: 'Installing…',
    done: '',
    error: '',
  };

  return (
    <div className="border-t border-surface-200 dark:border-surface-700/50 pt-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-surface-600 dark:text-surface-300">sing-box core update</p>
          <p className="text-[11px] text-surface-400 dark:text-surface-500">
            Download and install the latest core from GitHub.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleCheck}
            disabled={busy}
            className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
          >
            Check
          </button>
          <button
            onClick={handleUpgrade}
            disabled={busy}
            className="btn-primary text-xs px-2.5 py-1 disabled:opacity-50"
          >
            {hasUpdate ? `Upgrade to v${latest}` : 'Upgrade'}
          </button>
        </div>
      </div>

      {busy && (
        <div className="space-y-1">
          <p className="text-[11px] text-primary-500 dark:text-primary-400">{stageLabel[stage]}</p>
          {stage === 'downloading' && (
            <div className="h-1.5 w-full rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden">
              <div
                className="h-full bg-primary-500 transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {!busy && message && (
        <p
          className={`text-[11px] ${
            stage === 'error'
              ? 'text-red-500 dark:text-red-400'
              : stage === 'done'
              ? 'text-green-600 dark:text-green-400'
              : 'text-surface-500 dark:text-surface-400'
          }`}
        >
          {message}
        </p>
      )}

      <p className="text-[10px] text-surface-400 dark:text-surface-600">Installed: v{singboxVersion}</p>
    </div>
  );
}

// ==================== LAN Address Hint ====================

/**
 * Show this machine's LAN IPv4 addresses so the user knows what to point other
 * devices at. Uses WebRTC-free discovery via the main process where possible.
 */
function LanAddressHint({ port }: { port: number }) {
  const [addresses, setAddresses] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (window.api?.network?.getLanAddresses) {
          const addrs = await window.api.network.getLanAddresses();
          if (active) setAddresses(addrs);
        } else {
          if (active) setAddresses([]);
        }
      } catch {
        if (active) setAddresses([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (addresses === null) {
    return <p className="text-[11px] text-surface-500">Detecting local addresses…</p>;
  }
  if (addresses.length === 0) {
    return (
      <p className="text-[11px] text-surface-500">
        Point other devices at this computer's LAN IP on port {port}.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-[11px] text-surface-400">
        Configure other devices to use an HTTP/SOCKS proxy at:
      </p>
      {addresses.map((ip) => (
        <p key={ip} className="text-xs font-mono text-primary-500 dark:text-primary-300">
          {ip}:{port}
        </p>
      ))}
    </div>
  );
}

// ==================== Split Mode Rule Editor ====================

function SplitRuleEditor() {
  const { settings, updateSettings } = useSettingsStore();
  const { nodes, connectionStatus } = useNodeStore();
  const [showAdd, setShowAdd] = React.useState(false);

  const rules: SplitRule[] = settings.splitRules || [];

  // Use the exact outbound tags (with de-dup) so they match the selector
  // children in the generated config and the Clash API live-switch targets.
  const nodeTags = React.useMemo(() => buildOutboundTags(nodes), [nodes]);

  const outboundOptions = React.useMemo(() => {
    return ['proxy', 'auto', 'direct', ...nodeTags];
  }, [nodeTags]);

  const availablePresets = React.useMemo(() => {
    const enabledIds = new Set(rules.map((r) => r.id));
    return SPLIT_PRESETS.filter((p) => !enabledIds.has(p.id));
  }, [rules]);

  const updateRules = (newRules: SplitRule[]) => {
    updateSettings({ splitRules: newRules });
  };

  const addPreset = (presetId: string) => {
    const preset = SPLIT_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const newRule: SplitRule = {
      id: preset.id,
      name: preset.name,
      outbound: preset.defaultOutbound,
      ruleSets: preset.ruleSets.map((rs) => rs.tag),
      enabled: true,
    };
    updateRules([...rules, newRule]);
    setShowAdd(false);
  };

  const removeRule = (id: string) => {
    updateRules(rules.filter((r) => r.id !== id));
  };

  const toggleRule = (id: string) => {
    updateRules(rules.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const changeOutbound = (id: string, outbound: string) => {
    const rule = rules.find((r) => r.id === id);
    updateRules(rules.map((r) => r.id === id ? { ...r, outbound } : r));
    // Apply the change live via the Clash API (no restart) when connected.
    if (rule && connectionStatus === 'connected' && window.api?.singbox?.select) {
      window.api.singbox.select(rule.name, outbound).catch(() => {});
    }
  };

  const getIcon = (id: string): string => {
    const preset = SPLIT_PRESETS.find((p) => p.id === id);
    return preset?.icon || '📦';
  };

  return (
    <div className="space-y-2 border-t border-surface-700/50 pt-3 mt-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-surface-300 font-medium">Domain-Based Routing Rules</p>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="btn-secondary text-xs px-2 py-1"
          disabled={availablePresets.length === 0}
        >
          + Add Rule
        </button>
      </div>

      <p className="text-[11px] text-surface-500">
        Route traffic to specific services through different outbounds using remote rule sets.
      </p>

      {/* Add preset dropdown */}
      {showAdd && availablePresets.length > 0 && (
        <div className="rounded-lg border border-surface-700/50 bg-surface-800/80 p-2 space-y-1 max-h-48 overflow-y-auto">
          {availablePresets.map((preset) => (
            <button
              key={preset.id}
              onClick={() => addPreset(preset.id)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-surface-700/50 flex items-center gap-2 text-xs text-surface-300"
            >
              <span>{preset.icon}</span>
              <span>{preset.name}</span>
              <span className="text-[10px] text-surface-500 ml-auto">{preset.ruleSets.length} rule sets</span>
            </button>
          ))}
        </div>
      )}

      {/* Rules list */}
      {rules.length === 0 ? (
        <p className="text-[11px] text-surface-500 text-center py-3">
          No rules configured. Click "Add Rule" to route services through specific outbounds.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all ${
                rule.enabled
                  ? 'bg-surface-800/50 border-surface-700/40'
                  : 'bg-surface-900/30 border-surface-800/30 opacity-60'
              }`}
            >
              <span className="text-sm">{getIcon(rule.id)}</span>
              <span className="text-xs text-surface-300 font-medium flex-1 min-w-0 truncate">
                {rule.name}
              </span>
              <select
                value={rule.outbound}
                onChange={(e) => changeOutbound(rule.id, e.target.value)}
                className="input-field w-auto text-[11px] py-0.5 px-1.5 max-w-[120px]"
              >
                {outboundOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
              <button
                onClick={() => toggleRule(rule.id)}
                className={`w-8 h-4 rounded-full relative transition-colors ${
                  rule.enabled ? 'bg-primary-500' : 'bg-surface-600'
                }`}
                title={rule.enabled ? 'Disable' : 'Enable'}
              >
                <span
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                    rule.enabled ? 'left-4' : 'left-0.5'
                  }`}
                />
              </button>
              <button
                onClick={() => removeRule(rule.id)}
                className="text-surface-500 hover:text-red-400 text-sm px-1"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-surface-600 mt-1">
        Each rule creates a selector outbound. Change the outbound to route that service through a specific node.
      </p>
    </div>
  );
}
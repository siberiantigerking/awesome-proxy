import React from 'react';
import { Monitor, Shield, Globe, Server, Palette, RefreshCw } from '../components/Icons';
import { useSettingsStore } from '../store/settingsStore';
import { useNodeStore } from '../store/nodeStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { hasLiveConnection, markPendingIfLive, usePendingApplyStore } from '../store/pendingApplyStore';
import { SPLIT_PRESETS } from '../services/split-presets';
import { buildOutboundTags, splitSelectorTag } from '../services/outbound-tags';
import { DEFAULT_DIRECT_DNS, DEFAULT_REMOTE_DNS, parseDnsServer } from '../services/dns-servers';
import { applyPendingChanges, splitTargetChangeMode } from '../services/connection';
import { useConfirm } from '../components/ConfirmDialog';
import {
  checkForAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  isAppUpdaterAvailable,
  openReleasesPage,
} from '../services/app-updater';
import type { ProxyMode, LogLevel, Theme, SplitRule, AppSettings, AppUpdateStatus } from '../types';

export default function Settings() {
  const { settings, updateSettings, singboxVersion, appVersion } = useSettingsStore();
  const updateStatus = useAppUpdateStore((s) => s.status);
  const updatesRef = React.useRef<HTMLElement>(null);
  const [isAdmin, setIsAdmin] = React.useState<boolean | null>(null);
  const [reconnecting, setReconnecting] = React.useState(false);
  const [modeError, setModeError] = React.useState<string | null>(null);
  // True when a config-affecting setting changed while connected but the core is
  // still running the older config, so the UI must not imply it is in force.
  // Shared through pendingApplyStore: a subscription refresh raises it too, and
  // the Dashboard and the Subscriptions page show the same banner.
  const pendingApply = usePendingApplyStore((s) => s.pending);
  const setPendingApply = usePendingApplyStore((s) => s.setPending);
  // The banner only means something while a core is live. Subscribed, unlike
  // hasLiveConnection(), so it disappears when the connection ends.
  const connectionStatus = useNodeStore((s) => s.connectionStatus);
  const live = connectionStatus === 'connected' || connectionStatus === 'connecting';

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

  // Port collisions are reported rather than silently corrected: the generator
  // skips a duplicate listener (sing-box treats duplicates as fatal), so the
  // user needs to know that the port they typed won't actually be opened.
  const portConflicts = React.useMemo(() => {
    if (!settings.separatePorts) return [];
    const problems: string[] = [];
    const { mixedPort, socksPort, httpPort } = settings;
    const valid = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;
    if (!valid(socksPort)) problems.push('SOCKS port is not a valid port number.');
    if (!valid(httpPort)) problems.push('HTTP port is not a valid port number.');
    if (socksPort === mixedPort) problems.push('SOCKS port is the same as the mixed port.');
    if (httpPort === mixedPort) problems.push('HTTP port is the same as the mixed port.');
    if (socksPort === httpPort) problems.push('SOCKS and HTTP ports are the same.');
    return problems;
  }, [settings.separatePorts, settings.mixedPort, settings.socksPort, settings.httpPort]);

  // Checked with the generator's own rules (dns-servers.ts mirrors them). A
  // value the generator can't parse is replaced by the default rather than
  // emitted, so that is said next to the field instead of leaving the user to
  // believe their server is in use.
  const remoteDnsCheck = React.useMemo(() => parseDnsServer(settings.remoteDns), [settings.remoteDns]);
  const directDnsCheck = React.useMemo(() => parseDnsServer(settings.directDns), [settings.directDns]);

  /**
   * Restart the core so the CURRENT settings actually take effect.
   *
   * The running core only knows the config it was started with. Changing a
   * setting here rewrites nothing by itself, so without this the UI and the
   * core drift apart: a user switched IPv6 handling to a leak-safe mode, the
   * dropdown showed it as active, and the core kept running the IPv4-only TUN it
   * had started with — still leaking the real IPv6 address. Anything that alters
   * the generated config has to either apply immediately or say that it hasn't.
   */
  const applyNow = async () => {
    if (!hasLiveConnection()) {
      setPendingApply(false);
      return;
    }
    setReconnecting(true);
    try {
      // connect() clears the flag where it reads the settings it starts with,
      // and with no node selected nothing is stopped (applyPendingChanges).
      const res = await applyPendingChanges();
      if (res && !res.ok && !res.elevating && res.error) {
        setModeError(res.error);
        // Still live means it was refused, not reconnected: the core keeps
        // the older settings, so the banner has to say so. After a failed
        // reconnect nothing runs and there is nothing to flag.
        if (hasLiveConnection()) setPendingApply(true);
      } else {
        setModeError(null);
      }
    } finally {
      setReconnecting(false);
    }
  };

  /**
   * For discrete controls (selects, toggles) whose whole purpose is to change
   * routing behaviour. These apply straight away when connected: a half-applied
   * privacy or routing setting is actively misleading, and a brief reconnect is
   * cheaper than the user believing something is in force when it isn't.
   */
  const updateAndApply = async (patch: Partial<AppSettings>) => {
    updateSettings(patch);
    if (hasLiveConnection()) await applyNow();
  };

  /**
   * For free-text and numeric fields (DNS URLs, ports). Restarting the core on
   * every keystroke would be unusable, so these only flag that a reconnect is
   * needed and let the user apply when they've finished typing.
   */
  const updateAndFlag = (patch: Partial<AppSettings>) => {
    updateSettings(patch);
    // Also while a connect is starting: its config was generated before this
    // edit (Round 2 follow-up N1).
    markPendingIfLive();
  };

  const handleSelectMode = async (mode: ProxyMode) => {
    const prev = settings.proxyMode;
    if (mode === prev) return;
    updateSettings({ proxyMode: mode });

    // If we're connected, the running core uses the OLD mode's inbounds (and a
    // pending watchdog restart would bring them back). A mode change requires
    // a real restart (different inbounds + system-proxy state), so reconnect
    // automatically instead of forcing a manual disconnect.
    if (hasLiveConnection()) await applyNow();
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-surface-100">Settings</h2>

      {/* App update notice. The update card sits at the bottom of a long page,
          so the sidebar dot alone would leave the user hunting for it. */}
      {(updateStatus.state === 'available' || updateStatus.state === 'downloaded') && (
        <div className="rounded-lg border border-primary-500/30 bg-primary-600/10 px-3 py-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-primary-600 dark:text-primary-300">
            {updateStatus.state === 'downloaded'
              ? `Awesome Proxy v${updateStatus.version} is downloaded and ready to install.`
              : `Awesome Proxy v${updateStatus.version} is available.`}
          </p>
          <button
            onClick={() => updatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="btn-secondary text-[11px] px-2 py-1 shrink-0"
          >
            View update
          </button>
        </div>
      )}

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
          <p className="text-[11px] text-primary-400">Applying settings — reconnecting…</p>
        )}
        {modeError && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] text-red-300">{modeError}</p>
          </div>
        )}
        {pendingApply && live && !reconnecting && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 flex items-center justify-between gap-3">
            <p className="text-[11px] text-yellow-300">
              The running connection is still using the previous settings or node list. Reconnect
              to apply the changes.
            </p>
            <button onClick={applyNow} className="btn-secondary text-[11px] px-2 py-1 shrink-0">
              Apply now
            </button>
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
          <SplitRuleEditor applyNow={applyNow} />
        )}
      </section>

      {/* Ports */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">Ports</h3>
        </div>
        <div>
          <label className="text-xs text-surface-400 mb-1 block">Mixed Port</label>
          <input
            type="number"
            value={settings.mixedPort}
            onChange={(e) => updateAndFlag({ mixedPort: parseInt(e.target.value) || 7890 })}
            className="input-field"
          />
          <p className="text-[11px] text-surface-500 mt-1">
            Accepts both SOCKS5 and HTTP on one port. This is the port System Proxy mode points
            Windows at, and the one to use in Manual mode.
          </p>
        </div>

        <label className="flex items-start gap-2 cursor-pointer pt-1">
          <input
            type="checkbox"
            checked={!!settings.separatePorts}
            onChange={(e) => updateAndApply({ separatePorts: e.target.checked })}
            className="mt-0.5"
          />
          <span className="text-xs text-surface-300">
            Also open dedicated SOCKS and HTTP ports
            <span className="block text-[11px] text-surface-500">
              Only needed for apps that insist on a specific port number. Off by default because an
              extra listener can collide with another proxy tool, and a collision stops the core
              from starting.
            </span>
          </span>
        </label>

        {settings.separatePorts && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-surface-400 mb-1 block">SOCKS Port</label>
                <input
                  type="number"
                  value={settings.socksPort}
                  onChange={(e) => updateAndFlag({ socksPort: parseInt(e.target.value) || 1080 })}
                  className="input-field"
                />
              </div>
              <div>
                <label className="text-xs text-surface-400 mb-1 block">HTTP Port</label>
                <input
                  type="number"
                  value={settings.httpPort}
                  onChange={(e) => updateAndFlag({ httpPort: parseInt(e.target.value) || 8080 })}
                  className="input-field"
                />
              </div>
            </div>
            {portConflicts.length > 0 && (
              <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
                <p className="text-[11px] text-yellow-300">
                  {portConflicts.join(' ')} A duplicate port is skipped instead of opened, so that
                  listener simply won't exist.
                </p>
              </div>
            )}
          </>
        )}
      </section>

      {/* IPv6 handling */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">IPv6 Handling (TUN / Split)</h3>
        </div>
        <select
          value={settings.ipv6Strategy || 'block'}
          onChange={(e) => updateAndApply({ ipv6Strategy: e.target.value as AppSettings['ipv6Strategy'] })}
          className="input-field"
        >
          <option value="block">No IPv6 leak — IPv6 sent over IPv4 (recommended)</option>
          <option value="prefer-ipv4">Allow IPv6 — tunneled, IPv4 still preferred</option>
          <option value="ipv4-only">IPv4 only — most compatible, but IPv6 leaks</option>
        </select>

        <div className="text-[11px] text-surface-500 space-y-1">
          {settings.ipv6Strategy === 'ipv4-only' && (
            <p className="text-yellow-300">
              The tunnel has no IPv6 address, so Windows has no IPv6 route to prefer and apps use
              IPv4 — which every node can carry. The catch: IPv6 isn't captured at all, so on a
              network with real IPv6 it goes out over your real connection and a site like ip.sb
              will show your actual IPv6 address. Use this only if the dual-stack tunnel breaks
              WSL2, Docker or Hyper-V networking for you.
            </p>
          )}
          {settings.ipv6Strategy === 'prefer-ipv4' && (
            <>
              <p>
                The tunnel is dual-stack and apps are given IPv6 addresses, so IPv6 is available and
                is carried through the proxy — your real IPv6 address can't leak. Your node's server
                needs working IPv6 of its own; if it doesn't, IPv6 connections stall and you should
                use <strong>IPv4 only</strong> instead.
              </p>
              <p className="text-surface-600">
                IPv4 is still preferred for sites that have both, so a "what's my IP" page like ip.sb
                will normally keep showing your IPv4 exit — that's expected, not a failure. To check
                IPv6 really works, open an IPv6-only address such as <code>ipv6.google.com</code> or
                use test-ipv6.com.
              </p>
            </>
          )}
          {(settings.ipv6Strategy || 'block') === 'block' && (
            <>
              <p>
                The tunnel is dual-stack, so IPv6 is captured instead of escaping over your real
                connection — a "what's my IP" page like ip.sb will show only your node's address.
                When an app reaches for an IPv6 address anyway, the request is re-sent to the site's
                IPv4 address through the proxy, so it still loads and works with IPv4-only nodes.
              </p>
              <p className="text-surface-600">
                Connections that can't be redirected are refused: an IPv6 literal with no hostname
                to look up, or a site that is genuinely IPv6-only. Both are rare, and apps fall back
                to IPv4. If the dual-stack tunnel interferes with WSL2, Docker or Hyper-V, switch to{' '}
                <strong>IPv4 only</strong> and accept the leak.
              </p>
            </>
          )}
          <p className="text-surface-600">
            Note: in System Proxy and Manual mode the browser's WebRTC sends UDP outside the proxy
            entirely, so IPv6/WebRTC leaks can't be prevented from here — use TUN or Split if that
            matters.
          </p>
        </div>

        {/* TCP/IP stack. Host-dependent, so it's a choice rather than a default
            we impose — see AppSettings.tunStack. */}
        <div className="pt-2 border-t border-surface-700/30 mt-1 space-y-2">
          <div>
            <label className="text-xs text-surface-300 block mb-1">Network stack (TUN / Split)</label>
            <select
              value={settings.tunStack || 'mixed'}
              onChange={(e) => updateAndApply({ tunStack: e.target.value as AppSettings['tunStack'] })}
              className="input-field"
            >
              <option value="mixed">Mixed — system TCP + gVisor UDP (recommended)</option>
              <option value="system">System — fastest for downloads and video</option>
              <option value="gvisor">gVisor — userspace TCP and UDP</option>
            </select>
          </div>
          <p className="text-[11px] text-surface-500">
            {(settings.tunStack || 'mixed') === 'mixed' &&
              'The core\'s own default: Windows handles TCP so transfers stay fast, and gVisor handles UDP.'}
            {settings.tunStack === 'system' &&
              'Windows handles both TCP and UDP. The lightest option and what v2rayN ships — try this first if video or large downloads are slow in TUN mode.'}
            {settings.tunStack === 'gvisor' &&
              'Everything is reassembled in userspace. Highest CPU cost and slowest for bulk transfers; only worth it if a UDP-heavy app misbehaves on the other two.'}
          </p>
        </div>

        {/* Escape hatch for virtual network stacks that share the host's.
            Replaces the old "Strict route" toggle — see
            AppSettings.tunBypassLocalNetworks for why that one had to go. */}
        <label className="flex items-start gap-2 cursor-pointer pt-1 border-t border-surface-700/30 mt-1">
          <input
            type="checkbox"
            checked={settings.tunBypassLocalNetworks === true}
            onChange={(e) => updateAndApply({ tunBypassLocalNetworks: e.target.checked })}
            className="mt-0.5"
          />
          <span className="text-xs text-surface-300">
            Keep local networks off the tunnel
            <span className="block text-[11px] text-surface-500">
              Turn this on if WSL2 in mirrored networking mode, Docker or Hyper-V lose their
              connection while TUN or Split is active. Those run on private network bridges, and
              pulling their traffic into the tunnel is what breaks them. This leaves the private
              ranges (10.x, 172.16–31.x, 192.168.x) on your normal connection instead. They were
              never sent through the proxy anyway, so nothing else changes.
            </span>
          </span>
        </label>
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
            onChange={(e) => updateAndApply({ allowLan: e.target.checked })}
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
            onChange={(e) => updateAndFlag({ remoteDns: e.target.value })}
            placeholder={DEFAULT_REMOTE_DNS}
            className="input-field font-mono text-xs"
          />
          {!remoteDnsCheck.ok && (
            <p className="text-[11px] text-yellow-300 mt-1">
              {remoteDnsCheck.error} Until this is fixed the default, {DEFAULT_REMOTE_DNS}, is used.
            </p>
          )}
        </div>
        <div>
          <label className="text-xs text-surface-400 mb-1 block">Direct DNS</label>
          <input
            type="text"
            value={settings.directDns}
            onChange={(e) => updateAndFlag({ directDns: e.target.value })}
            placeholder={DEFAULT_DIRECT_DNS}
            className="input-field font-mono text-xs"
          />
          {!directDnsCheck.ok && (
            <p className="text-[11px] text-yellow-300 mt-1">
              {directDnsCheck.error} Until this is fixed the default, {DEFAULT_DIRECT_DNS}, is used.
            </p>
          )}
        </div>
        <p className="text-[11px] text-surface-500">
          Accepts https://, h3://, tls://, quic://, udp:// or a bare IP address. Remote DNS goes
          through the proxy; Direct DNS answers the mainland-China domains listed under Routing. A
          server given by name is first looked up, for Remote DNS through the proxy by Cloudflare's
          1.1.1.1 and for Direct DNS with Windows' own resolver; an IP address needs no lookup. These
          servers matter most in TUN and Split mode — in System Proxy and Manual mode most apps hand
          the proxy a name instead.
        </p>
      </section>

      {/* Routing */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <Monitor size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-200">Routing</h3>
        </div>
        {/* Worded after what the rule matches: six domain suffixes, no IP
            ranges (shared/config-generator.cjs). It used to say "China IP
            addresses", which nothing matched (audit P0-8); real China routing
            is audit P1-3. The checkbox sits on the first line, as in the other
            two-line options. */}
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            id="bypass-china"
            checked={settings.bypassChina}
            onChange={(e) => updateAndApply({ bypassChina: e.target.checked })}
            className="w-4 h-4 rounded mt-0.5"
          />
          <label htmlFor="bypass-china" className="text-sm text-surface-300">
            Send common mainland-China domains direct
            <span className="block text-[11px] text-surface-500">
              Only .cn, baidu.com, qq.com, taobao.com, jd.com and alipay.com. China IP ranges and
              other mainland sites still go through the proxy.
            </span>
          </label>
        </div>
        <div>
          <label className="text-xs text-surface-400 mb-1 block">Log Level</label>
          <select
            value={settings.logLevel}
            onChange={(e) => updateAndApply({ logLevel: e.target.value as LogLevel })}
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

      {/* About & Updates */}
      <section ref={updatesRef} className="card space-y-3">
        <div className="flex items-center gap-2">
          <RefreshCw size={16} className="text-primary-400" />
          <h3 className="text-sm font-medium text-surface-700 dark:text-surface-200">About &amp; Updates</h3>
        </div>
        <div className="text-xs text-surface-400 dark:text-surface-500 space-y-1">
          <p>Awesome Proxy v{appVersion}</p>
          <p>sing-box core: {singboxVersion}</p>
        </div>
        <AppUpdater />
        <CoreUpdater />
      </section>
    </div>
  );
}

// ==================== App Updater ====================

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** "v1.4.1 · released 10/12/2026 · 99.2 MB", leaving out whatever isn't known. */
function releaseSummary(status: AppUpdateStatus): string {
  const date = status.releaseDate ? new Date(status.releaseDate) : null;
  return [
    status.version ? `v${status.version}` : null,
    date && !Number.isNaN(date.getTime()) ? `released ${date.toLocaleDateString()}` : null,
    status.size ? formatBytes(status.size) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Updates of Awesome Proxy itself, from its GitHub releases. The main process
 * owns the state (electron/app-updater.ts); this renders it and forwards clicks.
 * Not to be confused with CoreUpdater below, which swaps only the sing-box core.
 */
function AppUpdater() {
  // Selectors rather than the whole store, so 1 Hz traffic updates don't re-render this.
  const status = useAppUpdateStore((s) => s.status);
  const appVersion = useSettingsStore((s) => s.appVersion);
  const checkOnStartup = useSettingsStore((s) => s.settings.checkUpdatesOnStartup !== false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Web mode: there is no installed app to update.
  if (!isAppUpdaterAvailable()) {
    return (
      <div className="border-t border-surface-200 dark:border-surface-700/50 pt-3">
        <p className="text-[11px] text-surface-400 dark:text-surface-500">
          In-app updates are available in the desktop app only.
        </p>
      </div>
    );
  }

  const { state, progress } = status;

  let action: React.ReactNode = null;
  if (state === 'available') {
    action = (
      <button onClick={() => downloadAppUpdate()} className="btn-primary text-xs px-2.5 py-1">
        Download update
      </button>
    );
  } else if (state === 'downloaded') {
    action = (
      <button onClick={() => installAppUpdate()} className="btn-primary text-xs px-2.5 py-1">
        Restart and install
      </button>
    );
  } else if (state !== 'downloading' && state !== 'installing') {
    action = (
      <button
        onClick={() => checkForAppUpdate()}
        disabled={state === 'checking' || state === 'unsupported'}
        className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
      >
        {state === 'checking' ? 'Checking…' : 'Check for updates'}
      </button>
    );
  }

  let body: React.ReactNode = null;
  switch (state) {
    case 'unsupported':
      body = (
        <p className="text-[11px] text-surface-400 dark:text-surface-500">
          Updates are available in the installed app only.
        </p>
      );
      break;
    case 'checking':
      body = <p className="text-[11px] text-primary-500 dark:text-primary-400">Checking for updates…</p>;
      break;
    case 'not-available':
      body = (
        <p className="text-[11px] text-green-600 dark:text-green-400">
          You're on the latest version (v{status.currentVersion || appVersion}).
        </p>
      );
      break;
    case 'available':
      body = (
        <>
          <p className="text-[11px] text-surface-600 dark:text-surface-300">{releaseSummary(status)}</p>
          {/* Plain text only: main already stripped the HTML, and React escapes the rest. */}
          {status.releaseNotes && (
            <pre
              tabIndex={0}
              aria-label="Release notes"
              className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] text-surface-500 dark:text-surface-400 rounded-lg border border-surface-200 dark:border-surface-700/50 px-3 py-2"
            >
              {status.releaseNotes}
            </pre>
          )}
          <button
            onClick={openReleasesPage}
            className="text-[11px] text-primary-500 dark:text-primary-400 hover:underline"
          >
            Full release notes on GitHub
          </button>
        </>
      );
      break;
    case 'downloading': {
      const percent = progress?.percent ?? 0;
      const total = progress?.total || status.size || 0;
      const speed = progress?.bytesPerSecond ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : '';
      const amounts = total > 0 ? ` (${formatBytes(progress?.transferred ?? 0)} of ${formatBytes(total)})` : '';
      body = (
        <div className="space-y-1">
          <p className="text-[11px] text-primary-500 dark:text-primary-400">
            Downloading v{status.version}…{' '}
            {/* Changes every second; announcing each tick would drown out everything else. */}
            <span aria-live="off">
              {percent}%{speed}
              {amounts}
            </span>
          </p>
          <div
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden"
          >
            <div className="h-full bg-primary-500 transition-all" style={{ width: `${percent}%` }} />
          </div>
        </div>
      );
      break;
    }
    case 'downloaded':
      body = (
        <>
          <p className="text-[11px] text-surface-600 dark:text-surface-300">{releaseSummary(status)}</p>
          <p className="text-[11px] text-surface-400 dark:text-surface-500">
            Restarting disconnects the proxy (stops the core and clears the Windows system proxy),
            installs v{status.version} and reopens Awesome Proxy. Reconnect afterwards; TUN and Split
            ask for administrator rights again as usual.
          </p>
        </>
      );
      break;
    case 'installing':
      body = (
        <p className="text-[11px] text-primary-500 dark:text-primary-400">
          Disconnecting and restarting to install…
        </p>
      );
      break;
    case 'error':
      body = (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-red-600 dark:text-red-300">
            {status.error?.message || 'Something went wrong while updating.'}
          </p>
          <button onClick={openReleasesPage} className="btn-secondary text-[11px] px-2 py-1 shrink-0">
            Open releases page
          </button>
        </div>
      );
      break;
    default:
      break;
  }

  return (
    <div className="border-t border-surface-200 dark:border-surface-700/50 pt-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-surface-600 dark:text-surface-300">App update</p>
          <p className="text-[11px] text-surface-400 dark:text-surface-500">
            Update Awesome Proxy itself from its GitHub releases.
          </p>
        </div>
        {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
      </div>

      <div aria-live="polite" className="space-y-2">
        {body}
      </div>

      <label className="flex items-start gap-2 cursor-pointer pt-1">
        <input
          type="checkbox"
          checked={checkOnStartup}
          // Plain updateSettings on purpose: updateAndApply/updateAndFlag would
          // reconnect or flag the core, and this setting never reaches the core.
          onChange={(e) => updateSettings({ checkUpdatesOnStartup: e.target.checked })}
          className="mt-0.5"
        />
        <span className="text-xs text-surface-300">
          Check for updates on startup
          <span className="block text-[11px] text-surface-500">
            Only puts a dot on Settings when a new version is out. Nothing is downloaded or installed
            until you click.
          </span>
        </span>
      </label>
    </div>
  );
}

// ==================== sing-box Core Updater ====================

type UpgradeStage =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'extracting'
  | 'validating'
  | 'installing'
  | 'restoring'
  | 'done'
  | 'error';

function CoreUpdater() {
  const { singboxVersion, setSingboxVersion, appVersion } = useSettingsStore();
  const { confirm, confirmDialog } = useConfirm();
  const [stage, setStage] = React.useState<UpgradeStage>('idle');
  const [percent, setPercent] = React.useState(0);
  const [message, setMessage] = React.useState<string | null>(null);
  const [latest, setLatest] = React.useState<string | null>(null);
  const [hasUpdate, setHasUpdate] = React.useState<boolean | null>(null);
  // False once main reports the latest core past the line this app version
  // was validated with; installing it then needs a confirmation.
  const [validated, setValidated] = React.useState(true);
  const [maxValidated, setMaxValidated] = React.useState<string | null>(null);
  // The core the last upgrade replaced, kept for "Restore previous core".
  const [backup, setBackup] = React.useState<{ available: boolean; version?: string } | null>(null);

  const refreshBackup = React.useCallback(async () => {
    if (!window.api?.singbox?.getCoreBackup) return;
    try {
      setBackup(await window.api.singbox.getCoreBackup());
    } catch {
      setBackup(null);
    }
  }, []);

  React.useEffect(() => {
    void refreshBackup();
  }, [refreshBackup]);

  // Subscribe to upgrade progress events from the main process.
  React.useEffect(() => {
    if (!window.api?.singbox?.onUpgradeProgress) return;
    window.api.singbox.onUpgradeProgress((data) => {
      if (data.stage === 'downloading') {
        setStage('downloading');
        setPercent(data.percent ?? 0);
      } else if (data.stage === 'extracting') {
        setStage('extracting');
      } else if (data.stage === 'validating') {
        setStage('validating');
      } else if (data.stage === 'installing') {
        setStage('installing');
      } else if (data.stage === 'checking') {
        setStage('checking');
      }
    });
  }, []);

  const busy =
    stage === 'checking' ||
    stage === 'downloading' ||
    stage === 'extracting' ||
    stage === 'validating' ||
    stage === 'installing' ||
    stage === 'restoring';

  const unvalidatedNotice = (version: string, line: string | null) =>
    `v${version} is available, but this version of Awesome Proxy has only been validated with sing-box ${
      line || 'an older core line'
    }.`;

  const confirmUnvalidated = (version: string) =>
    confirm({
      title: 'Install an unvalidated core?',
      message:
        `sing-box v${version} is not yet validated with this app version (Awesome Proxy ${appVersion}).\n\n` +
        'Newer cores can drop options this version still uses, so connecting could fail after the upgrade. ' +
        'Your current core is kept, so you can put it back with "Restore previous core".',
      confirmLabel: 'Install anyway',
      danger: true,
    });

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
      setValidated(res.validated !== false);
      setMaxValidated(res.maxValidated || null);
      setStage('idle');
      setMessage(
        res.hasUpdate
          ? res.validated === false
            ? unvalidatedNotice(res.latest || '', res.maxValidated || null)
            : `Update available: v${res.latest} (current v${res.current})`
          : `You're on the latest version (v${res.current}).`
      );
    } catch (err: any) {
      setStage('error');
      setMessage(err?.message || 'Failed to check for updates.');
    }
  };

  const runUpgrade = async (allowUnvalidated: boolean): Promise<void> => {
    if (!window.api?.singbox?.upgrade) return;
    setStage('downloading');
    setPercent(0);
    setMessage(null);
    try {
      const res = await window.api.singbox.upgrade({ allowUnvalidated });
      if (!res.success && res.needsConfirmation && !allowUnvalidated) {
        // Main found the latest core past the validated line: no check ran
        // first, or a newer release came out since. Ask now.
        const version = res.latest || latest || '';
        setLatest(version || null);
        setHasUpdate(true);
        setValidated(false);
        if (await confirmUnvalidated(version)) {
          await runUpgrade(true);
          return;
        }
        setStage('idle');
        setMessage(maxValidated ? unvalidatedNotice(version, maxValidated) : res.error || null);
        return;
      }
      if (!res.success) {
        setStage('error');
        setMessage(res.error || 'Upgrade failed.');
        return;
      }
      if (res.upgraded) {
        setStage('done');
        setHasUpdate(false);
        setValidated(true);
        if (res.current) setSingboxVersion(res.current);
        setMessage(`Upgraded to v${res.current}. Reconnect to use the new core.`);
      } else {
        setStage('done');
        setMessage(`Already on the latest version (v${res.current}).`);
      }
    } catch (err: any) {
      setStage('error');
      setMessage(err?.message || 'Upgrade failed.');
    } finally {
      void refreshBackup();
    }
  };

  const handleUpgrade = async () => {
    // Known from the check: ask before anything is downloaded.
    if (hasUpdate && !validated && latest) {
      if (!(await confirmUnvalidated(latest))) return;
      await runUpgrade(true);
      return;
    }
    await runUpgrade(false);
  };

  const handleRestore = async () => {
    if (!window.api?.singbox?.restorePreviousCore) return;
    const ok = await confirm({
      title: 'Restore the previous core?',
      message:
        `This puts back the sing-box core that the last upgrade replaced${
          backup?.version ? ` (v${backup.version})` : ''
        }, instead of v${singboxVersion}.\n\n` +
        'It disconnects first; connect again afterwards.',
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setStage('restoring');
    setMessage(null);
    try {
      const res = await window.api.singbox.restorePreviousCore();
      if (!res.success) {
        setStage('error');
        setMessage(res.error || 'Restoring the previous core failed.');
        return;
      }
      setStage('done');
      if (res.current) setSingboxVersion(res.current);
      // The last check compared against the core that was just replaced.
      setHasUpdate(null);
      setLatest(null);
      setValidated(true);
      setMessage(`Restored v${res.current}. Connect again to use it.`);
    } catch (err: any) {
      setStage('error');
      setMessage(err?.message || 'Restoring the previous core failed.');
    } finally {
      void refreshBackup();
    }
  };

  // Core upgrade is a desktop-only feature.
  if (!window.api?.singbox?.checkUpdate) return null;

  const stageLabel: Record<UpgradeStage, string> = {
    idle: '',
    checking: 'Checking for updates…',
    downloading: `Downloading… ${percent}%`,
    extracting: 'Extracting…',
    validating: 'Checking the new core against your configs…',
    installing: 'Installing…',
    restoring: 'Restoring the previous core…',
    done: '',
    error: '',
  };

  return (
    <div className="border-t border-surface-200 dark:border-surface-700/50 pt-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-surface-600 dark:text-surface-300">sing-box core update</p>
          <p className="text-[11px] text-surface-400 dark:text-surface-500">
            Downloads the latest core from GitHub, checks it against the SHA-256 GitHub publishes and tests it
            with your System, TUN and Split configs before installing.
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
            {hasUpdate ? (validated ? `Upgrade to v${latest}` : `Upgrade to v${latest}…`) : 'Upgrade'}
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

      {backup?.available && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-surface-400 dark:text-surface-500">
            Previous core kept{backup.version ? `: v${backup.version}` : ''}
          </p>
          <button
            onClick={handleRestore}
            disabled={busy}
            className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50 shrink-0"
          >
            Restore previous core
          </button>
        </div>
      )}

      <p className="text-[10px] text-surface-400 dark:text-surface-600">Installed: v{singboxVersion}</p>
      {confirmDialog}
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

function SplitRuleEditor({ applyNow }: { applyNow: () => Promise<void> }) {
  const { settings, updateSettings } = useSettingsStore();
  const { nodes } = useNodeStore();
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
    const mode = splitTargetChangeMode();
    // Apply the change live via the Clash API (no restart) when connected and
    // nothing is waiting to be applied.
    if (rule && mode === 'live' && window.api?.singbox?.select) {
      window.api.singbox.select(splitSelectorTag(rule), outbound).catch(() => {});
    } else if (rule && mode === 'reconnect') {
      // Main's watchdog is restarting the core with the old rules, and the
      // cache file would bring back the old choice: there is no core to take
      // a live select yet. Or "Reconnect to apply" is up, and the target's
      // tag may name another node in the running core. Either way, reconnect
      // with the new rules instead.
      void applyNow();
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
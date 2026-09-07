// ==================== Proxy Node Types ====================

export type ProxyProtocol =
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'shadowsocks'
  | 'hysteria2'
  | 'wireguard'
  | 'tuic'
  | 'anytls'
  | 'shadowtls'
  | 'openvpn';

export interface ProxyNode {
  id: string;
  name: string;
  type: ProxyProtocol;
  server: string;
  port: number;
  
  // VMess / VLess
  uuid?: string;
  alterId?: number;
  security?: string;
  flow?: string;
  
  // Trojan / Hysteria2
  password?: string;
  
  // Shadowsocks
  method?: string;
  
  // TLS
  tls?: boolean;
  sni?: string;
  allowInsecure?: boolean;
  fingerprint?: string; // uTLS fingerprint (e.g. chrome)

  // Reality (VLESS)
  realityPublicKey?: string; // pbk
  realityShortId?: string;   // sid

  // Transport
  transportType?: 'tcp' | 'ws' | 'grpc' | 'http' | 'quic';
  transportPath?: string;
  transportHost?: string;

  // TUIC / Hysteria2 (QUIC)
  congestionControl?: 'cubic' | 'new_reno' | 'bbr';
  udpRelayMode?: 'native' | 'quic';

  // Hysteria2 specifics.
  // QUIC traffic obfuscation. Without this, a server that REQUIRES obfs will
  // silently refuse the connection.
  //
  // "gecko" needs sing-box 1.14+; on an older core the node is skipped with a
  // reason in the log rather than emitted, because the core would reject the
  // whole config and dropping the obfs silently would fail against the server
  // anyway.
  obfsType?: 'salamander' | 'gecko';
  obfsPassword?: string;
  /**
   * Disable Chrome QUIC fingerprint parroting (sing-box 1.14+).
   *
   * 1.14 parrots Chrome's QUIC handshake by default so Hysteria2 traffic is
   * harder to fingerprint. The one case where that backfires: Chrome does not
   * advertise Ed25519, so a server presenting an Ed25519 certificate fails the
   * handshake. Symptom is a node that worked before a core upgrade and now
   * doesn't, with nothing obvious in the log. Ignored on cores below 1.14.
   */
  disableChromeParrot?: boolean;
  // Port hopping: a list of port ranges like ["2080:3000"]. Overrides `port`.
  serverPorts?: string[];
  hopInterval?: string; // e.g. "30s"
  // Max bandwidth in Mbps. If both are empty, sing-box uses BBR instead of
  // Hysteria's own congestion control.
  upMbps?: number;
  downMbps?: number;

  // ShadowTLS (wraps an inner Shadowsocks connection).
  // `password`/`method` carry the inner Shadowsocks credentials, while these
  // carry the ShadowTLS handshake settings.
  shadowTlsVersion?: 1 | 2 | 3;
  shadowTlsPassword?: string;

  // OpenVPN. Emitted as an `openvpn-client` endpoint; needs sing-box 1.14+.
  // Populated by importing a .ovpn file — these are certificate blobs, not
  // things anyone types by hand.
  //
  // Only TLS mode is supported. `static_key` mode is a pre-TLS dialect with no
  // forward secrecy that upstream keeps for immutable enterprise servers.
  /** Username for OpenVPN `auth-user-pass`. `password` holds the other half. */
  username?: string;
  /** Transport for the OpenVPN session, from `proto`. Defaults to udp. */
  ovpnNetwork?: 'udp' | 'tcp';
  /** Trusted CA, PEM. From the `<ca>` block. Required. */
  ovpnCa?: string;
  /** Client certificate, PEM. From `<cert>`. Must pair with ovpnClientKey. */
  ovpnClientCert?: string;
  /** Client private key, PEM. From `<key>`. Must pair with ovpnClientCert. */
  ovpnClientKey?: string;
  /**
   * Control channel wrapping, i.e. `tls-auth` / `tls-crypt`.
   *
   * `tls_crypt_v2` is deliberately absent: sing-box 1.14.0 panics on it, and a
   * panic kills the whole core, so such a node is rejected instead of emitted.
   */
  ovpnControlWrapType?: 'tls_auth' | 'tls_crypt';
  /**
   * The wrapping key — an OpenVPN Static key V1, which must be exactly 256
   * bytes. Any other size crashes the core, so it is validated before use.
   */
  ovpnControlWrapKey?: string;
  /** `key-direction`. Only meaningful for tls-auth. */
  ovpnControlWrapDirection?: 'server' | 'client';
  /** From `data-ciphers`, e.g. ["AES-256-GCM", "AES-128-GCM"]. */
  ovpnDataCiphers?: string[];
  /** From the legacy `cipher` directive: the pre-negotiation fallback cipher. */
  ovpnDataCiphersFallback?: string;
  /** From `auth`, e.g. "SHA256". Applies to non-AEAD ciphers and tls-auth. */
  ovpnAuth?: string;
  /** From `comp-lzo`. Compression weakens confidentiality; only set if required. */
  ovpnCompressionLzo?: string;

  // WireGuard. Emitted as an `endpoints` entry (the WireGuard *outbound* was
  // deprecated in sing-box 1.11 and removed in 1.13).
  privateKey?: string;
  localAddress?: string[];   // e.g. ["10.0.0.2/32", "fd00::2/128"]
  peerPublicKey?: string;
  preSharedKey?: string;
  reserved?: number[];       // 3 bytes
  mtu?: number;
  persistentKeepalive?: number; // seconds

  
  // Metadata
  tag?: string;
  groupId?: string;
  subscriptionId?: string;
  latency?: number; // ms, -1 = timeout
  /**
   * Which kind of test produced `latency`. Without this a number is ambiguous:
   * a TCP handshake to the server and a real request carried through the proxy
   * mean very different things, and only the second one proves the node works.
   */
  latencyKind?: NodeTestKind;
  lastTested?: number; // timestamp
  /** Download throughput in Mbps from the last speed test, if ever run. */
  speedMbps?: number;
  /** Whether UDP survived the tunnel on the last UDP check. */
  udpOk?: boolean;
  country?: string; // country code for flag
}

/**
 * The node tests offered in Node Manager.
 *
 * 'tcp'   TCP handshake straight to the node's host:port. Works offline, says
 *         nothing about whether the proxy itself works.
 * 'real'  HTTP request carried through that specific outbound, timed by
 *         sing-box. Proves the node actually works. Needs the core running.
 * 'udp'   SOCKS5 UDP ASSOCIATE + a real DNS query through the tunnel. Reveals
 *         TCP-only nodes, which silently break games, QUIC and voice.
 * 'speed' Download throughput through the tunnel.
 *
 * 'udp' and 'speed' run through the local proxy port, so they only describe the
 * outbound that is currently selected — testing a specific node means switching
 * the selector to it first and switching back afterwards.
 */
export type NodeTestKind = 'tcp' | 'real' | 'udp' | 'speed';

// ==================== Subscription Types ====================

export interface Subscription {
  id: string;
  name: string;
  url: string;
  lastUpdate?: number; // timestamp
  nodeCount: number;
  autoUpdate: boolean;
  updateInterval: number; // hours
  enabled: boolean;
}

// ==================== Settings Types ====================

export type ProxyMode = 'system' | 'tun' | 'split' | 'manual';
export type Theme = 'dark' | 'light' | 'system';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'panic';

export interface AppSettings {
  /**
   * Extra SOCKS / HTTP listeners. These are ONLY opened when
   * `separatePorts` is on — the `mixed` inbound on `mixedPort` already speaks
   * both SOCKS5 and HTTP, so separate ports are pure opt-in convenience for
   * apps that insist on a specific port number.
   */
  socksPort: number;
  httpPort: number;
  /**
   * Open dedicated SOCKS and HTTP inbounds in addition to the mixed one.
   * Off by default: extra listeners can collide with other proxy tools
   * (v2rayN's 10808/10809, nekoray's 2080), and a port collision makes the
   * core fail to start. Ports that duplicate another inbound are skipped.
   */
  separatePorts?: boolean;
  mixedPort: number;
  proxyMode: ProxyMode;
  /**
   * Allow other devices on the local network to use this machine as a proxy.
   * When on, the mixed inbound binds 0.0.0.0 instead of 127.0.0.1.
   * Off by default — an open proxy on an untrusted network is a real risk.
   */
  allowLan?: boolean;

  /**
   * How TUN/Split mode handles IPv6. This is a privacy-relevant choice, not
   * just a connectivity one.
   *
   * Two things decide the outcome: whether the TUN carries an IPv6 address
   * (that is what tells Windows it has working IPv6 and should prefer it, per
   * RFC 6724) and whether our DNS hands out AAAA. Note that DNS only governs
   * apps that ask us — browsers with built-in DoH (Brave, Chrome's Secure DNS,
   * Firefox) resolve AAAA themselves and cannot be kept on IPv4 by DNS at all.
   *
   * 'ipv4-only' (default) — TUN is IPv4-only, DNS is `ipv4_only`. With no IPv6
   *   route through the tunnel, apps fall back to IPv4 immediately, which every
   *   node can carry. Trade-off: on a network with real IPv6, IPv6 traffic is
   *   not captured and leaves via the physical interface, which can expose your
   *   real address (including via WebRTC). Same default as mihomo/clash.
   *
   * 'prefer-ipv4' — "Allow IPv6" in the UI. Dual-stack TUN and DNS is
   *   `prefer_ipv4`, so AAAA does reach the client and IPv6-only destinations
   *   become reachable, captured by the tunnel and sent through the proxy; your
   *   real IPv6 address is never exposed. Requires the node's server to have
   *   IPv6 egress — if it doesn't, IPv6 connections stall. Note that dual-stack
   *   destinations are still reached over IPv4 by design, so a "what's my IP"
   *   page will keep reporting the IPv4 exit; that is not a failure.
   *
   * 'block' — dual-stack TUN, DNS is `ipv4_only`, and a route rule refuses IPv6
   *   instead of proxying it. Leak-safe. The refusal lands after the gvisor
   *   stack has already accepted the handshake, so a DoH-enabled browser sees an
   *   established connection and then a reset, and retries. Use it only when
   *   you need IPv6 provably off and are willing to accept that.
   */
  ipv6Strategy?: 'block' | 'prefer-ipv4' | 'ipv4-only';

  /**
   * Keep RFC 1918 destinations off the tunnel by adding them to the TUN's
   * `route_exclude_address`, so packets for them never enter sing-box at all.
   *
   * Off by default. Turn it ON when a virtual network stack that shares the
   * host's loses connectivity while TUN or Split is active: WSL2 in mirrored
   * networking mode, Docker Desktop, or Hyper-V. Those all sit on private IPv4
   * NAT bridges, and pulling their packets into the tunnel is what breaks them.
   *
   * This REPLACED a `tunStrictRoute` toggle, which solved the same problem by
   * turning off TUN `strict_route` wholesale. That is not a viable trade on
   * Windows. Since sing-box 1.14 the TUN's `dns_mode` defaults to `hijack`, and
   * the documented Windows half of `hijack` — a WFP filter blocking port 53 on
   * every interface except the TUN — applies ONLY when `strict_route` is on.
   * Without that filter, Windows' Smart Multi-Homed Name Resolution queries the
   * DNS servers of all interfaces in parallel and keeps whichever answer lands
   * first. Resolution through the proxy costs 200ms+ while the local resolver
   * answers in single-digit ms, so the local answer always wins and the network
   * you are on silently owns your DNS. Reported as "TUN is up but I can't open
   * any site". `strict_route` is therefore now always on, and this option scopes
   * the escape hatch to the subnets that actually needed it.
   *
   * Note there is already a `route.rules` entry sending `ip_is_private`
   * destinations to `direct`, so private traffic was never proxied. The
   * difference is where it is decided: that rule acts after the packet has been
   * pulled through the TUN, this keeps it on the OS path from the start.
   */
  tunBypassLocalNetworks?: boolean;

  /**
   * TCP/IP stack for the TUN inbound.
   *
   *   'mixed'  (default) system TCP + gvisor UDP. sing-box's own default when
   *            built with the gVisor tag, which ours is.
   *   'system' hands TCP to the Windows network stack. Cheapest for bulk
   *            transfers; what v2rayN ships in its TUN template.
   *   'gvisor' reassembles everything in userspace. Most CPU-expensive, and the
   *            reason TUN video playback was previously very slow.
   *
   * Exposed rather than hardcoded because the right answer is host-dependent —
   * NekoRay makes it a user setting for the same reason. Try 'system' if TUN
   * throughput is poor; try 'gvisor' if UDP-heavy apps misbehave.
   */
  tunStack?: 'mixed' | 'system' | 'gvisor';

  /**
   * Schema version of the persisted settings, used for one-time migrations
   * (see settingsStore.loadFromStore). Bump SETTINGS_VERSION when a stored
   * value needs rewriting rather than just a new default.
   */
  settingsVersion?: number;

  /**
   * Version of the sing-box binary the generated config will be handed to,
   * e.g. "1.14.0". NOT a user setting and not persisted — it is filled in by
   * the backend (Electron main / web server) at generation time.
   *
   * The config surface differs between cores, and Settings → About can upgrade
   * the core independently of the app, so the generator cannot assume the
   * version it shipped with. An unknown value means "assume the oldest
   * supported core", since emitting a field the core doesn't know is fatal
   * while omitting a newer one only loses an optimisation.
   */
  coreVersion?: string;
  remoteDns: string;
  directDns: string;
  bypassChina: boolean;
  logLevel: LogLevel;
  autoStart: boolean;
  startMinimized: boolean;
  theme: Theme;

  // Split mode: domain-based routing rules. Each rule sends a group of
  // domains/keywords through a specific node. Uses TUN for system-wide capture.
  splitRules?: SplitRule[];
  splitApps?: string[];       // (legacy) per-app process names
  splitMode?: 'proxy' | 'direct'; // (legacy) per-app direction
}

export interface SplitRule {
  id: string;           // matches preset id or custom
  name: string;         // display label
  outbound: string;     // node name/tag, or "proxy", "direct", "auto"
  ruleSets: string[];   // rule_set tags to include
  enabled: boolean;
}

// ==================== Connection Types ====================

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface TrafficData {
  up: number;
  down: number;
  timestamp: number;
}

export interface TrafficStats {
  uploadSpeed: number;   // bytes/s
  downloadSpeed: number; // bytes/s
  totalUpload: number;   // bytes
  totalDownload: number; // bytes
  history: TrafficData[];
}

// ==================== Log Types ====================

export interface LogEntry {
  timestamp: string;
  message: string;
  level?: string;
}

// ==================== API Types (window.api) ====================

export interface ElectronAPI {
  singbox: {
    start: (configPath: string) => Promise<{ success: boolean; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    restart: (configPath: string) => Promise<{ success: boolean; error?: string }>;
    getStatus: () => Promise<ConnectionStatus>;
    getVersion: () => Promise<string>;
    getLogs: () => Promise<string[]>;
    clearLogs: () => Promise<boolean>;
    select: (selector: string, outbound: string) => Promise<{ success: boolean; error?: string }>;
    /** Which outbound the selector is actually using right now, per the Clash API. */
    getSelection?: (selector: string) => Promise<{ success: boolean; now?: string; error?: string }>;
    checkUpdate: () => Promise<{
      success: boolean;
      current?: string;
      latest?: string;
      hasUpdate?: boolean;
      downloadUrl?: string;
      notes?: string;
      error?: string;
    }>;
    upgrade: () => Promise<{
      success: boolean;
      upgraded?: boolean;
      current?: string;
      latest?: string;
      error?: string;
    }>;
    onUpgradeProgress: (callback: (data: { stage: string; percent?: number; message?: string }) => void) => void;
    onLog: (callback: (log: string) => void) => void;
    onStatusChange: (callback: (status: ConnectionStatus) => void) => void;
    onTrafficUpdate: (callback: (data: { up: number; down: number }) => void) => void;
  };
  config: {
    generate: (nodes: ProxyNode[], selectedIndex: number, settings: AppSettings) => Promise<object>;
    write: (config: object) => Promise<string>;
    read: () => Promise<object | null>;
  };
  tray?: {
    setMode: (mode: ProxyMode) => Promise<void>;
    onConnect: (callback: () => void) => void;
    onDisconnect: (callback: () => void) => void;
  };
  systemProxy: {
    enable: (host: string, port: number) => Promise<boolean>;
    disable: () => Promise<boolean>;
    getStatus: () => Promise<{ enabled: boolean; server: string }>;
  };
  file: {
    selectFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
    selectDirectory: () => Promise<string | null>;
    readText: (filePath: string) => Promise<string>;
    writeText: (filePath: string, content: string) => Promise<boolean>;
  };
  store: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  };
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<string>;
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    quit: () => Promise<void>;
    setAutoStart: (enabled: boolean) => Promise<void>;
    getAutoStart: () => Promise<boolean>;
    isAdmin: () => Promise<boolean>;
    relaunchAsAdmin: () => Promise<boolean>;
    setStartMinimized: (enabled: boolean) => Promise<void>;
  };
  network: {
    fetchUrl: (url: string, timeout?: number) => Promise<string>;
    testLatency: (host: string, port: number) => Promise<number>;
    /** Real delay through one outbound, via the Clash API. -1 = unreachable. */
    testDelay?: (tag: string, url?: string, timeout?: number) => Promise<number>;
    /** UDP check through the local proxy port (tests the ACTIVE outbound). */
    testUdp?: (proxyPort: number) => Promise<{ ok: boolean; ms: number; error?: string }>;
    /** Throughput through the local proxy port (tests the ACTIVE outbound). */
    testSpeed?: (
      proxyPort: number,
      options?: { url?: string; durationMs?: number }
    ) => Promise<{ mbps: number; bytes: number; ms: number; error?: string }>;
    getLanAddresses?: () => Promise<string[]>;
  };
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
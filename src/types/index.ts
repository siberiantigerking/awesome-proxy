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
  | 'shadowtls';

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
  // QUIC traffic obfuscation. sing-box 1.13 only supports "salamander"
  // ("gecko" was added in 1.14). Without this, a server that REQUIRES obfs
  // will silently refuse the connection.
  obfsType?: 'salamander';
  obfsPassword?: string;
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
   * All three serve clients `ipv4_only` DNS, so applications are never handed
   * an AAAA record and reach for IPv4 — which every node can carry. They differ
   * in what happens to IPv6 that shows up anyway, i.e. hardcoded IPv6 literals
   * that bypass DNS completely (Chrome's Secure DNS providers do this).
   *
   * 'prefer-ipv4' (default) — TUN is dual-stack, so that IPv6 is captured and
   *   proxied. Your real IPv6 address is never exposed, and nothing is broken
   *   outright. IPv6-only destinations still need an IPv6-capable node.
   *
   * 'block' — dual-stack TUN as well, but a route rule rejects IPv6 instead of
   *   proxying it. Equally leak-safe, though it leaves a black-holed IPv6
   *   default route: Windows connectivity probes retry over it and anything
   *   insisting on IPv6 fails outright. Use it to force IPv6 fully off.
   *
   * 'ipv4-only' — legacy behaviour: TUN is IPv4-only. IPv6 is NOT captured, so
   *   on an IPv6-capable network it bypasses the tunnel entirely and can leak
   *   your real address. Kept only as a fallback.
   */
  ipv6Strategy?: 'block' | 'prefer-ipv4' | 'ipv4-only';

  /**
   * TUN `strict_route`. On (default) it adds firewall rules that force all
   * traffic through the tunnel, which is what makes TUN leak-proof.
   *
   * Turn it OFF when a virtual network stack that shares the host's is losing
   * connectivity: WSL2 in mirrored networking mode, Docker, or Hyper-V. Those
   * lose packets to the strict rules, which looks like the proxy "randomly
   * breaking". The tunnel keeps working without it, just with weaker guarantees
   * that nothing slips past.
   */
  tunStrictRoute?: boolean;

  /**
   * Schema version of the persisted settings, used for one-time migrations
   * (see settingsStore.loadFromStore). Bump SETTINGS_VERSION when a stored
   * value needs rewriting rather than just a new default.
   */
  settingsVersion?: number;
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
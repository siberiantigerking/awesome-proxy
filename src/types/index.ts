// ==================== Proxy Node Types ====================

export type ProxyProtocol = 'vmess' | 'vless' | 'trojan' | 'shadowsocks' | 'hysteria2' | 'wireguard' | 'tuic';

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
  
  // Metadata
  tag?: string;
  groupId?: string;
  subscriptionId?: string;
  latency?: number; // ms, -1 = timeout
  lastTested?: number; // timestamp
  country?: string; // country code for flag
}

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
  socksPort: number;
  httpPort: number;
  mixedPort: number;
  proxyMode: ProxyMode;
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
  };
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
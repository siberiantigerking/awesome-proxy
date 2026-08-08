# Awesome Proxy

A Windows desktop proxy management GUI built on top of the [sing-box](https://github.com/SagerNet/sing-box) core, inspired by [nekoray](https://github.com/MatsuriDayo/nekoray).

> Formerly "SingBox Proxy Manager".

---

## Quick Start (no terminal needed)

Double-click one of the launchers in the project folder:

- **`Awesome Proxy (Silent).vbs`** — runs the desktop app **with no console window**; it lives in the system tray (right-click the tray icon to quit). Recommended for everyday use.
- **`Start Awesome Proxy (Desktop).bat`** — same desktop app, but keeps a console window open (useful for seeing logs / first-time build output).
- **`Start Awesome Proxy.bat`** — runs the backend + web UI and opens it in your browser at <http://localhost:5173>.
- **`Awesome Proxy Web (Silent).vbs`** — web mode with no console windows (ends via Task Manager → node.exe).

All launchers install dependencies and build automatically on first run.

> **TUN mode tip:** TUN requires Administrator rights. You don't need to start as
> admin — pick TUN and connect, and the app will offer to relaunch itself
> elevated via the Windows UAC prompt. To start elevated directly, right-click a
> launcher and choose **Run as administrator**.

---

## Proxy Modes

| Mode | Admin needed | Tray icon tint | What it does |
|------|:---:|:---:|--------------|
| **System Proxy** | No | 🔵 Blue | Sets the Windows system proxy to the local port; most apps follow it automatically. **Recommended default.** |
| **TUN** | Yes | 🔴 Red | Creates a virtual adapter that captures **all** traffic system-wide, including apps that ignore the system proxy. Prompts to elevate when needed. |
| **Split** | Yes | 🟢 Green | Per-app / per-domain routing — choose which apps or services go through the proxy (or bypass it) via rule sets, while everything else goes the other way. Uses TUN under the hood, so it needs admin too. |
| **Manual** | No | 🟡 Yellow | Only starts the local mixed-proxy port (e.g. `127.0.0.1:7890`) without changing any system settings. Use it to point a specific app/browser profile or another device at the proxy yourself, or when another tool manages the system proxy. |

The system tray icon changes color to match whichever mode is currently
connected, so you can tell at a glance without opening the window. Right-click
the tray icon for a one-click **Connect/Disconnect** toggle (the label flips
based on current state) plus Show Window and Quit.

---

## Project Vision

A **user-friendly proxy management tool** for Windows that makes it easy to:
- Import and manage proxy nodes (clipboard paste, manual entry, subscription URLs, or QR codes)
- Connect/disconnect with a single click
- Monitor traffic in real time
- Switch between nodes quickly
- Manage system proxy settings automatically

Inspired by **nekoray**, built with modern web technology for a cleaner UI and easier setup.

---

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│   React Frontend    │────▶│   Node.js Backend   │────▶│   sing-box Core  │
│  (Vite + Tailwind)  │◀────│  (Express + WS)     │◀────│   (v1.13.12)     │
│   Port 5173         │     │   Port 3456 (local)  │     │   Binary         │
└─────────────────────┘     └─────────────────────┘     └──────────────────┘
```

In **Electron (desktop) mode** the backend logic runs inside the Electron main
process instead of the standalone server, communicating with the UI over a
whitelisted IPC bridge.

### Frontend (React + TypeScript)
- React 18 + TypeScript
- Tailwind CSS with **light & dark themes**
- Zustand for state, Recharts for traffic charts

### Backend (Node.js / Electron main)
- Express REST API + WebSocket for real-time events (web mode)
- Spawns/manages sing-box as a child process
- Persistence in `%APPDATA%/singbox-proxy-manager/`
- System proxy via Windows registry

### Shared
- `shared/config-generator.cjs` — single source of truth that turns nodes into a
  sing-box 1.13 config, used by **both** the web server and the Electron main
  process so they can never drift apart.

### Pages
| Page | Description |
|------|-------------|
| **Dashboard** | Connection status, live traffic chart, quick node switcher |
| **Nodes** | Add/edit/delete nodes, paste links, **scan QR codes**, import subscriptions, test latency, move to top |
| **Subscriptions** | Add subscription URLs with **auto-update**, cascade delete |
| **Settings** | Ports, proxy mode, DNS, bypass rules, **theme switch**, auto-start |
| **Logs** | Real-time sing-box log viewer |

---

## Features

### Supported protocols

| Protocol | Import via | Notes |
|----------|-----------|-------|
| **VMess** | link, Clash YAML, manual | ws/grpc/http transports |
| **VLESS** | link, Clash YAML, manual | incl. **Reality** + XTLS Vision flow |
| **Trojan** | link, Clash YAML, manual | |
| **Shadowsocks** | link, Clash YAML, manual | incl. SS-2022 ciphers |
| **Hysteria2** | link, Clash YAML, manual | QUIC-based |
| **TUIC** | `tuic://`, Clash YAML, manual | v5; congestion control + UDP relay mode |
| **AnyTLS** | `anytls://`, Clash YAML, manual | requires sing-box 1.12+ |
| **ShadowTLS** | Clash YAML, manual | v1/v2/v3; wraps an inner Shadowsocks connection |
| **WireGuard** | Clash YAML, manual | emitted as a sing-box `endpoint` (see note) |

> **ShadowTLS** and **WireGuard** have no widely-agreed share-link format, so
> they're added via manual entry or a Clash/Mihomo YAML subscription rather than
> a `://` link.

> **WireGuard note:** the sing-box WireGuard *outbound* was deprecated in 1.11
> and **removed in 1.13**, so WireGuard nodes are generated as a top-level
> `endpoints` entry instead. Endpoint tags are referenced by selectors and route
> rules exactly like outbound tags, so node switching and Split rules work
> normally.

### Core
- Proxy link parsing — `vmess://`, `vless://` (incl. **Reality**), `trojan://`, `ss://`, `hysteria2://`/`hy2://`, `tuic://`, `anytls://`, IPv6 hosts
- Clash / Mihomo YAML subscription parsing (real YAML parser, handles nested `reality-opts`, `ws-opts`, etc.)
- Base64 / plain-text / URL-safe subscription formats
- **QR code import** — scan from an image file or from the clipboard
- Supported protocols: **VMess, VLESS (incl. Reality), Trojan, Shadowsocks,
  Hysteria2 (incl. obfs + port hopping), TUIC, AnyTLS, ShadowTLS, WireGuard**
- sing-box **1.13-compatible** config generation (validated against the bundled binary)
- Start / stop / restart the core with live status
- Windows system-proxy enable/disable
- **Node groups** — filter the node list by which subscription imported it
- **LAN sharing** (optional) — let other devices on your network use this proxy
- **IPv6 leak control** — see [IPv6 handling](#ipv6-handling-tun--split) below
- Country detection + flag emojis from node names
- Real-time logs over WebSocket

### Nodes & Subscriptions
- **Test All latency** — concurrent probing with per-node progress
- **Move node to top** of the list
- New nodes are auto-selected so they appear on the Dashboard immediately
- **Auto-update subscriptions** on a configurable interval (hours)
- Deleting a subscription also removes its imported nodes (with confirmation)

### UI/UX
- **Light & dark themes** (plus "system") — switch in Settings
- Custom frameless title bar with the app logo
- Connection status, traffic chart, quick-switch grid
- Loading / spinner / status indicators
- **System tray**: one-click Connect/Disconnect toggle, and a mode-colored
  tray icon (blue/red/green/yellow for System/TUN/Split/Manual) so the active
  mode is visible without opening the window

### Split Mode (domain-based routing)
- Per-service rule sets (46+ curated presets: Reddit, Discord, Steam,
  Notion, AI providers, streaming, gaming platforms, etc.) — route each
  service through a specific node/selector via remote `.srs` rule sets
- Each rule becomes its own selector outbound; switch a rule's target
  live via the Clash API without restarting sing-box
- Falls back to full-tunnel TUN capture for any traffic not matched by a rule

### sing-box Core Upgrade
- One-click "Check for Updates" / "Upgrade Core" in Settings → About
- Queries the GitHub releases API, downloads the matching
  `sing-box-<version>-windows-amd64.zip` (with mirror fallback), replaces
  the bundled binary, and reports progress — no manual file swapping

### Real traffic monitoring
- Polls sing-box's Clash API (`127.0.0.1:9090`) and derives live up/down speed
  from the cumulative counters (both web and Electron modes).

### Security
- Electron sandbox: `contextIsolation: true`, `nodeIntegration: false`
- Whitelisted preload IPC bridge — no direct Node access from the renderer
- Command-injection prevention for system-proxy commands (host/port validation)
- **SSRF protection** on URL fetching (blocks localhost / private ranges) in
  both Electron and the web backend
- Web backend bound to `127.0.0.1` only, with CORS + origin (CSRF) checks and
  WebSocket origin verification
- Path validation restricting file access to app directories (Electron)

---

## Running From Source

### Prerequisites
- **Node.js 18+** (developed/tested on Node 24)
- The sing-box binary at `resources/bin/sing-box.exe` (already included)

### Install
```cmd
cd /d D:\CZworkspace\awesome-proxy
npm install
```

### Desktop (Electron) — recommended
```cmd
npm run electron:dev      REM development with hot reload
npm run electron:build    REM produce an installer in release/
```
Or just double-click **`Start Awesome Proxy (Desktop).bat`**.

### Web mode (browser + local backend)
Two terminals from the project folder:
```cmd
npm run server            REM Terminal 1 - backend on 127.0.0.1:3456
npm run web:ui            REM Terminal 2 - Vite UI on http://localhost:5173
```
Or just double-click **`Start Awesome Proxy.bat`**.

### Add a proxy node
1. Go to **Nodes**.
2. Click **Add Node** (manual), or **Import** to paste links / scan a QR code / paste a base64 subscription.
3. Go to **Dashboard**, pick the node, click **Connect**.

---

## Using It On Another Computer

The whole app is self-contained and **portable** — there are no absolute paths
baked into the code. You have two options.

### Option A — Copy the folder (simplest)

1. Copy the entire `awesome-proxy` folder to the other Windows PC (any drive/path
   is fine, e.g. `C:\Apps\awesome-proxy`).
2. Make sure **Node.js 18+** is installed on that PC (<https://nodejs.org>).
3. **Recommended:** delete the copied `node_modules` folder before/after copying
   and run `npm install` fresh on the new PC. `node_modules` can contain
   platform-specific binaries (esbuild, electron) and is large; reinstalling is
   cleaner and faster than copying it.
   ```cmd
   cd /d C:\Apps\awesome-proxy
   rmdir /s /q node_modules
   npm install
   ```
4. Double-click **`Start Awesome Proxy.bat`** (browser) or
   **`Start Awesome Proxy (Desktop).bat`** (desktop). First run builds/install
   automatically.

What carries over and what doesn't:
- **Bundled:** the sing-box core (`resources/bin/sing-box.exe`), all source, the
  launchers, the logo/icons.
- **NOT copied with the folder:** your saved nodes/subscriptions/settings — those
  live in `%APPDATA%\singbox-proxy-manager\` on each machine, not in the project
  folder. To migrate them, copy that folder too (see Backup below), or just
  re-add your subscription on the new PC.

> Tip: if the target PC has no internet access to the npm registry, copy the
> `node_modules` folder along with everything else instead of reinstalling. It
> will work as long as both PCs are Windows x64.

### Option B — Build an installer (cleanest for non-developers)

On a machine that has the dependencies installed:
```cmd
npm run electron:build
```
This produces a Windows installer (NSIS `.exe`) in the `release/` folder. Copy
that single installer to the other PC and run it — no Node.js required on the
target machine. The sing-box binary and icons are bundled into the install.

### Backup / migrate your data
Your nodes, subscriptions, and settings are stored at:
```
%APPDATA%\singbox-proxy-manager\
```
Copy that folder to the same location on the new PC to bring everything with you.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Tailwind CSS, Zustand, Recharts |
| Backend | Node.js, Express, WebSocket (ws) |
| QR / icons | jsQR, jimp + png-to-ico (build-time icon generation) |
| Proxy core | sing-box 1.13.16 (upgradeable in-app) |
| Build tool | Vite 5 |
| Desktop | Electron 31 |

---

## NPM Scripts

| Script | What it does |
|--------|--------------|
| `npm run electron:dev` | Desktop app with hot reload |
| `npm run electron:build` | Build the Windows installer into `release/` |
| `npm run server` | Start the web-mode backend (127.0.0.1:3456) |
| `npm run web:ui` | Start the Vite web UI (http://localhost:5173) |
| `npm run build` | Type-check + build renderer and Electron main |
| `npm run icons` | Regenerate `resources/icon.png` / `icon.ico` from `logo.jpg` |

---

## File Structure

```
awesome-proxy/
├── electron/
│   ├── main.ts                  # Electron main process
│   └── preload.ts               # Context bridge (IPC whitelist)
├── ctrlbreak-src/
│   ├── CtrlBreak.cs              # Source for the graceful-shutdown helper
│   └── README.md                # Why it exists / how to rebuild it
├── server/
│   └── index.js                 # Web-mode Node.js backend
├── shared/
│   └── config-generator.cjs     # Shared sing-box config generator
├── scripts/
│   └── make-icons.cjs           # Generates icon.png/icon.ico + per-mode tray tints
├── src/
│   ├── components/              # Sidebar, TitleBar, Icons
│   ├── pages/                   # Dashboard, NodeManager, SubscriptionManager, Settings, Logs
│   ├── services/
│   │   ├── node-parser.ts       # Parse proxy links (engine-independent)
│   │   ├── subscription-fetcher.ts  # Fetch & parse subscriptions (js-yaml)
│   │   ├── qr-scanner.ts        # Decode QR codes (jsQR)
│   │   ├── auto-update.ts       # Subscription auto-update scheduler
│   │   ├── split-presets.ts     # Split-mode domain/rule-set presets
│   │   ├── connection.ts        # connect/disconnect/reconnect + live selector switching
│   │   ├── theme.ts             # Light/dark theme application
│   │   └── web-api.ts           # Web-mode API client
│   ├── store/                   # Zustand stores (nodes, settings, subscriptions)
│   ├── types/                   # TypeScript types
│   ├── App.tsx / main.tsx / index.css
├── resources/
│   ├── bin/sing-box.exe         # sing-box core binary
│   ├── bin/ctrlbreak.exe        # Graceful-shutdown helper (see ctrlbreak-src/)
│   ├── icon.png / icon.ico      # App icons (generated from logo.jpg)
│   └── icon-{system,tun,split,manual}.png  # Per-mode tray icon tints
├── public/logo.png              # UI logo
├── logo.jpg                     # Source logo
├── Start Awesome Proxy.bat
├── Start Awesome Proxy (Desktop).bat
├── package.json
├── vite.config.ts               # Electron build config
├── vite.config.web.ts           # Web mode config
└── tailwind.config.js
```

---

## Notes & Limitations

- **TUN mode** requires Administrator rights on Windows (TUN/TAP routing is
  privileged). You can start the app normally and switch to TUN — it will prompt
  to relaunch elevated via UAC. System-proxy mode needs no elevation and is the
  default.
- **QR import** is image-based (file or clipboard), not a live camera scanner.
- **Credentials** (uuid/password) are stored in plaintext in `%APPDATA%`, same as
  nekoray. Treat the data folder as sensitive.
- The web backend is intentionally bound to `127.0.0.1`; do not expose it to a
  LAN/public interface — it can control the system proxy and the core process.
- **`cache.db`** (sing-box's Clash-API selector-state cache) is written to the
  project root in dev mode and to `%APPDATA%\singbox-proxy-manager\` when
  installed. It's gitignored on purpose — it can contain your node tags. It's
  never bundled into the built app/installer either way.

### IPv6 handling (TUN / Split)

Settings → **IPv6 Handling** controls how IPv6 is treated in TUN and Split
mode. This is a privacy setting, not only a connectivity one.

Whether the TUN interface carries an IPv6 address decides whether IPv6 traffic
**enters the tunnel at all** — it installs (or omits) the IPv6 default route.
This is independent of `dns.strategy`, which only affects domain resolution and
cannot stop a browser dialling a hardcoded IPv6 literal (Chrome's Secure DNS
providers do exactly that, e.g. Cloudflare `2606:4700:4700::1111`).

| Option | Behaviour |
|---|---|
| **Block IPv6** (default) | Clients are served `ipv4_only` DNS, so they are never handed an AAAA record and never attempt IPv6. The TUN is still dual-stack so hardcoded IPv6 literals are captured and rejected rather than leaking. IPv6-only sites won't load. |
| **Prefer IPv4, allow IPv6** | TUN is dual-stack and IPv6 is proxied, with IPv4 preferred for dual-stack destinations. IPv6-only sites work only if your node supports IPv6, otherwise they may stall. |
| **IPv4 only** (legacy) | TUN is IPv4-only, so IPv6 is **not** captured. On an IPv6-capable network it exits via your real connection and can expose your actual IP, including via WebRTC. Fallback only. |

> **Why "Block IPv6" uses `ipv4_only` and not `prefer_ipv4`:** `prefer_ipv4`
> still returns AAAA records to the client. In TUN mode the OS does its own A
> and AAAA lookups, and because a dual-stack TUN makes Windows believe it has
> real IPv6 connectivity, it then *prefers* IPv6 per RFC 6724. Pairing that
> with an IPv6 reject rule produced "try IPv6, get refused" — i.e. broken
> browsing. Withholding AAAA is what actually makes clients stay on IPv4.

Regardless of the client-facing strategy, `route.default_domain_resolver` uses
`prefer_ipv4` so an **IPv6-only proxy node** can still resolve; `ipv4_only`
alone would make such a node impossible to connect to.

The reject rule is only emitted in TUN/Split mode and only for **global** IPv6:
it is ordered after the private-address rule so link-local and ULA (`fe80::`,
`fc00::`) keep working on the LAN.

**WebRTC caveat:** in System Proxy and Manual mode the browser sends WebRTC
STUN over UDP, which the Windows system proxy does not cover, so that traffic
never reaches sing-box. WebRTC IP leaks therefore **cannot** be prevented from
this app in those modes — use TUN or Split if that matters to you, or disable
WebRTC in your browser.

### Windows TUN shutdown reliability

sing-box needs to run its own graceful-shutdown path to release the WinTun
adapter cleanly; a plain process kill (which is all `child.kill('SIGTERM')`
actually does on Windows — there's no real POSIX signal) skips that cleanup
and can corrupt the adapter for the *next* TUN/Split connect (`create adapter:
... file already exists` / `open existing adapter: Element not found`, a
known upstream limitation — see
[SagerNet/sing-box#3806](https://github.com/SagerNet/sing-box/issues/3806)).

To work around it, `resources/bin/ctrlbreak.exe` (source in `ctrlbreak-src/`,
compiled with the .NET Framework C# compiler that ships with Windows) sends a
real console `CTRL_BREAK_EVENT` to the sing-box process before ever falling
back to a hard kill, letting it shut down gracefully. See
`ctrlbreak-src/README.md` for the implementation notes and why the helper's
own exit status can't be trusted as a success signal.

---

## Security Model

| Area | Implementation |
|------|---------------|
| Electron sandbox | `contextIsolation: true`, `nodeIntegration: false` |
| IPC whitelist | Preload exposes only specific API methods via `contextBridge` |
| Command injection | `sanitizeHost()` regex validation + port range check |
| SSRF prevention | `isUrlSafe()` blocks localhost, private IPs, non-http protocols |
| Web backend exposure | Bound to `127.0.0.1`, CORS + origin (CSRF) + WS origin checks |
| File access | `isPathAllowed()` restricts to app directories (Electron) |
| Data storage | Credentials stored in plaintext (same as nekoray) |

---

## References

- [sing-box Documentation](https://sing-box.sagernet.org/)
- [sing-box Migration Guide (1.12+)](https://sing-box.sagernet.org/migration/#migrate-to-new-dns-server-formats)
- [nekoray (Inspiration)](https://github.com/MatsuriDayo/nekoray)
- [sing-box GitHub](https://github.com/SagerNet/sing-box)

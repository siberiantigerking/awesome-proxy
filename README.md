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
│  (Vite + Tailwind)  │◀────│  (Express + WS)     │◀────│   (v1.14.0)      │
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
  sing-box config, used by **both** the web server and the Electron main
  process so they can never drift apart. It also **gates fields by core
  version**, because Settings → About can upgrade sing-box independently of the
  app: a field the running core doesn't know is rejected outright, so the
  generator is told which core it is generating for and emits accordingly.

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
| **OpenVPN** | `.ovpn` file | TLS mode only; needs core 1.14+. Emitted as an `openvpn-client` endpoint |

> **ShadowTLS** and **WireGuard** have no widely-agreed share-link format, so
> they're added via manual entry or a Clash/Mihomo YAML subscription rather than
> a `://` link. **OpenVPN** has none either — import the `.ovpn` profile via
> **Import → Import .ovpn File**.

> **OpenVPN notes.** The importer reads `remote`, `proto`, `port`, the inline
> `<ca>` / `<cert>` / `<key>` / `<tls-auth>` / `<tls-crypt>` blocks,
> `key-direction`, `data-ciphers`, `cipher`, `auth`, `comp-lzo`, `tun-mtu` and
> `verify-x509-name`. Anything it recognises but can't reproduce is reported in
> the import dialog rather than dropped silently, so you find out up front
> instead of wondering why the connection differs from the official client.
> Known limits:
>
> - **Only the first `remote` is imported.** Add the others as separate nodes if
>   you want to switch between them.
> - **`tls-crypt-v2` is refused.** sing-box 1.14.0 panics on it, and a panic
>   takes the whole core down — every other node with it — so such a profile is
>   rejected at import instead.
> - **Only TLS mode.** `static_key` is a pre-TLS OpenVPN dialect with no forward
>   secrecy, kept upstream only for immutable enterprise servers.
> - Username/password profiles import fine but the credentials aren't in the
>   file; fill them in by editing the node. Note that providers often issue a
>   *separate* OpenVPN username rather than reusing your account password.
> - **One profile connects at a time.** An `openvpn-client` endpoint dials its
>   server as soon as the core starts and stays connected whether or not any
>   traffic uses it — that is how endpoints work, and it holds true even for an
>   endpoint no selector or route rule references. Emitting every imported
>   profile would therefore open every VPN session at once and hit the per-account
>   device limit, which free tiers commonly set to one: the first profile
>   connects and the rest silently never establish. So only the **selected**
>   OpenVPN profile is written into the config, and none at all while a
>   non-OpenVPN node is selected. The consequence is that switching to or away
>   from an OpenVPN node restarts the core instead of using the instant
>   selector switch that other protocols get.

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
  Hysteria2 (incl. obfs + port hopping), TUIC, AnyTLS, ShadowTLS, WireGuard,
  OpenVPN**
- **Core-version-aware config generation**, validated against the bundled binary.
  Fields added in a newer core are only emitted when the running core actually
  has them; an unknown core is treated as the oldest supported one, because
  emitting a field the core doesn't recognise stops it from starting at all
  while omitting a newer one only loses an optimisation.
- Start / stop / restart the core with live status
- Windows system-proxy enable/disable, with a real bypass list and a WinINET
  refresh so running apps pick the change up — see
  [Local and intranet addresses](#local-and-intranet-addresses)
- **Node groups** — filter the node list by which subscription imported it
- **LAN sharing** (optional) — let other devices on your network use this proxy
- **IPv6 leak control** — see [IPv6 handling](#ipv6-handling-tun--split) below
- **Optional dedicated SOCKS / HTTP ports** — the mixed inbound already speaks
  both protocols on one port, so these are opt-in for apps that insist on a
  particular port number. A port that duplicates another inbound is skipped
  (sing-box treats duplicate listeners as fatal) and the UI says so.
- **A broken node can't take down the rest** — nodes whose settings would make
  the core refuse to start (a Shadowsocks-2022 method with a non-base64 key, a
  WireGuard key that isn't 32 bytes, a missing uuid/server/port) are left out of
  the config entirely, including from the selector and urltest groups, and the
  reason is written to the log. Previously one malformed node meant every node
  stopped working, because `sing-box check` passes some configs that then abort
  at service creation.
- **Encrypted DNS with no bootstrap dependency** — DoH servers are addressed by
  IP literal (Cloudflare `1.1.1.1` for remote, AliDNS `223.5.5.5` for the China
  split). A hostname would have to be resolved by the local resolver first, and
  on a network where that resolver is hijacked, the lookup is exactly what fails.
- Country detection + flag emojis from node names
- Real-time logs over WebSocket

### Nodes & Subscriptions
- **Four node tests**, picked from the dropdown next to Test All:
  | Test | What it measures | Needs a connection? |
  |---|---|---|
  | **TCP ping** | Handshake time straight to the node's host:port. Doesn't prove the proxy works. | No |
  | **Real delay** | Latency of a request actually carried through that node, timed by sing-box via the Clash API. This is the one that proves a node works end to end. | Yes |
  | **UDP check** | Whether UDP survives the tunnel, via SOCKS5 UDP ASSOCIATE + a STUN binding request. Reveals TCP-only nodes, which silently break games, QUIC and voice chat. | Yes |
  | **Speed test** | Download throughput through the tunnel. | Yes |
- **Test All** covers the nodes currently visible (so the group/search filter
  doubles as the selection), capped per run — 50 for TCP ping / real delay, 10
  for UDP / speed — with a **Stop** button and throttled progress updates. The
  cap exists because an uncapped run over a large subscription made the window
  feel frozen.
- UDP check and speed test travel through the **local proxy port**, which always
  follows the active selector, so testing a specific node means switching to it
  and switching back. That briefly redirects live traffic, which is why those two
  are one-at-a-time and ask for confirmation before a batch run.
- **Move node to top** of the list
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
| Proxy core | sing-box 1.14.0 (upgradeable in-app) |
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
│   ├── config-generator.cjs     # Shared sing-box config generator
│   └── node-probes.cjs          # Node tests: tcp ping / real delay / UDP / speed
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
│   │   ├── node-tests.ts        # Node test orchestration (select/restore dance)
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
| Option | TUN | DNS to clients | Behaviour |
|---|---|---|---|
| **IPv4 only** (default) | IPv4 | `ipv4_only` | No IPv6 route through the tunnel, so Windows has nothing to prefer and apps use IPv4 — which every node can carry. On a network with real IPv6, IPv6 traffic is not captured and exits via your real connection, which can expose your actual IP (including via WebRTC). Same default as mihomo/clash and v2rayN. |
| **Allow IPv6** | dual-stack | `prefer_ipv4` | AAAA reaches the client, so IPv6 is available, captured by the tunnel and carried through the proxy. Your real IPv6 address never reaches the network. Requires the node's server to have working IPv6 egress; if it doesn't, IPv6 connections stall. |
| **Block IPv6** | dual-stack | `ipv4_only` | A route rule refuses IPv6 instead of proxying it. Leak-safe, but see the warning below — this is the option most likely to look like a total failure. |

> **Why DNS alone cannot keep an app on IPv4.** Withholding AAAA works only for
> apps that ask *us*. Browsers with built-in DoH — Brave, Chrome's Secure DNS,
> Firefox — resolve AAAA themselves and never send us the query. If the TUN is
> dual-stack, Windows reports working IPv6, and per RFC 6724 those apps then
> prefer IPv6 for nearly everything. On a node without IPv6 egress the result is
> either stalled connections (**Proxy IPv6**) or connections refused after the
> handshake was already accepted (**Block IPv6**). Both read as "the app is
> completely broken" while the config looks perfectly fine.
>
> The only thing that reliably stops it is giving the tunnel no IPv6 address at
> all, so the OS has nothing to prefer. Hence the default.

> **And why `prefer_ipv4` is right for Allow IPv6 specifically.** Serving
> `ipv4_only` there was a real bug: the tunnel was dual-stack and ready to carry
> IPv6, ip.sb still reported no IPv6, and the reason was that every cooperating
> app had only ever been handed an A record. `prefer_ipv4` fixes that — it orders
> answers IPv4-first but does hand over AAAA, so IPv6-only destinations become
> reachable through the tunnel.
>
> Expect **Allow IPv6** to keep showing an IPv4 address on a "what's my IP" page.
> Sites with both records are reached over IPv4 on purpose; that is what "prefer
> IPv4" means, and it is why this option is safe on nodes with patchy IPv6. Test
> it against an IPv6-only name such as `ipv6.google.com` instead.

> **If browsing dies in TUN or Split mode, check this setting first.** The
> signature in the log is an IPv6 destination that reaches
> `inbound connection to [....]:443` and is followed by no `outbound` line at
> all — `reject` is silent. Switch to **IPv4 only**.

Regardless of the client-facing strategy, `route.default_domain_resolver` uses
`prefer_ipv4` so an **IPv6-only proxy node** can still resolve; `ipv4_only`
alone would make such a node impossible to connect to.

The reject rule is only emitted in TUN/Split mode and only for **global** IPv6:
it is ordered after the private-address rule so link-local and ULA (`fe80::`,
`fc00::`) keep working on the LAN. It cannot be moved ahead of the sniff rule to
refuse IPv6 sooner, because `hijack-dns` matches on the sniffed protocol and
would stop seeing DNS.

## Local and intranet addresses

Enabling the system proxy writes three registry values, not two: `ProxyEnable`,
`ProxyServer` and — added in 1.4.0 — `ProxyOverride`, the bypass list. It then
tells WinINET the settings changed (`INTERNET_OPTION_SETTINGS_CHANGED` +
`REFRESH`) so applications that are already running re-read them instead of
holding the previous configuration until restart.

Both were missing before, and the effects were easy to mistake for something
else:

- With no bypass list, Windows handed **localhost, LAN and intranet requests to
  the proxy**, which then tried to reach them from the remote node. Local dev
  servers, a NAS, a router page or a WSL2 service would simply not open.
- Without the refresh broadcast, toggling the proxy appeared to do nothing in
  apps that were already open.
- The bypass list was also whatever a *previously installed* proxy tool had left
  behind, so behaviour depended on install history. It is now written explicitly
  every time, and removed again on disable.

The default bypass covers `localhost`, `127.*`, `10.*`, `192.168.*`,
`172.16.*`–`172.31.*`, `169.254.*`, `*.local` and `<local>`. The `172.16/12`
range is spelled out per octet deliberately: WSL2, Hyper-V and Docker Desktop put
their virtual adapters there, and proxying it is what breaks those stacks.

sing-box gets matching treatment, which is what covers clients that never see the
Windows list — **WSL2 with `http_proxy` pointed at this app is exactly that
case**, as is any application given an explicit proxy:

- `localhost` is answered from a built-in hosts entry. The core's own `local` DNS
  server does **not** resolve it — measured against the bundled binary, the query
  goes upstream and returns `NXDOMAIN`, so the request died even though it was
  routed correctly. `route.default_domain_resolver` pins outbound resolution and
  ignores `dns.rules`, so the fix is a `resolve` route action with its own server.
- `.local`, `.internal`, `.lan`, `.home.arpa` and any single-label name go direct.

One limitation worth knowing: a **single-label hostname** (`http://mypc:3000`)
cannot be resolved by sing-box at all — Windows finds those over NetBIOS/mDNS,
which the core does not speak. Routing them direct keeps an internal hostname
from being handed to a remote proxy, but only the Windows bypass list can
actually connect them. So in Manual mode, or when pointing another machine at
this proxy, prefer IPs or fully-qualified names for local targets.

**WebRTC caveat:** in System Proxy and Manual mode the browser sends WebRTC
STUN over UDP, which the Windows system proxy does not cover, so that traffic
never reaches sing-box. WebRTC IP leaks therefore **cannot** be prevented from
this app in those modes — use TUN or Split if that matters to you, or disable
WebRTC in your browser.

### TUN and virtual network stacks (WSL, Docker, Hyper-V)

Two things matter when TUN or Split runs alongside WSL2, Docker or Hyper-V.

**Both TUN addresses avoid the documentation defaults on purpose.** sing-box's
examples use `172.19.0.1/30` and `fdfe:dcba:9876::1/126`, and because every
client that copied those examples now claims the same pair, they collide. On one
machine running NekoBox we confirmed its `neko-tun` adapter holding `172.19.0.1`
**and** `fdfe:dcba:9876::1` — exactly what we used to take. 172.16/12 is crowded
regardless: Docker Desktop and WSL NAT bridges live in 172.17–172.20. Two
adapters claiming one address leaves Windows with conflicting routes, which
presents as "it worked, then randomly stopped".

We use `198.18.0.1/30` for IPv4 — the RFC 2544 benchmarking range, reserved for
testing and used by mihomo for the same reason, so real networks and container
bridges never occupy it — and `fd19:8180:9a3f::1/126` for IPv6, a randomly
chosen ULA global ID, which is what ULA is designed for.

**`strict_route` can starve a shared network stack.** WSL2 in
[mirrored networking mode](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
shares the Windows network stack rather than sitting behind NAT, and the extra
firewall rules that make TUN leak-proof can drop that traffic. If WSL, Docker or
Hyper-V loses connectivity while TUN/Split is active, turn off **Strict route**
in Settings → IPv6 Handling. The tunnel still works; it just no longer guarantees
that nothing slips past it. For reference, NekoBox ships with strict route
**off** by default, so unticking it here gives you the same behaviour.

A note for the WSL mirrored-mode setup specifically: exporting
`http_proxy`/`https_proxy` to `127.0.0.1:7890` inside WSL works because mirrored
mode shares localhost with Windows. That path goes through our mixed inbound and
needs no LAN sharing and no TUN — so if TUN is what destabilises things, System
Proxy mode plus those environment variables is the calmer combination.

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

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
│  (Vite + Tailwind)  │◀────│  (Express + WS)     │◀────│   (v1.14.4)      │
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
- Persistence in `%APPDATA%\awesome-proxy\` for the desktop app and in
  `%APPDATA%\singbox-proxy-manager\` for the web-mode backend (see
  [Backup / migrate your data](#backup--migrate-your-data))
- System proxy via Windows registry

### Shared
- `shared/config-generator.cjs` — single source of truth that turns nodes into a
  sing-box config, used by **both** the web server and the Electron main
  process so they can never drift apart. It also **gates fields by core
  version**, because Settings → About & Updates can upgrade sing-box independently of the
  app: a field the running core doesn't know is rejected outright, so the
  generator is told which core it is generating for and emits accordingly.

### Pages
| Page | Description |
|------|-------------|
| **Dashboard** | Connection status, live traffic chart, quick node switcher |
| **Nodes** | Add/edit/delete nodes, paste links, **scan QR codes**, **share nodes as links or QR codes**, import subscriptions, test latency, move to top |
| **Subscriptions** | Add subscription URLs with **auto-update**, **share a URL as a QR code**, cascade delete |
| **Settings** | Ports, proxy mode, DNS, bypass rules, **theme switch**, auto-start |
| **Logs** | Real-time sing-box log viewer |

---

## Features

### Supported protocols

| Protocol | Import via | Notes |
|----------|-----------|-------|
| **VMess** | link, Clash YAML, manual | ws, gRPC, HTTP/2 and HTTPUpgrade transports |
| **VLESS** | link, Clash YAML, manual | incl. **Reality** + XTLS Vision flow; ws, gRPC, HTTP/2 and HTTPUpgrade transports |
| **Trojan** | link, Clash YAML, manual | ws, gRPC, HTTP/2 and HTTPUpgrade transports |
| **Shadowsocks** | link, Clash YAML, manual | incl. SS-2022 ciphers; `obfs-local` and `v2ray-plugin` plugins (from `ss://` links or manual entry) |
| **Hysteria2** | link, Clash YAML, manual | QUIC-based |
| **TUIC** | `tuic://`, Clash YAML, manual | v5; congestion control + UDP relay mode |
| **AnyTLS** | `anytls://`, Clash YAML, manual | requires sing-box 1.12+ |
| **ShadowTLS** | Clash YAML, manual | v1/v2/v3; wraps an inner Shadowsocks connection. Mihomo's `type: ss` with `plugin: shadow-tls` imports as ShadowTLS too |
| **WireGuard** | Clash YAML, manual | emitted as a sing-box `endpoint` (see note) |
| **OpenVPN** | `.ovpn` file | TLS mode only; needs core 1.14+. Emitted as an `openvpn-client` endpoint |

> **ShadowTLS** and **WireGuard** have no widely-agreed share-link format, so
> they're added via manual entry or a Clash/Mihomo YAML subscription rather than
> a `://` link. **OpenVPN** has none either — import the `.ovpn` profile via
> **Import → Import .ovpn File**. Sharing a WireGuard node exports it in the
> standard WireGuard config format instead (see Nodes & Subscriptions).

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
- **QR code share** — show a node's share link, a WireGuard node's config or a
  subscription URL as a QR code for a phone client to scan, or copy and save it
  (see Nodes & Subscriptions)
- Supported protocols: **VMess, VLESS (incl. Reality), Trojan, Shadowsocks,
  Hysteria2 (incl. obfs + port hopping), TUIC, AnyTLS, ShadowTLS, WireGuard,
  OpenVPN**
- **Core-version-aware config generation**, validated against the bundled binary.
  Fields added in a newer core are only emitted when the running core actually
  has them; an unknown core is treated as the oldest supported one, because
  emitting a field the core doesn't recognise stops it from starting at all
  while omitting a newer one only loses an optimisation.
- Start / stop / restart the core with live status
- **Automatic restart after a core crash** — a core that stops unexpectedly is
  restarted after 1 s, 3 s and 10 s, up to 3 times a minute, while the
  Dashboard shows *Connecting...* and the tray *Reconnecting…*. In System Proxy
  mode the system proxy stays on meanwhile, so traffic is blocked rather than
  sent direct. In TUN/Split the adapter disappears with the core, so that can't
  be guaranteed. If the restarts don't help, the app disconnects and restores
  the system proxy, and says so with a Dashboard banner and a Windows
  notification.
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
  WireGuard key that isn't 32 bytes, a missing uuid/server/port, a Shadowsocks
  plugin sing-box doesn't have or plugin options it refuses) are left out of
  the config entirely, including from the selector and urltest groups, and the
  reason is written to the log. Previously one malformed node meant every node
  stopped working, because `sing-box check` passes some configs that then abort
  at service creation. A node whose transport sing-box doesn't have, such as
  xhttp or mKCP, is left out the same way; before 1.5.0 it was quietly sent as
  plain TCP and couldn't connect. An unknown uTLS fingerprint (a link's
  `fp=none`, for example) is ignored instead: the node is kept without it, and
  a Reality node uses `chrome`.
- **No node name can stop the core either** — the app's own outbounds
  (`proxy`, `auto`, `direct`) are reserved, duplicate names are numbered (`HK`,
  `HK-1`, `HK-2`, skipping any number another node already uses), and internal
  outbounds use prefixes no node tag can take: Split-rule selectors are
  `split:<rule id>` and ShadowTLS helpers `shadowtls:<node>` (a node whose name
  starts with one of them is tagged `node-<name>`). Before 1.5.0 a node named
  `direct`, nodes `HK`, `HK`, `HK-1`, or a Split rule named like a node made
  sing-box refuse the whole config.
- **Remote and Direct DNS take effect** — Settings → DNS accepts `https://`,
  `h3://`, `tls://`, `quic://` or `udp://` servers, each with an optional port
  (and for `https://` and `h3://` a path, `/dns-query` if left out), or a bare IP
  address for plain DNS. **Remote DNS** answers every name except the
  mainland-China domains below and is reached through the proxy; **Direct DNS**
  answers those domains and is reached directly. The defaults are DoH by IP
  literal, Cloudflare `https://1.1.1.1/dns-query` and AliDNS
  `https://223.5.5.5/dns-query`, because a server given by name has to be
  looked up first, and on a network where Windows' own resolver is hijacked a
  lookup through it is exactly what fails. So a Remote DNS server given by name
  is looked up through the proxy too, by Cloudflare DoH at `1.1.1.1`, and
  Windows' resolver never sees it. A Direct DNS server given by name is looked
  up through Windows' resolver; that is the only query these settings add to
  it, and an IP address avoids it. As Remote
  DNS, `udp://`, a bare IP, `quic://` and `h3://` need a node that carries UDP;
  `https://` and `tls://` work over any node. An entry that can't be used is
  flagged under its field and the default is used until it's fixed, so a typo
  can't stop the core; the Dashboard shows the servers actually in use. They
  matter most in TUN and Split mode, where apps' own DNS queries reach them; in
  System Proxy and Manual mode most apps hand the proxy a name instead. Before
  1.5.0 both fields were ignored and these two servers were always used, so
  settings saved by an older version that still show the old defaults,
  `https://dns.google/dns-query` and `https://dns.alidns.com/dns-query`, move to
  these addresses on first launch and their DNS doesn't change.
- **Bypass mainland-China domains** — the Routing toggle sends six domain
  suffixes direct: `.cn`, `.baidu.com`, `.qq.com`, `.taobao.com`, `.jd.com` and
  `.alipay.com`. It matches no China IP ranges, so other mainland sites
  (bilibili, zhihu, weibo, …) still go through the proxy.
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
- **Switching nodes moves open connections** — picking another node (Dashboard
  or Nodes page), or another target for a Split rule, closes the connections
  that are open at that moment, so a download or a playing video continues
  through the new node after a brief interruption instead of staying on the old
  node until it ends. The automatic `auto` group doesn't do this, so its
  periodic re-pick of the fastest node never drops anything.
- UDP check and speed test travel through the **local proxy port**, which always
  follows the active selector, so testing a specific node means switching to it
  and switching back. That briefly redirects live traffic and, because a switch
  moves open connections, interrupts them at each switch, which is why those two
  are one-at-a-time and ask for confirmation before a batch run.
- **Move node to top** of the list
- New nodes are auto-selected so they appear on the Dashboard immediately
- **Auto-update subscriptions** on a configurable interval (hours)
- **Refreshing a subscription keeps your nodes and your selection** — its nodes
  are updated where they are in the list, a node keeps its identity when its
  name (or else its type, server, port and credential) is unchanged, and the
  selected node stays selected. Nodes of one subscription that share a name are
  told apart by type, server, port and credential first and by position only
  after that, so a provider that reorders them doesn't move your selection to
  another server. **Update All** updates each subscription on its own: one that
  fails, returns nothing or is disabled keeps its nodes, and each failure is
  listed. A refresh that changes nodes while connected (or connecting) shows
  **Reconnect to apply** instead of silently differing from what the core runs.
  While it shows, picking a node restarts the core with the current list instead
  of switching live, because the running core may hold a different node under
  that name; the restart applies the pending change and the banner goes away.
  **Real delay**, **UDP check** and **Speed test** are unavailable until you
  apply (TCP ping still runs), so a result can't belong to another node.
- Deleting a subscription also removes its imported nodes (with confirmation)
- **Share a node** — the **Share** button (QR icon) next to **Copy link** on a
  node's row opens a dialog with the node's name and protocol, a QR code of its
  share link for a phone client to scan, and the link itself, with **Copy link**,
  **Copy QR image** and **Save PNG**.
- **Share several nodes** — tick them and click **Share (N)** next to
  **Delete (N)**: **Copy all links** (one per line), **Copy as base64
  subscription** (the format this app's own importer, v2rayN and NekoBox read),
  **Save .txt**, and a QR code per node, paged with ← and →. Nodes that have no
  share link are listed with the reason.
- **WireGuard nodes** have no share link, so Share exports the standard
  WireGuard config instead (`[Interface]` PrivateKey, Address, MTU; `[Peer]`
  PublicKey, PresharedKey, Endpoint, AllowedIPs, PersistentKeepalive): **Copy as
  WireGuard config**, plus a QR code of it for the official WireGuard app.
  **OpenVPN** and **ShadowTLS** nodes get no QR code, and the dialog says why.
- **Share URL** on a subscription card shows the subscription URL as a QR code,
  with **Copy URL**, **Copy QR image** and **Save PNG**.
- **A share link is a credential**, and the dialog treats it as one: anyone who
  has a node's link can use that node and its traffic, and anyone who has a
  subscription URL gets every node in it. So the link, config or URL stays
  masked until you click **Show** (the copy buttons work without it), a blurred
  placeholder stands in for the QR code until **Show QR**, and a warning says
  not to screenshot it or show it while screen-sharing. None of it is written to
  the log, a tooltip or an error message.

### UI/UX
- **Light & dark themes** (plus "system") — switch in Settings
- Custom frameless title bar with the app logo
- Connection status, traffic chart, quick-switch grid
- Loading / spinner / status indicators
- **System tray**: one-click Connect/Disconnect toggle, and a mode-colored
  tray icon (blue/red/green/yellow for System/TUN/Split/Manual) so the active
  mode is visible without opening the window
- **Closing the window keeps the app running in the tray**: the title-bar ✕,
  Alt+F4 and the taskbar's "Close window" only hide it, and the connection
  stays up. To exit, use **Quit** in the tray menu.
- **One instance at a time**: launching the app again (Start menu, a shortcut
  or the `.vbs` launcher) brings the running window to the front instead of
  starting a second copy.
- **Tray "Show Window"** (or a double-click on the tray icon) reopens the
  window after you closed it.

### Split Mode (domain-based routing)
- Per-service rule sets (46+ curated presets: Reddit, Discord, Steam,
  Notion, AI providers, streaming, gaming platforms, etc.) — route each
  service through a specific node/selector via remote `.srs` rule sets
- Each rule becomes its own selector outbound; switch a rule's target
  live via the Clash API without restarting sing-box (open connections move too)
- Falls back to full-tunnel TUN capture for any traffic not matched by a rule

### sing-box Core Upgrade
- One-click "Check for Updates" / "Upgrade Core" in Settings → About & Updates
- Queries the GitHub releases API (through the running core when connected,
  otherwise directly), downloads the matching
  `sing-box-<version>-windows-amd64.zip` (with mirror fallback), replaces
  the bundled binary, and reports progress — no manual file swapping
- **Checked against GitHub's SHA-256.** The API lists a SHA-256 digest and
  the size of every release file. The zip may come from GitHub or from a
  mirror, but mirrors are only transport: whatever a source serves must match
  that digest, otherwise it is deleted and the next source is tried. If no
  source matches, or GitHub published no digest, nothing is installed.
- **Validated with sing-box 1.14.x.** A newer core (1.15 or later) is only
  installed after you confirm a "not yet validated with this app version"
  prompt, because newer cores can drop options this version still uses.
- **Tested before install.** The new binary must report the release's version
  and accept the System, TUN and Split configs this app generates from your
  nodes and settings. This uses `sing-box check` only, which never connects or
  creates a TUN adapter. If a config is rejected, nothing is installed and the
  message names the mode.
- **Installing disconnects.** Only after those checks pass does the app stop
  the core and restore the system proxy, then replace the file. Connect again
  afterwards.
- **Restore previous core.** The replaced core is kept as `sing-box.exe.bak`
  next to the new one, and Settings shows **Restore previous core** (with the
  backup's version when known). Restoring disconnects too. The backup is never
  run, only copied back.
- An app update reinstalls the core bundled with that release on purpose, and
  the backup goes away with the old install.
- When running from source, an upgrade replaces `resources\bin\sing-box.exe`
  in the working tree and keeps the `.bak` next to it (git-ignored and left out
  of builds).

### In-app app updates
- **Settings → About & Updates → Check for updates** looks for a newer Awesome
  Proxy on this repo's GitHub Releases and shows its version, release date,
  size and release notes (as plain text). Nothing is downloaded or installed
  until you click.
- **Download update** shows progress and speed. The installer is checked
  against the sha512 in the release's `latest.yml`. When possible only the
  changed blocks are downloaded (differential); otherwise the full installer.
- **Restart and install** first checks that the downloaded installer is still
  on disk. If it's gone (antivirus may have removed it), nothing is
  disconnected and the app asks you to check for updates to download it again.
  Otherwise it disconnects exactly like quitting does: it stops the core, which
  removes the TUN routes and firewall filters, and restores the Windows system
  proxy settings you had before connecting. Connect is unavailable meanwhile; if the proxy was reconnected anyway,
  the installer doesn't start and the app asks you to disconnect and try
  again. Then it installs silently and reopens the app. The app comes back
  disconnected and non-elevated, so TUN/Split ask for administrator rights
  again as usual.
- If the installer can't be started after the disconnect, the app closes
  without updating: start it again from the Start menu and download the update
  from the releases page. If the app notices the failure before it closes, it
  stays open and says the proxy was already disconnected: reconnect from the
  Dashboard, then download the update from the releases page.
- While the core is running, update traffic goes through it
  (`127.0.0.1:<mixed port>`); otherwise it goes direct. Only the updater's own
  network session is changed, never the system proxy.
- **Check for updates on startup** (on by default) checks quietly about 15 s
  after launch and only puts a dot on **Settings** when a new version is out.
- Releases up to and including **v1.4.0** have no `latest.yml`. While the
  latest release is the same as or older than the installed version, the check
  reports that you're on the latest version; in-app updates start with the
  next release. A newer release without `latest.yml` still says it doesn't
  support in-app updating yet and links the releases page. Install the first
  version with this feature by hand once; later versions update in-app.
- An app update installs the core bundled with that release on purpose. A core
  you upgraded in-app is replaced, and its `.bak` backup goes away with the old
  install; upgrade the core again afterwards if you want the newer one (see
  sing-box Core Upgrade).
- Disabled when running from source ("Updates are available in the installed
  app only") and in web mode.
- Limitations (not verified on a real machine): an **all users** install asks
  for administrator rights (UAC) when installing an update, and declining that
  prompt cancels the update and leaves the app closed (start it again from the
  Start menu). If TUN was elevated with a *different* administrator account,
  the installer would run as that account; in that setup, quit, start Awesome
  Proxy normally (not elevated) and install the update from there.

### Real traffic monitoring
- Polls sing-box's Clash API (on a random loopback port, with a per-start secret
  held by the main process in the desktop app and by the backend server in web
  mode) and derives live up/down speed from the cumulative counters (both web
  and Electron modes).

### Security
- Electron sandbox: `contextIsolation: true`, `nodeIntegration: false`
- Whitelisted preload IPC bridge — no direct Node access from the renderer
- Command-injection prevention for system-proxy commands (host/port validation)
- **SSRF protection** on URL fetching (blocks localhost / private ranges) in
  both Electron and the web backend
- Web backend bound to `127.0.0.1` only, with CORS + origin (CSRF) checks and
  WebSocket origin verification
- The renderer can't read or write files through IPC: it only gets the path you
  pick in a file dialog
- Production builds carry a Content-Security-Policy: scripts, styles and fonts
  load only from the app itself (no inline scripts), images also from `data:` /
  `blob:`, and plugins, frames and form posts are off
- New windows are denied and the window can't navigate away from the app;
  `https` links open in your default browser, anything else is dropped
- The Clash API listens on a random loopback port with a per-start secret held
  by the main process (see Real traffic monitoring)
- The Windows system proxy is restored from a snapshot taken on connect (see
  [Local and intranet addresses](#local-and-intranet-addresses))
- Core upgrades are checked against the SHA-256 GitHub publishes, stop at the
  validated version range unless you confirm, and are tested before install
  (see sing-box Core Upgrade)

---

## Running From Source

### Prerequisites
- **Node.js 18+** (developed/tested on Node 24)
- The sing-box binary at `resources/bin/sing-box.exe` (already included)

### Install
```cmd
cd /d <the project folder>
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

### Tests
```cmd
npm test                  REM fast suites, no network, starts nothing
npm run test:core         REM suites that run the bundled sing-box core
```
- `npm test` runs the `unit` project of `vitest.config.mts`: generator snapshots
  and invariants over a pairwise settings matrix, outbound-tag parity between
  the renderer and the generator, share-link round trips, Clash/Mihomo YAML
  parsing, and settings migrations against a mocked store.
- `npm run test:core` runs the `core` project. It pipes every generator case
  into `resources/bin/sing-box.exe check -c stdin`, then starts the core with
  `run` for one System and one Manual config, listening on 127.0.0.1 only
  (ports 17891 and 19191-19199, each checked free first): the Clash API must
  answer 401 without the secret and 200 with it, then the core is stopped.
  No TUN, no administrator rights, and the system proxy is never touched. If
  the binary is missing, both suites are skipped with a message saying so.
- Generator snapshots live in `tests/unit/__snapshots__/generator/`, one JSON
  file per case, byte for byte the config file the app writes. A generator
  change shows up as a failing snapshot: read the diff, and only when every
  change in it is intended, accept it with `npm test -- -u`.

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
  live in your Windows profile on each machine, not in the project folder:
  `%APPDATA%\awesome-proxy\` for the desktop app, `%APPDATA%\singbox-proxy-manager\`
  for web mode. To migrate them, copy the folder of the mode you use too (see
  Backup below), or just re-add your subscription on the new PC.

> Tip: if the target PC has no internet access to the npm registry, copy the
> `node_modules` folder along with everything else instead of reinstalling. It
> will work as long as both PCs are Windows x64.

### Option B — Build an installer (cleanest for non-developers)

On a machine that has the dependencies installed:
```cmd
npm run electron:build
```
This produces a Windows installer (NSIS), `release\Awesome-Proxy-Setup-<version>.exe`,
next to its `.blockmap` and `latest.yml` (the files the in-app updater reads
from a GitHub release). It never publishes anything and needs no GitHub token.
Copy the installer to the other PC and run it — no Node.js required on the
target machine. The sing-box binary and icons are bundled into the install.

### Publishing a release (maintainers)

The in-app updater reads this repo's GitHub Releases, so every release must
carry the installer, its `.blockmap` and `latest.yml`, with the names
electron-builder gives them.

1. Bump `version` in `package.json`.
2. Set a GitHub token in the **current shell only**, never in a file and never
   committed: a classic token with `repo` scope, or a fine-grained token with
   "Contents: read and write" on this repo.
   ```powershell
   $env:GH_TOKEN = '<token>'
   ```
3. Build and publish, then drop the token:
   ```powershell
   npm run release:publish
   Remove-Item Env:GH_TOKEN
   ```
   This creates the release `v<version>` (published, not a draft) and uploads
   `Awesome-Proxy-Setup-<version>.exe`, its `.blockmap` and `latest.yml`.

electron-builder won't upload into a release that was published more than 2
hours ago, so publish each version once. Manual alternative: run
`npm run electron:build` and upload the same three files from `release\` to a
new release tagged `v<version>`.

### Backup / migrate your data
The desktop app and web mode keep separate data, each in its own folder:
```
%APPDATA%\awesome-proxy\           desktop app (run from source or installed)
%APPDATA%\singbox-proxy-manager\   web mode (npm run server, Start Awesome Proxy.bat)
```
- **Desktop app:** `config.json` holds your nodes, subscriptions and settings,
  and `main-state.json` the Windows proxy settings the app restores on
  disconnect. Electron names the folder after the `name` field in `package.json`
  (`awesome-proxy`), and the installer's product name "Awesome Proxy" doesn't
  change that. So the app run from source and the installed app use the same
  folder and the same nodes and settings: back it up before you switch between
  versions.
- **Web mode:** `store.json` holds your nodes, subscriptions and settings.

Quit the app first (tray → **Quit**; closing the window only hides it) or, in
web mode, stop the backend. Then copy the folder to the same location on the new
PC to bring everything with you.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Tailwind CSS, Zustand, Recharts |
| Backend | Node.js, Express, WebSocket (ws) |
| QR / icons | qrcode-generator 2.0.4 (making QR codes, loaded only when the share dialog opens), jsQR (scanning), jimp + png-to-ico (build-time icon generation) |
| Proxy core | sing-box 1.14.4 (upgradeable in-app) |
| Build tool | Vite 5 |
| Desktop | Electron 31 |
| Updates | electron-updater 6.1.9 (GitHub Releases) |
| Tests | Vitest 3.2.4 (node environment), plus the bundled sing-box for the check/run suites |

---

## NPM Scripts

| Script | What it does |
|--------|--------------|
| `npm run electron:dev` | Desktop app with hot reload |
| `npm run electron:build` | Build the Windows installer (+ `.blockmap`, `latest.yml`) into `release/`; never publishes, no token needed |
| `npm run release:publish` | Build and publish a GitHub release for the in-app updater (needs `GH_TOKEN` in the shell; maintainers only) |
| `npm run server` | Start the web-mode backend (127.0.0.1:3456) |
| `npm run web:ui` | Start the Vite web UI (http://localhost:5173) |
| `npm run build` | Type-check + build renderer and Electron main |
| `npm test` | Fast test suites: generator snapshots and invariants, tag parity, share links, Clash YAML, settings migrations |
| `npm run test:core` | Test suites that run the bundled sing-box: `check` for every generator case, plus a loopback System/Manual `run` |
| `npm run icons` | Regenerate `resources/icon.png` / `icon.ico` from `logo.jpg` |

---

## File Structure

```
awesome-proxy/
├── electron/
│   ├── main.ts                  # Electron main process
│   ├── app-updater.ts           # In-app app updates (electron-updater, GitHub Releases)
│   ├── app-updater-format.ts    # Updater error messages + release notes to plain text
│   ├── core-upgrade.ts          # Core upgrade: verified download, config check, swap + restore
│   ├── core-watchdog.ts         # Restart policy for a core that stops unexpectedly
│   ├── navigation.ts            # Which URLs the window may load or open in the browser
│   └── preload.ts               # Context bridge (IPC whitelist)
├── ctrlbreak-src/
│   ├── CtrlBreak.cs              # Source for the graceful-shutdown helper
│   └── README.md                # Why it exists / how to rebuild it
├── server/
│   └── index.js                 # Web-mode Node.js backend
├── shared/
│   ├── clash-client.cjs         # Clash API port/secret + authenticated requests
│   ├── config-generator.cjs     # Shared sing-box config generator
│   ├── core-version.cjs         # Cached sing-box version probe
│   ├── node-probes.cjs          # Node tests: tcp ping / real delay / UDP / speed
│   └── system-proxy.cjs         # Windows system proxy: snapshot, restore, recovery
├── scripts/
│   └── make-icons.cjs           # Generates icon.png/icon.ico + per-mode tray tints
├── src/
│   ├── components/              # Sidebar, TitleBar, Icons, dialogs
│   │   ├── ShareDialog.tsx      # Share a node, nodes or a subscription URL: text, QR code, copy, save (loaded on demand)
│   │   └── QrCode.tsx           # Draws a QR code as one SVG path (no innerHTML)
│   ├── pages/                   # Dashboard, NodeManager, SubscriptionManager, Settings, Logs
│   ├── services/
│   │   ├── node-parser.ts       # Parse proxy links (engine-independent)
│   │   ├── subscription-fetcher.ts  # Fetch & parse subscriptions (js-yaml)
│   │   ├── qr-scanner.ts        # Decode QR codes (jsQR)
│   │   ├── qr-generator.ts      # Make QR codes for sharing (qrcode-generator), capacity checks
│   │   ├── auto-update.ts       # Subscription auto-update scheduler
│   │   ├── app-updater.ts       # App updates (not the subscription auto-update.ts)
│   │   ├── split-presets.ts     # Split-mode domain/rule-set presets
│   │   ├── node-tests.ts        # Node test orchestration (select/restore dance)
│   │   ├── connection.ts        # connect/disconnect/reconnect + live selector switching
│   │   ├── theme.ts             # Light/dark theme application
│   │   └── web-api.ts           # Web-mode API client
│   ├── store/                   # Zustand stores (nodes, settings, subscriptions, appUpdateStore, coreCrashStore)
│   ├── types/                   # TypeScript types
│   ├── App.tsx / main.tsx / index.css
├── tests/                       # Vitest suites (unit/, core/), fixtures and generator snapshots
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
├── vitest.config.mts            # Test projects: unit (npm test) and core (npm run test:core)
└── tailwind.config.js
```

---

## Notes & Limitations

- **TUN mode** requires Administrator rights on Windows (TUN/TAP routing is
  privileged). You can start the app normally and switch to TUN — it will prompt
  to relaunch elevated via UAC. System-proxy mode needs no elevation and is the
  default.
- **QR import** is image-based (file or clipboard), not a live camera scanner.
- **QR share limits.** A QR code holds at most 2,331 bytes (version 40 at
  error-correction level M), so a longer text shows the reason instead of a
  code; the copy buttons still work. Above about 1,200 characters the dialog
  notes that phones may struggle to scan such a dense code and that copying the
  text is more reliable.
- **No QR code for OpenVPN or ShadowTLS nodes**: neither has a share-link
  format. Share the `.ovpn` file an OpenVPN node came from, and a ShadowTLS node
  through a Clash/Mihomo subscription.
- **WireGuard `reserved` bytes** have no place in the standard config format. A
  node that sets them (WARP-style servers need them) is exported without them,
  with a warning, and a client may fail to connect with that config.
- **Copy QR image** puts a PNG on the clipboard. Where the clipboard won't take
  an image, the dialog says so: use **Save PNG** instead.
- **Credentials** (uuid/password) are stored in plaintext in `%APPDATA%`, same as
  nekoray. Treat the data folder as sensitive.
- The web backend is intentionally bound to `127.0.0.1`; do not expose it to a
  LAN/public interface — it can control the system proxy and the core process.
- **`cache.db`** (sing-box's Clash-API selector-state cache) is written to
  `%APPDATA%\awesome-proxy\cache.db` by the desktop app, run from source or
  installed, because the app passes the core that path. In web mode the core
  writes it to the backend's working folder: the project root when the backend
  is started from there (`npm run server` or the web launchers). It's gitignored
  on purpose — it can contain your node tags. It's never bundled into the built
  app/installer either way.

### IPv6 handling (TUN / Split)

Settings → **IPv6 Handling** controls how IPv6 is treated in TUN and Split
mode. This is a privacy setting, not only a connectivity one.

Whether the TUN interface carries an IPv6 address decides whether IPv6 traffic
**enters the tunnel at all** — it installs (or omits) the IPv6 default route.
This is independent of `dns.strategy`, which only affects domain resolution and
cannot stop a browser dialling a hardcoded IPv6 literal (Chrome's Secure DNS
providers do exactly that, e.g. Cloudflare `2606:4700:4700::1111`).

| Option | TUN | DNS to clients | Behaviour |
|---|---|---|---|
| **No IPv6 leak** (default; shown as "No IPv6 leak — IPv6 sent over IPv4") | dual-stack | `ipv4_only` | IPv6 is captured instead of escaping over your real connection, so a "what's my IP" page like ip.sb shows only your node's address. When an app reaches for an IPv6 address anyway, the request is re-sent to the site's IPv4 address through the proxy, so it still loads and works with IPv4-only nodes. Connections that can't be redirected are refused: an IPv6 literal with no hostname to look up, or a site that is genuinely IPv6-only. Both are rare, and apps fall back to IPv4. |
| **Allow IPv6** | dual-stack | `prefer_ipv4` | Apps are given IPv6 addresses, so IPv6 is available and is carried through the proxy — your real IPv6 address can't leak. Your node's server needs working IPv6 of its own; if it doesn't, IPv6 connections stall and you should use **IPv4 only** instead. IPv4 is still preferred for sites that have both. |
| **IPv4 only** | IPv4 | `ipv4_only` | The tunnel has no IPv6 address, so Windows has no IPv6 route to prefer and apps use IPv4 — which every node can carry. The catch: IPv6 isn't captured at all, so on a network with real IPv6 it goes out over your real connection and a site like ip.sb will show your actual IPv6 address (WebRTC can expose it too). Use this only if the dual-stack tunnel breaks WSL2, Docker or Hyper-V networking for you. |

> **Why DNS alone cannot keep an app on IPv4.** Withholding AAAA works only for
> apps that ask *us*. Browsers with built-in DoH — Brave, Chrome's Secure DNS,
> Firefox — resolve AAAA themselves and never send us the query. If the TUN is
> dual-stack, Windows reports working IPv6, and per RFC 6724 those apps then
> prefer IPv6 for nearly everything. On a node without IPv6 egress, carrying
> that IPv6 to the node stalls the connections, and refusing it outright resets
> them after the handshake was already accepted. Both read as "the app is
> completely broken" while the config looks perfectly fine.
>
> What makes the dual-stack default safe is a fix at routing time instead. The
> sniffer recovers the site's name from the TLS SNI or HTTP Host, a `resolve`
> rule with an explicit `ipv4_only` strategy rewrites the IPv6 destination to
> the site's IPv4 address, and the connection carries on through the proxy over
> IPv4. The real address can't leak, because the packets are already inside the
> tunnel. Only two kinds of connection reach the reject rule behind it: an IPv6
> literal with no name to look up again, and a site that is IPv6-only.

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
  every time while connected.

Since 1.5.0 the app also puts your own settings back instead of just switching
the proxy off:

- On connect it saves the four values it is about to change (`ProxyEnable`,
  `ProxyServer`, `ProxyOverride`, `AutoConfigURL`).
- Disconnect and quit restore them, but only while the system proxy is still
  the one the app set. If another program changed it in the meantime, it is
  left alone. A Manual-mode disconnect no longer touches the system proxy at all.
- If the saved proxy pointed at this machine (`127.*`, `localhost`) and nothing
  is listening there any more (another proxy tool that has since exited), it
  comes back **switched off**, so you're not left with a dead proxy.
- A proxy auto-config (PAC) script is paused while connected, because Windows
  would otherwise prefer it over the app's proxy. It comes back on disconnect.
- After a crash, a kill from Task Manager or a Windows shutdown, the next launch
  restores the saved settings before anything else.
- If the system proxy can't be set, the connection is stopped with an error
  instead of reporting "connected" while no app uses it.

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
| File access | No read/write-by-path IPC; the renderer only gets paths from the file picker |
| Content Security Policy | Injected into production builds only (`default-src 'self'`, no inline scripts, `object-src` / `frame-src` / `form-action` / `base-uri` off) |
| Navigation | `setWindowOpenHandler` denies every new window; `will-navigate` allows only the app's own URLs; `https` links go to the default browser |
| Clash API | Random loopback port and per-start secret, injected by main right before each core start; never sent to the renderer |
| System proxy | Snapshot on connect, restored on disconnect, quit and the next launch, only while the proxy is still the app's |
| Core upgrades | SHA-256 digest from the GitHub API (mirrors are transport only), validated-version ceiling, `sing-box check` of the generated configs before install |
| Data storage | Credentials stored in plaintext (same as nekoray) |
| App updates | electron-updater over HTTPS from this repo's GitHub Releases; integrity = sha512 in `latest.yml`; the renderer can't pass URLs; the releases link is hard-coded in main |

**Update trust model.** The installer is unsigned, so `publisherName` is not
set (setting it would make electron-updater reject every unsigned update) and
Authenticode verification is skipped. Protection is HTTPS to github.com plus
the sha512 in `latest.yml`, which catches corrupted or swapped downloads but
not a malicious release published from the repo itself. Keep the GitHub
account and any `GH_TOKEN` safe.

---

## References

- [sing-box Documentation](https://sing-box.sagernet.org/)
- [sing-box Migration Guide (1.12+)](https://sing-box.sagernet.org/migration/#migrate-to-new-dns-server-formats)
- [nekoray (Inspiration)](https://github.com/MatsuriDayo/nekoray)
- [sing-box GitHub](https://github.com/SagerNet/sing-box)

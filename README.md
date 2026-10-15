# MapTerm

A network topology map you work from. Start with one device and let MapTerm discover its
CDP / LLDP neighbors to build the map, then click any device to open an SSH or Telnet
terminal, record sessions, and run commands across many devices with a safety check for
configuration changes. Desktop app for macOS, Windows and Linux.

![MapTerm demo: switching maps, saving a credential set to the Keychain, discovering R1's neighbors and adding them to the map, recording an SSH session that enters enable mode by itself, then running a configuration change on the discovered devices, tested on one device first](docs/demo.gif)

*In the demo: a map with just R1. Save a credential set (its passwords go to the macOS
Keychain) and give it to R1. **Discover neighbors** on R1 finds R2 and core-sw over CDP (the IP
phone is listed but not ticked); type preferred management addresses and add them, with links
named on both ends. Discovering from R2 recognises what is already on the map and adds only the
missing link. Then open SSH to R1, which logs in and enters enable mode by itself, and record
the session; finally run a change on all three devices: MapTerm asks for confirmation, tests on
R1 first, and continues on the rest when told to.*

## Features

- **Neighbor discovery**: build the map outwards from one device. *Discover neighbors* logs in,
  reads `show cdp neighbors detail` and `show lldp neighbors detail`, and lists what it finds for
  review. Routers, switches, firewalls and access points are ticked; phones and servers are not.
  Neighbors already on the map only add their missing links. Pick a management address from the
  discovered ones or type your own, and the devices are placed around the source device and
  linked with interface names on both ends, inheriting its connection settings. A device seen
  from several neighbors is added once: MapTerm recognises devices by serial number or MAC
  address first (from `show version`, LLDP and NX-OS CDP), then by full name or address, and
  remembers what it learns, so renamed devices are still recognised. When only the name matches,
  or two devices share a name, it asks instead of guessing.
- **Topology maps**: routers, switches, layer 3 switches, firewalls, access points, servers and
  more, with links labelled by interface (`Gi0/1`, `eth0`). Parallel links are supported.
- **Several maps**: separate maps for production, lab or a planned build, switched from the
  toolbar. Duplicate a map to plan a change, or export it to a file to share or back it up
  (exports never contain passwords).
- **SSH and Telnet terminals**: click a device to open a session in a dock of tabs, one per
  device; drag tabs to reorder them. Older devices that only offer legacy SSH algorithms work,
  and Telnet is there for gear without SSH (marked "· telnet" on the map, since it is not
  encrypted). Over Telnet, MapTerm answers the login prompts from the credential set; devices
  without one (such as console-server ports) connect without a login.
- **Credential sets**: usernames with passwords or SSH keys, plus an optional enable password,
  shared by all maps. Passwords are kept in the operating system's secure store, never in
  MapTerm's files. With an enable password, MapTerm enters enable mode at a `>` prompt.
- **Session recording**: record a tab (`Ctrl+Shift+L`) to a clean text log, without colour
  codes, pagers or typos you corrected, in the map's own log folder.
- **Run commands**: run a list of commands on several devices in parallel, over SSH or Telnet,
  and save the output (one file per device or one per command) in the map's results folder.
  Commands that may change a device need a typed confirmation and can be tested on one device
  first.

### Neighbor discovery support

| Platform | CDP | LLDP |
|---|---|---|
| Cisco IOS / IOS-XE | ✓ | ✓ |
| Cisco NX-OS | ✓ | ✓ |
| Arista EOS | — | ✓ |

Other vendors that print LLDP in one of these formats work too. The review window's *What the
device returned* shows the raw output, which helps when a device formats it differently.

## How it works

1. **Add a device**: choose **Add node**, click the map, and enter its address.
2. **Give it credentials**: under **Credentials**, save a set (username, password, enable
   password) and choose it in the device's **Edit** form. Devices without a set ask when you
   connect.
3. **Discover**: click the device, **Discover neighbors**, review the list and **Add**. Repeat
   from the new devices to grow the map.
4. **Work**: click a device to open SSH or Telnet; record with the **REC** button; select
   several devices with **Run commands** to run the same commands on all of them.

## Desktop app

Download the installer for your system from the project's **Releases** page:

| OS | File |
|---|---|
| macOS (Apple Silicon / Intel) | `MapTerm-<version>-arm64.dmg` / `MapTerm-<version>.dmg` |
| Windows | `MapTerm Setup <version>.exe` |
| Linux | `MapTerm-<version>.AppImage` (make it executable, then run it) |

The installers are not yet signed with Apple or Microsoft certificates, so the first launch
shows a warning:

- **macOS:** open the app once, then go to *System Settings → Privacy & Security* and choose
  **Open Anyway** (on older macOS: right-click the app and choose **Open**).
- **Windows:** in the SmartScreen message, choose **More info → Run anyway**.

The app keeps its data in the same folder as `npm start` (see [Where data is kept](#where-data-is-kept)),
so both share the same maps and settings.

## Running from source

Requires [Node.js](https://nodejs.org) 18 or newer, on macOS, Windows or Linux.

```bash
npm install
npm start          # in your browser at http://127.0.0.1:3000
npm run app        # or as the desktop app
```

On a Linux desktop, install `zenity` (or use KDE's `kdialog`) for the folder chooser, and
`libsecret-tools` to keep passwords in the system keyring. Without them MapTerm still works:
you type folder paths, and passwords are kept until MapTerm stops.

| Setting | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `BIND` | `127.0.0.1` | Address to listen on (see [Security](#security)) |
| `MAPTERM_DATA_DIR` | see below | Where MapTerm keeps its data |

## Where data is kept

MapTerm keeps your maps and settings in a per-user folder, separate from the code:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/MapTerm` |
| Windows | `%APPDATA%\MapTerm` |
| Linux | `~/.config/mapterm` |

It contains `maps/` (one `.json` file per map: devices, links, and the map's log and results
folders), `settings.json` (credential set names, the map last opened) and, on Windows,
`secrets.dpapi.json` (encrypted passwords). Passwords themselves are stored by the operating
system:

| OS | Password store |
|---|---|
| macOS | Keychain (entries named "MapTerm: <set name>") |
| Windows | Encrypted with DPAPI for your Windows account |
| Linux | Secret Service keyring (GNOME Keyring, KWallet) via `secret-tool` |

Session recordings and command results go to folders you choose per map in the app.

## Security

MapTerm handles device passwords, so by default it only accepts connections from this
computer (`127.0.0.1`), and its API and terminal connections refuse requests from other
websites. Only set `BIND` to another address on a network you trust: MapTerm has no login of
its own, so anyone who can reach it can use your saved credentials.

Telnet sends passwords and everything else unencrypted over the network; use it only where SSH
is not available, ideally on a management network. Neighbor discovery only runs read-only
`show` commands.

## Development

```bash
npm run dev            # restart automatically when server files change
npm test               # unit and API tests (Node's built-in test runner)
npm run devices:up     # start the test devices (needs Docker)
npm run devices:down   # stop them
npm run dist:mac       # build installers into dist/ (also dist:win, dist:linux)
```

To release, push a version tag (`git tag v1.1.0 && git push --tags`). The
[Build installers](.github/workflows/release.yml) workflow runs the tests, builds the macOS,
Windows and Linux installers on GitHub and attaches them to a draft release for you to publish.

### Test devices

The test devices in [dev/test-devices](dev/test-devices) are SSH containers on `127.0.0.1`.
Ports 2221–2223 are Linux shells. `R1`, `R2` and `core-sw` imitate a Cisco IOS command line
with an enable password, configuration modes, a `--More--` pager and CDP / LLDP neighbor tables
that describe one small lab network:

| Device | Connect with | Neighbors |
|---|---|---|
| R1 | SSH `127.0.0.1:2224`, Telnet `127.0.0.1:2323` | R2, core-sw (two links), an IP phone; LLDP off |
| R2 | SSH `127.0.0.1:2225` | R1, core-sw |
| core-sw | SSH `127.0.0.1:2226` | R1 (two links), R2; a Linux server over LLDP |

Log in with `admin` / `admin`; the enable password is `cisco`. The neighbor tables report
realistic management addresses (`10.255.0.x`), so in the lab type a discovered device's
`127.0.0.1:<port>` address as its management address (as in the demo).

### Project layout

```
electron/main.js       desktop app: runs the server and shows the page in a window
build/                 app icon (icon.svg is the source of icon.png)
src/
  server/              Node.js server
    index.js           entry point (npm start)
    app.js             HTTP server: page, API, /ssh WebSocket
    config.js          port, data folder, settings
    api.js             folder routes
    maps.js            maps: one file per map, create / duplicate / import, folders per map
    terminal.js        terminal tabs, recording, runs and discovery over the /ssh WebSocket
    shell.js           one interface for SSH and Telnet sessions
    telnet.js          Telnet client (option negotiation)
    device-session.js  one device's command line: login, enable, prompts, pagers
    batch.js           "Run commands" across devices
    discovery.js       neighbor discovery on one device
    neighbors.js       CDP / LLDP output parsers
    cli.js             prompts, pagers, Telnet login and enable mode
    credentials.js     credential sets
    vault.js           OS password stores
    session-log.js     turns terminal output into clean text
    platform.js        native folder chooser, "show in file manager"
    files.js           file name and path helpers
  web/                 the page (plain ES modules, no build step)
    index.html
    css/app.css
    js/main.js         starts the modules below
    js/map.js          the map, modes, device menu
    js/maps.js         switching maps; new, duplicate, rename, export, import
    js/discover.js     "Discover neighbors": review window, adding devices and links
    js/links.js        drawing links, interface names
    js/sessions.js     terminal tabs and the dock
    js/recording.js    session recording
    js/run.js          "Run commands" and the progress panel
    js/commands.js     read-only / change / disruptive classification
    js/credentials.js, settings.js, dialog.js, icons.js, dom.js
test/                  tests (npm test); fixtures/ holds sample CDP / LLDP output
dev/test-devices/      Docker test devices and their neighbor tables
docs/                  demo GIF for this README
```

## License

Copyright 2026 Siddharth Kumar Tirkey

Licensed under the [Apache License, Version 2.0](LICENSE). You may use, modify and distribute
MapTerm, including in commercial and closed-source products, provided you keep the license and
the [NOTICE](NOTICE) file with it and state significant changes you make. The license also
grants a patent license from contributors. MapTerm is provided "as is", without warranties.

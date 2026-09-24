# System Monitor

[![VS Marketplace](https://vsmarketplacebadges.dev/version/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Rating](https://vsmarketplacebadges.dev/rating-star/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Open VSX](https://img.shields.io/open-vsx/v/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![GitHub Stars](https://img.shields.io/github/stars/lcx-0504/sysmonitor)](https://github.com/lcx-0504/sysmonitor)
[![License](https://img.shields.io/github/license/lcx-0504/sysmonitor)](LICENSE)

[中文说明](README.zh-CN.md)

A lightweight VS Code / Cursor extension for monitoring **Linux systems locally, over SSH, or inside remote windows**. Keep several servers in the sidebar, open independent Editor tabs, and put local-window metrics in the status bar where available.

![System Monitor overview](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/overview.png)

The screenshot shows the Chinese UI; the interface follows your VS Code display language.

## Monitoring

| Area | What it shows |
|------|---------------|
| **CPU and RAM** | CPU usage, 1/5/15-minute load and core count; used, available and total memory |
| **Disk** | Mount-point occupied, used, reserved and available capacity, plus read/write speed |
| **Network and SSH** | Server upload/download rates; SSH connection traffic and TCP round-trip latency |
| **GPU** | Per-card utilization, VRAM, temperature, power, model, and users of VRAM |
| **Processes** | PID, process name, user, CPU, RAM, GPU memory and command |

The performance panel has five independently hideable groups: CPU/RAM, disk, network/SSH, GPU overview, and GPU cards. Hiding a group changes only the panel layout; collection and status-bar data remain available. Background charts scroll smoothly between samples, can be turned off, and support a 1–30-minute window (5 minutes by default).

### Disk capacity

Each mount's bar shows reserved space in gray, used space in the normal threshold color, and remaining available space as the unfilled portion. The value beside the bar is `(total − available) / total`; the percentage uses the same occupied-to-total ratio, turning yellow at 70% and red at 90%. Hover over `ⓘ` for reserved, used, available and total capacities. “Reserved” is the display name for `total − used − available`; it includes space unavailable to ordinary users regardless of the filesystem's reason. In narrow panels, the info icon moves to the mount-path row.

### GPU cards

NVIDIA GPUs are detected through `nvidia-smi`. Cards can appear or disappear while the monitor runs. Model labels omit leading NVIDIA, GeForce, and Tesla prefixes. Below each VRAM bar, user labels show accumulated VRAM per user, ordered by usage and colored by their share of the card; hover over `(+N)` to see hidden users in a stacked list. You can toggle these labels, the theme-colored border marking GPUs used by your processes, and the idle-GPU picker independently. The picker selects idle cards and copies `CUDA_VISIBLE_DEVICES`.

GPU card metrics and GPU process information are committed together after both collection steps complete, so the panel and process tags use a consistent GPU result.

### Process manager

Sort the full process set by CPU, RAM or GPU usage; the table displays the top 100 results. Search by process name, PID, user or command, or use `GPU0` / `#0` to filter by card. CPU cells switch between single-core percentage (default), whole-machine percentage and both; RAM cells switch between used capacity (default), percentage and both. Combined values stay in one cell and copy together.

Process-name and command columns expand horizontally from their headers. Only PID is right-aligned. Right-click to copy a cell, a complete row or a PID; the process table stays in place while its context menu is open. Linux `ps` supplies the process CPU percentage as a lifetime average; whole-machine mode divides that value by the logical core count.

### Sidebar, Editor and status bar

In a local window, the Servers page lists aliases from your SSH config. Opening a server adds a device tab; the row can also open an independent Editor view, a floating System Monitor window, a Remote-SSH window, or an SSH terminal. The Remote-SSH menu offers a direct connection and folders from Remote-SSH's recent history. Views of the same server share one collection snapshot and chart history. Open device tabs continue collecting in the background by default. The sidebar tabs are saved per workspace, and VS Code restores Editor panels with their selected device and page. Both restoration and visible-only collection have switches in Servers settings; restoration is on by default and visible-only collection is off.

Use the native view-title actions to open the current view in an Editor tab or move it directly into a separate floating window. Pausing stops all collection in that VS Code window. The status bar belongs to the window environment: local Linux always shows its own machine, a remote Linux window shows that remote machine, and local macOS/Windows windows have no System Monitor status bar.

The status bar can show CPU, RAM, disk capacity or I/O, network and SSH rates, and a GPU summary or per-card statistics. Its visibility, side, priority and individual metrics are configurable. Capacity and speed use 1024-based K/M/G/T units with one decimal place (`/s` for speed); durations use ms, s, m and h.

## Quick Start

Install the extension from [Marketplace](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor) or [Open VSX](https://open-vsx.org/extension/LiChenxi/sysmonitor). What you see next depends on where VS Code runs the extension:

- **Local Linux:** The System Monitor sidebar opens on the fixed Local device tab. Select Servers to add Linux machines from your SSH config. The status bar stays on local Linux metrics.
- **Local macOS or Windows:** The sidebar opens directly on the Servers list, with no local-machine monitoring or System Monitor status bar. Select a Linux server to see Performance and Processes.
- **Remote Linux:** Connect through Remote-SSH, WSL or a Dev Container, and install or enable the extension in that Linux environment. The System Monitor sidebar and status-bar metrics then appear for the remote system.

The Servers list uses `remote.SSH.configFile` when set, otherwise `~/.ssh/config` (on Windows, `%USERPROFILE%\.ssh\config`). It includes explicit `Host` aliases from included config files. Connections use the system `ssh` command and must work without an interactive password, passphrase or TOTP prompt. They reuse your existing SSH configuration; no monitor service is installed on the server. The SSH card measures the monitor's own connection when the server exposes TCP counters.

To have Remote-SSH install System Monitor automatically in future remote windows, use **Auto-install** in the first-use guide on the local Servers page, or **Add to defaults** under **Settings → Servers**. This adds the extension ID to the global `remote.SSH.defaultExtensions` setting; Remote-SSH installs the published Marketplace version.

## Configuration

The built-in **Settings** panel uses switches, segmented controls and dropdowns, with immediate updates. Disk-filter presets keep their custom fields visible as disabled previews. The default refresh interval is 2 seconds; presets of 1, 2, 5 and 10 seconds and custom values from 1–30 seconds are available. Disk mount discovery runs every 10 seconds. Each collector skips a new run if its previous run is still in progress.

Default display settings show all five groups, charts, GPU user labels, current-user GPU borders and the idle-GPU picker. Charts use a 5-minute window and tabular numbers are on. By default, the status bar shows CPU, RAM and the GPU summary; network, SSH, disk and per-card GPU statistics are off.

Servers settings restore open device and Editor tabs at startup by default (`"restoreTabs": true`). All open servers keep refreshing in the background unless `"visibleOnly": true` is selected; that option is off by default. These options are global, while the opened sidebar device tabs are saved per workspace.

The built-in status-bar settings are available in every window because they are global. Local macOS and Windows windows do not display a System Monitor status bar; those settings apply when the extension runs in a local or remote Linux window.

You can also edit your VS Code **User** `settings.json`. This example **changes** the defaults to show network/SSH and GPUs used by your processes in the status bar, hide the disk group, and use a longer chart window:

```jsonc
{
  "sysmonitor.refreshInterval": 5,
  "sysmonitor.statusBar": {
    "net": "both",
    "ssh": true,
    "gpu": {
      "mode": "my"
    }
  },
  "sysmonitor.display": {
    "sparkMinutes": 10,
    "hiddenGroups": { "disk": true }
  }
}
```

Existing settings are merged with validated defaults, including settings saved by older versions. The built-in panel writes to User settings rather than workspace settings.

### GPU status bar modes

| Mode | Description |
|------|-------------|
| `"off"` | No per-card stats (default) |
| `"all"` | Show all cards |
| `"first"` | Show first N cards (`"firstN": 4`) |
| `"specify"` | Show specific cards (`"cards": [0, 1, 3]`) |
| `"my"` | Show only cards used by your processes |

### Disk filter modes

| Mode | Description |
|------|-------------|
| `"default"` | Excludes vfat, virtual FS, and common system paths |
| `"more"` | Only excludes virtual FS |
| `"all"` | Shows everything including virtual FS |
| `"custom"` | Configure FS type exclusions, path prefix exclusions, and virtual FS visibility |

## Requirements

- Linux (remote or local)
- `nvidia-smi` for NVIDIA GPU monitoring
- `ss` for SSH traffic and latency on Remote-SSH connections

## Contributors

<a href="https://github.com/lcx-0504" title="Author"><img src="https://github.com/lcx-0504.png" width="50" style="border-radius:50%" alt="lcx-0504"/></a>
<a href="https://github.com/klay7w" title="Helped fix GPU refresh stability"><img src="https://github.com/klay7w.png" width="50" style="border-radius:50%" alt="klay7w"/></a>

## License

[MIT](LICENSE)

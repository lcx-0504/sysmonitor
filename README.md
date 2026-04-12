# System Monitor

[![VS Marketplace](https://vsmarketplacebadges.dev/version/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Rating](https://vsmarketplacebadges.dev/rating-star/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Open VSX](https://img.shields.io/open-vsx/v/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![GitHub Stars](https://img.shields.io/github/stars/lcx-0504/sysmonitor)](https://github.com/lcx-0504/sysmonitor)
[![License](https://img.shields.io/github/license/lcx-0504/sysmonitor)](LICENSE)

[中文说明](README.zh-CN.md)

A lightweight VS Code / Cursor extension for monitoring system resources on **remote Linux** (Remote-SSH, WSL, Dev Containers, etc.).

![Performance Tab](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/perf.png)

## Features

| Category | Details |
|----------|---------|
| **CPU** | Usage %, 1/5/15 min load, core count, sparkline chart |
| **RAM** | Used / Available / Total, sparkline chart |
| **Disk** | Mount points with progress bars, configurable filters (default / more / all / custom) |
| **Network** | Upload & download speed, sparkline charts |
| **SSH Traffic** | Upload & download through your SSH connection |
| **GPU** | NVIDIA utilization, VRAM, temperature, power draw (multi-GPU) |
| **GPU Picker** | Select idle GPUs, copy `CUDA_VISIBLE_DEVICES` with one click |
| **Process Manager** | Sort by CPU / RAM / GPU, searchable, right-click to copy cell or row |
| **Status Bar** | Customizable position, priority, and displayed metrics |
| **Settings** | Built-in settings panel with live preview — no JSON editing needed |
| **i18n** | Chinese & English, auto-detected |

### Process Manager

![Process Manager](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/procs.png)

- Sort by **CPU**, **RAM**, or **GPU** usage
- Search by process name, PID, user, or command (`GPU0` / `#0` syntax to filter by GPU card)
- Right-click context menu: **Copy Cell** / **Copy Row** (full command included)

### Settings Panel

![Settings](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/settings.png)

- **Refresh Interval** — 1s / 2s / 5s / 10s
- **Status Bar** — Toggle visibility, position (left/right), priority, choose which metrics to display
- **Disk Filter** — Default / More / All / Custom (exclude FS types, path prefixes, virtual FS)
- **Display** — Enable/disable sparkline charts, chart duration (1–30 min)

## Quick Start

1. Install the extension from [Marketplace](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor) or [Open VSX](https://open-vsx.org/extension/LiChenxi/sysmonitor)
2. Open a **remote** workspace: **Remote-SSH**, **WSL**, or a **Dev Container** on **Linux**
3. The sidebar icon and status bar metrics appear automatically

> **Note**: The extension runs in the remote extension host, not on your local OS. The activity bar icon only appears in remote windows. The remote machine must run **Linux**.

### First launch (Remote-SSH)

When you open a local window, the extension offers to add itself to `remote.SSH.defaultExtensions` so it auto-installs on every server you connect to.

## Configuration

All settings are accessible via the **Settings** button in the sidebar panel. You can also edit `settings.json` directly:

```jsonc
{
  "sysmonitor.refreshInterval": 2,
  "sysmonitor.statusBar": {
    "barEnabled": true,
    "alignment": "left",
    "priority": 10,
    "cpu": true,
    "ram": true,
    "net": "both",
    "ssh": true,
    "gpu": {
      "summary": true,
      "mode": "all",
      "metric": "both",
      "skipIdle": false
    }
  },
  "sysmonitor.disk": {
    "mountFilter": "default",
    "hideParentMounts": true
  }
}
```

### GPU status bar modes

| Mode | Description |
|------|-------------|
| `"off"` | No per-card stats |
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

- Linux remote server
- NVIDIA GPU monitoring requires `nvidia-smi`
- SSH traffic monitoring requires `ss`

## License

[MIT](LICENSE)

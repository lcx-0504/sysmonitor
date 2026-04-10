# System Monitor

[中文说明](README.zh-CN.md)

A lightweight VS Code / Cursor extension for monitoring system resources on **remote Linux** (Remote-SSH, WSL, Dev Containers, etc.).

## Features

- **CPU** — Usage percentage, 1/5/15 min load averages
- **RAM** — Used / Available / Total
- **Network** — Upload & download speed
- **SSH Traffic** — Upload & download through your SSH connection
- **GPU** — NVIDIA GPU utilization, VRAM, temperature, power (multi-GPU)
- **Free GPU Picker** — Select idle GPUs and copy `CUDA_VISIBLE_DEVICES`
- **Process Manager** — Sortable by CPU / RAM / GPU, searchable (supports `GPU0` / `#0` syntax)
- **Status Bar** — Configurable pinned metrics
- **Settings** — Built-in settings panel, no need to edit JSON
- **i18n** — Chinese & English, auto-detected

## Quick Start

1. Install the extension (from Marketplace or `.vsix`)
2. (Optional, Remote-SSH only) When prompted in a local window, add the extension ID to `remote.SSH.defaultExtensions`
3. Open a **remote** workspace: Remote-SSH, **WSL**, or a **Dev Container** on **Linux**
4. The sidebar and status bar appear when the extension runs on Linux

> The extension runs in the **remote** extension host, not on your local OS. It only collects metrics when the remote OS is **Linux**.
> The activity bar icon appears **only** in a **remote** window (WSL, Dev Containers, SSH, etc.), not in a pure local window.
> The remote machine must run **Linux**; Windows or macOS remotes show an unsupported message.

## Configuration

All settings are accessible via the **Settings** button in the sidebar panel. You can also edit `settings.json` directly:

```jsonc
{
  "sysmonitor.refreshInterval": 2,
  "sysmonitor.statusBar": {
    "barEnabled": true,
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
  }
}
```

### GPU display modes

- `"mode": "off"` — no per-card stats in status bar
- `"mode": "all"` — show all cards
- `"mode": "first"` + `"firstN": 4` — show first N cards
- `"mode": "specify"` + `"cards": [0, 1, 3]` — show specific cards
- `"mode": "my"` — show only cards used by your processes

### Hide status bar

Set `"barEnabled": false` to hide the status bar while keeping the sidebar panel available.

## Requirements

- Linux remote server (connects via VS Code Remote-SSH)
- NVIDIA GPU monitoring requires `nvidia-smi`
- SSH traffic monitoring requires `ss`

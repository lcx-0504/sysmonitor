# System Monitor — 系统监控

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/LiChenxi.sysmonitor)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/LiChenxi.sysmonitor)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/LiChenxi.sysmonitor)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Open VSX](https://img.shields.io/open-vsx/v/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![GitHub Stars](https://img.shields.io/github/stars/lcx-0504/sysmonitor)](https://github.com/lcx-0504/sysmonitor)
[![License](https://img.shields.io/github/license/lcx-0504/sysmonitor)](LICENSE)

轻量级 VS Code / Cursor 扩展，在 **远程 Linux**（Remote-SSH、WSL、Dev Container 等）上监控系统资源。

![性能面板](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/perf.png)

## 功能

| 类别 | 详情 |
|------|------|
| **CPU** | 使用率、1/5/15 分钟负载均值、核心数、迷你折线图 |
| **内存** | 已用 / 可用 / 总计、迷你折线图 |
| **磁盘** | 挂载点进度条，可配置过滤（默认 / 更多 / 全部 / 自定义） |
| **网络** | 服务器上传下载速率、迷你折线图 |
| **SSH 流量** | 你的 SSH 连接的上传下载 |
| **GPU** | NVIDIA 利用率、显存、温度、功耗（多卡支持） |
| **空闲 GPU 选择器** | 选取空闲卡，一键复制 `CUDA_VISIBLE_DEVICES` |
| **进程管理器** | CPU / 内存 / GPU 排序，搜索，右键复制单元格或整行 |
| **状态栏** | 可配置位置、优先级和显示指标 |
| **设置** | 内置设置面板，实时预览，无需编辑 JSON |
| **国际化** | 中文 / 英文自动识别 |

### 进程管理器

![进程管理器](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/procs.png)

- 按 **CPU**、**内存** 或 **GPU** 排序
- 搜索进程名、PID、用户或命令（`GPU0` / `#0` 语法按卡筛选）
- 右键菜单：**复制单元格** / **复制整行**（命令列完整复制）

### 设置面板

![设置](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/settings.png)

- **刷新间隔** — 1秒 / 2秒 / 5秒 / 10秒
- **状态栏** — 开关、位置（左/右）、优先级、选择显示指标
- **磁盘过滤** — 默认 / 更多 / 全部 / 自定义（排除 FS 类型、路径前缀、虚拟文件系统）
- **显示** — 开关迷你折线图，图表时长（1–30 分钟）

## 快速开始

1. 从 [Marketplace](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor) 或 [Open VSX](https://open-vsx.org/extension/LiChenxi/sysmonitor) 安装扩展
2. 打开**远程**工作区：**Remote-SSH**、**WSL** 或 **Linux 上的 Dev Container**
3. 侧边栏图标和状态栏指标自动出现

> **注意**：扩展在远程扩展主机中运行，不在本机采集数据。活动栏图标仅在远程窗口中出现。远程系统必须是 **Linux**。

### 首次启动（Remote-SSH）

在本地窗口首次打开时，扩展会提示将自身添加到 `remote.SSH.defaultExtensions`，这样每次连接服务器都会自动安装。

## 配置

所有设置都可通过侧边栏的**设置**按钮操作，也可直接编辑 `settings.json`：

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

### GPU 状态栏模式

| 模式 | 说明 |
|------|------|
| `"off"` | 不显示单卡信息 |
| `"all"` | 显示所有卡 |
| `"first"` | 显示前 N 张卡（`"firstN": 4`） |
| `"specify"` | 显示指定卡（`"cards": [0, 1, 3]`） |
| `"my"` | 仅显示你的进程正在使用的卡 |

### 磁盘过滤模式

| 模式 | 说明 |
|------|------|
| `"default"` | 排除 vfat、虚拟文件系统和常见系统路径 |
| `"more"` | 仅排除虚拟文件系统 |
| `"all"` | 显示全部（含虚拟文件系统） |
| `"custom"` | 自定义排除 FS 类型、路径前缀和虚拟 FS |

## 依赖

- Linux 远程服务器
- NVIDIA GPU 监控需要 `nvidia-smi`
- SSH 流量监控需要 `ss`

## 许可

[MIT](LICENSE)

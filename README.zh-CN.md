# System Monitor — 系统监控

轻量级 VS Code / Cursor 扩展，在 **远程 Linux**（Remote-SSH、WSL、Dev Container 等）上监控系统资源。

## 功能

- **CPU** — 使用率、1/5/15 分钟负载均值
- **内存** — 已用 / 可用 / 总计
- **网络** — 服务器上传下载速率
- **SSH 流量** — 你的 SSH 连接的上传下载
- **GPU** — NVIDIA GPU 利用率、显存、温度、功耗（多卡支持）
- **空闲 GPU 选择器** — 选取空闲卡并一键复制 `CUDA_VISIBLE_DEVICES`
- **进程管理器** — 按 CPU / 内存 / GPU 排序，支持搜索（可用 `GPU0`、`#0` 语法按卡筛选）
- **状态栏** — 可配置的固定指标
- **设置** — 内置设置面板，无需手动编辑 JSON
- **国际化** — 自动识别中文 / 英文

## 快速开始

1. 安装扩展（从 Marketplace 或 `.vsix`）
2.（可选，仅 Remote-SSH）在本地窗口按提示将扩展 ID 写入 `remote.SSH.defaultExtensions`
3. 打开**远程**工作区：**Remote-SSH**、**WSL** 或 **Linux 上的 Dev Container**
4. 扩展在远程 **Linux** 上运行时，侧边栏与状态栏才会工作

> 扩展在**远程扩展主机**中运行，不在本机采集数据；仅当远程系统为 **Linux** 时提供完整功能。
> 活动栏图标**仅**在远程窗口中出现（WSL、容器、SSH 等），纯本地窗口不显示。
> 远程系统必须是 **Linux**；若远程为 Windows / macOS，会提示不支持。

## 配置

所有设置都可以通过侧边栏的**设置**按钮操作，也可以直接编辑 `settings.json`：

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

### GPU 显示模式

- `"mode": "off"` — 状态栏不显示单卡信息
- `"mode": "all"` — 显示所有卡
- `"mode": "first"` + `"firstN": 4` — 显示前 N 张卡
- `"mode": "specify"` + `"cards": [0, 1, 3]` — 显示指定卡
- `"mode": "my"` — 仅显示你的进程正在使用的卡

### 隐藏状态栏

设置 `"barEnabled": false` 可隐藏状态栏，但侧边栏面板仍然可用。

## 依赖

- Linux 远程服务器（通过 VS Code Remote-SSH 连接）
- NVIDIA GPU 监控需要 `nvidia-smi`
- SSH 流量监控需要 `ss`

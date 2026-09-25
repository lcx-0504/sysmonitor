# System Monitor — 系统监控

[![VS Marketplace](https://vsmarketplacebadges.dev/version/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Rating](https://vsmarketplacebadges.dev/rating-star/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Open VSX](https://img.shields.io/open-vsx/v/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![GitHub Stars](https://img.shields.io/github/stars/lcx-0504/sysmonitor)](https://github.com/lcx-0504/sysmonitor)
[![License](https://img.shields.io/github/license/lcx-0504/sysmonitor)](LICENSE)

轻量级 VS Code / Cursor 扩展，可在**本机、SSH 连接或远程窗口**中监控 Linux 系统。侧边栏可切换多台服务器，Editor 可分别打开监控视图；适用的窗口也可在状态栏显示常用指标。

![系统监控总览](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/overview.png)

## 监控内容

| 区域 | 显示内容 |
|------|----------|
| **CPU 与内存** | CPU 使用率、1/5/15 分钟负载与核心数；内存已用、可用及总量 |
| **磁盘** | 挂载点不可用量、已用量、预留量、可用量及读写速率 |
| **网络与 SSH** | 服务器上传／下载速率；SSH 连接流量与 TCP 往返延迟 |
| **GPU** | 单卡利用率、显存、温度、功耗、型号及显存占用用户 |
| **进程** | PID、进程名、用户、CPU、内存、GPU 显存及命令 |

性能面板分为 CPU＋内存、磁盘、网络／SSH、GPU 总览、GPU 卡片五组，可分别隐藏。隐藏只改变面板布局，采集和状态栏仍可使用这些数据。背景图表在两次采样之间匀速滚动，可关闭；时间窗口为 1–30 分钟，默认 5 分钟。

### 磁盘容量

每个挂载点的进度条从左到右依次为灰色的「预留」、按现有阈值着色的「已用」、未填充的「可用」。条子旁显示「（总计 − 可用）/ 总计」，百分比采用相同口径，达到 70% 变黄、90% 变红。悬停 `ⓘ` 可查看预留、已用、可用、总计四项容量。「预留」在界面中表示「总计 − 已用 − 可用」，不区分文件系统使这部分空间不可供普通用户使用的具体原因；面板较窄时，提示图标会移到挂载路径那一行。

### GPU 卡片

目前通过 `nvidia-smi` 监控 NVIDIA GPU，运行中卡数变化也会更新面板。型号名称去掉开头的 NVIDIA、GeForce、Tesla 前缀。显存进度条下方按占用量排列用户标签，显示该用户在这张卡上的累计显存，并按占总显存比例着色；空间不够时可悬停 `(+N)` 查看堆叠的隐藏用户。用户标签、当前用户所用 GPU 的主题色边框，以及空闲 GPU 选择器均可独立开关。选择器可勾选空闲卡，一键复制 `CUDA_VISIBLE_DEVICES`。

GPU 卡片数据与 GPU 进程信息会等两步采集都完成后一起更新，卡片和进程标签使用同一份结果。

### 进程管理器

可按 CPU、内存或 GPU 对完整进程集排序，列表显示前 100 条。支持按进程名、PID、用户或命令搜索，也可输入 `GPU0`／`#0` 按卡筛选。CPU 单元格可切换单核占比（默认）、整机占比或同格双值；内存可切换占用量（默认）、占比或同格双值，双值复制时仍在同一单元格。

进程名与命令列可从表头横向展开；只有 PID 列右对齐。右键可复制单元格、完整行或 PID；菜单打开期间进程表格会保持位置不变。进程 CPU 使用 Linux `ps` 的运行至今平均占用口径，整机占比由单核值除以逻辑核心数得到。

### 侧边栏、Editor 与状态栏

本地窗口的「服务器」页列出 SSH 配置中的别名。点「打开」会新增侧栏设备标签；列表行的 Editor、新窗口操作会另开单设备视图，不改变侧栏标签。远程窗口菜单提供直接连接和最近打开的远程文件夹，目录记录由 Remote-SSH 提供。每个 Editor 只显示「性能／进程」，由 VS Code 原生标签管理，标签名使用 SSH 别名。同一服务器的多个视图共用一套采集快照与图表历史，默认在标签处于后台时继续采集。侧栏设备标签按工作区保存，Editor 随 VS Code 恢复其设备和页面。「启动时恢复上次的标签页」默认开启，「仅刷新可见面板」默认关闭，两项均可在「服务器」设置组中调整。编辑器视图、新窗口、SSH 终端和远程窗口操作按钮可在「操作按钮」设置组中分别显示或隐藏，列表的「打开」按钮始终保留。

侧栏标题栏的原生按钮会把当前 SSH 设备标签移入 Editor 或新窗口；本地 Linux 固定的「本机」标签则保留在侧栏，打开的是副本。选中 SSH 设备时，标题栏还可打开 SSH 终端或远程窗口；进入「服务器」列表页时隐藏这些设备操作。当前激活的监控 Editor 可在标题栏放回侧栏或移到新窗口；SSH Editor 另有终端和远程窗口操作。SSH 终端按钮直接打开交互式终端，远程窗口的连接由 VS Code 的 Remote-SSH 处理。远程 Linux 窗口的当前机器也始终留在侧栏，弹出时创建副本。暂停会停止当前 VS Code 窗口的所有采集；断线提示中的「重试」可临时为该服务器采集一次，随后继续暂停。状态栏归属固定：本地 Linux 窗口显示本机，远程 Linux 窗口显示当前远程机器；本地 macOS／Windows 窗口不显示 System Monitor 状态栏。

状态栏可显示 CPU、内存、磁盘容量或读写速率、网络及 SSH 速率，以及 GPU 总览或单卡指标；显示开关、位置、优先级和各项内容均可配置。容量和速度按 1024 进位为 K/M/G/T，保留一位小数，速度附加 `/s`；时长按 ms、s、m、h 显示。

## 快速开始

从 [Marketplace](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor) 或 [Open VSX](https://open-vsx.org/extension/LiChenxi/sysmonitor) 安装扩展。安装后的表现取决于扩展运行的位置：

- **本地 Linux：** 侧边栏默认打开固定的「本机」设备标签；进入「服务器」页可添加 SSH 配置中的 Linux 机器。状态栏始终显示本机指标。
- **本地 macOS 或 Windows：** 侧边栏直接显示服务器列表，不采集当前电脑，也不显示 System Monitor 状态栏。选择 Linux 服务器后显示「性能」和「进程」。
- **远程 Linux：** 通过 Remote-SSH、WSL 或 Dev Container 连接 Linux 环境，并在该环境安装或启用扩展，随后就会显示对应服务器的监控侧边栏和状态栏指标。

服务器列表优先读取 `remote.SSH.configFile`，否则读取 `~/.ssh/config`（Windows 为 `%USERPROFILE%\.ssh\config`），并包含 `Include` 文件中的明确 `Host` 别名。连接使用系统 `ssh` 命令，需要能够免交互输入密码、私钥口令或 TOTP 直接连接；扩展沿用现有 SSH 配置，不在服务器上安装监控服务。服务器提供 TCP 计数器时，SSH 卡片显示这条监控连接自身的流量与延迟。

如需在 Remote-SSH 远程窗口中自动安装 System Monitor，可在本地「服务器」页的首次使用提示或「设置 → 服务器」中点击「加入默认扩展」。这会把扩展 ID 加入全局 `remote.SSH.defaultExtensions`；Remote-SSH 安装的是扩展市场已发布的版本。

## 配置

内置**设置**面板使用开关、分段选择和下拉菜单，修改后即时生效；磁盘过滤预设会以禁用状态展示对应的自定义字段，方便对照。默认刷新间隔为 2 秒，可选 1、2、5、10 秒快捷值或自定义 1–30 秒。磁盘挂载信息固定每 10 秒采集一次；各采集器在上一次尚未完成时会跳过本轮。

默认显示全部五组、背景图表、GPU 占用用户标签、当前用户 GPU 标记和空闲 GPU 选择器。图表窗口为 5 分钟，等宽数字开启。状态栏默认显示 CPU、内存和 GPU 总览；网络、SSH、磁盘及单卡 GPU 信息默认关闭。

「服务器」设置默认在启动时恢复已打开的设备与 Editor 标签（`"restoreTabs": true`），同时让已打开的服务器持续后台采集；如需仅采集当前可见的设备，可开启 `"visibleOnly": true`。两项是全局设置，侧边栏打开的设备标签则按工作区保存。

内置状态栏设置在所有窗口都可编辑，因为它属于全局配置。本地 macOS／Windows 窗口不显示 System Monitor 状态栏；该配置在本地或远程 Linux 窗口生效。

也可直接编辑 VS Code 的**用户** `settings.json`。以下示例是在默认值之外，打开状态栏网络／SSH 和“我的 GPU”、隐藏磁盘分组，并延长图表窗口：

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

已有配置会与经过校验的默认值合并，旧版本保存的配置也可继续使用。内置面板会写入用户设置，不会写入工作区设置。

### GPU 状态栏模式

| 模式 | 说明 |
|------|------|
| `"off"` | 不显示单卡信息（默认） |
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

- Linux（远程或本地）
- NVIDIA GPU 监控需要 `nvidia-smi`
- Remote-SSH 的 SSH 流量和延迟监控需要 `ss`

## 贡献者

<a href="https://github.com/lcx-0504" title="作者"><img src="https://github.com/lcx-0504.png" width="50" style="border-radius:50%" alt="lcx-0504"/></a>
<a href="https://github.com/klay7w" title="协助修复 GPU 刷新稳定性"><img src="https://github.com/klay7w.png" width="50" style="border-radius:50%" alt="klay7w"/></a>

## 许可

[MIT](LICENSE)

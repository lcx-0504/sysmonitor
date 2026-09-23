# System Monitor — 系统监控

[![VS Marketplace](https://vsmarketplacebadges.dev/version/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Rating](https://vsmarketplacebadges.dev/rating-star/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Open VSX](https://img.shields.io/open-vsx/v/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![GitHub Stars](https://img.shields.io/github/stars/lcx-0504/sysmonitor)](https://github.com/lcx-0504/sysmonitor)
[![License](https://img.shields.io/github/license/lcx-0504/sysmonitor)](LICENSE)

轻量级 VS Code / Cursor 扩展，监控**远程或本地 Linux** 的系统资源。可以放在侧边栏、同时打开多个 Editor 标签页，也能把常用指标放进状态栏。

![系统监控总览](https://raw.githubusercontent.com/lcx-0504/sysmonitor/main/screenshots/overview.png)

## 监控内容

| 区域 | 显示内容 |
|------|----------|
| **CPU 与内存** | CPU 使用率、1/5/15 分钟负载与核心数；内存已用、可用及总量 |
| **磁盘** | 挂载点容量与使用率、读写速率 |
| **网络与 SSH** | 服务器上传／下载速率；SSH 连接流量与 TCP 往返延迟 |
| **GPU** | 单卡利用率、显存、温度、功耗、型号及显存占用用户 |
| **进程** | PID、进程名、用户、CPU、内存、GPU 显存及命令 |

性能面板分为 CPU＋内存、磁盘、网络／SSH、GPU 总览、GPU 卡片五组，可分别隐藏。隐藏只改变面板布局，采集和状态栏仍可使用这些数据。背景图表在两次采样之间匀速滚动，可关闭；时间窗口为 1–30 分钟，默认 5 分钟。

### GPU 卡片

目前通过 `nvidia-smi` 监控 NVIDIA GPU，运行中卡数变化也会更新面板。型号名称去掉开头的 NVIDIA、GeForce、Tesla 前缀。显存进度条下方按占用量排列用户标签，显示该用户在这张卡上的累计显存，并按占总显存比例着色；空间不够时以 `(+N)` 表示剩余人数。用户标签、当前用户所用 GPU 的主题色边框，以及空闲 GPU 选择器均可独立开关。选择器可勾选空闲卡，一键复制 `CUDA_VISIBLE_DEVICES`。

GPU 卡片数据与 GPU 进程信息会等两步采集都完成后一起更新，卡片和进程标签使用同一份结果。

### 进程管理器

可按 CPU、内存或 GPU 对完整进程集排序，列表显示前 100 条。支持按进程名、PID、用户或命令搜索，也可输入 `GPU0`／`#0` 按卡筛选。CPU 单元格可切换单核占比（默认）、整机占比或同格双值；内存可切换占用量（默认）、占比或同格双值，双值复制时仍在同一单元格。这两项显示偏好会在侧边栏与 Editor 标签页之间同步。

进程名与命令列可从表头横向展开；只有 PID 列右对齐。右键可复制单元格、完整行或 PID；菜单打开期间进程表格会保持位置不变。进程 CPU 使用 Linux `ps` 的运行至今平均占用口径，整机占比由单核值除以逻辑核心数得到。

### 侧边栏、Editor 与状态栏

点击视图标题栏中的原生按钮可打开多个 Editor 标签页。它们共用同一套采集和快照，但各自保留图表历史、进程筛选等临时界面状态。暂停会同时停止面板和状态栏的数据采集。

状态栏可显示 CPU、内存、磁盘容量或读写速率、网络及 SSH 速率，以及 GPU 总览或单卡指标；显示开关、位置、优先级和各项内容均可配置。容量和速度按 1024 进位为 K/M/G/T，保留一位小数，速度附加 `/s`；时长按 ms、s、m、h 显示。

## 快速开始

从 [Marketplace](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor) 或 [Open VSX](https://open-vsx.org/extension/LiChenxi/sysmonitor) 安装扩展。安装后的表现取决于扩展运行的位置：

- **本地 Linux：** 侧边栏显示 System Monitor，状态栏指标开始更新。
- **本地 macOS 或 Windows：** 本机不会出现监控面板。扩展可能弹出一条可选通知，询问是否加入 `remote.SSH.defaultExtensions`，以便以后连接 Remote-SSH 服务器时自动安装；这不会在当前电脑上开始监控。
- **远程 Linux：** 通过 Remote-SSH、WSL 或 Dev Container 连接 Linux 环境，并在该环境安装或启用扩展，随后就会显示对应服务器的监控侧边栏和状态栏指标。

从侧边栏打开 **System Monitor** 即可查看完整面板。无论本地还是远程，指标都由 Linux 扩展主机采集。

## 配置

内置**设置**面板使用开关、分段选择和下拉菜单，修改后即时生效；磁盘过滤预设会以禁用状态展示对应的自定义字段，方便对照。默认刷新间隔为 2 秒，可选 1、2、5、10 秒快捷值或自定义 1–30 秒。磁盘挂载信息固定每 10 秒采集一次；各采集器在上一次尚未完成时会跳过本轮。

默认显示全部五组、背景图表、GPU 占用用户标签、当前用户 GPU 标记和空闲 GPU 选择器。图表窗口为 5 分钟，等宽数字开启。状态栏默认显示 CPU、内存和 GPU 总览；网络、SSH、磁盘及单卡 GPU 信息默认关闭。

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

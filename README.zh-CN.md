# System Monitor — 系统监控

[![VS Marketplace](https://vsmarketplacebadges.dev/version/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Rating](https://vsmarketplacebadges.dev/rating-star/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Open VSX](https://img.shields.io/open-vsx/v/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![GitHub Stars](https://img.shields.io/github/stars/lcx-0504/sysmonitor)](https://github.com/lcx-0504/sysmonitor)
[![License](https://img.shields.io/github/license/lcx-0504/sysmonitor)](LICENSE)

[English](README.md)

在 VS Code 或 Cursor 中查看 Linux 服务器的资源占用、查找高负载进程、了解 GPU 使用情况，也可以同时打开多台服务器的监控视图。

支持 Linux 本机监控、从 macOS／Windows 本地窗口通过 SSH 监控服务器，以及在 Remote-SSH、WSL、Dev Container 的 Linux 环境中使用。

从本地窗口通过 SSH 同时监控多台服务器，可将监控视图放在侧栏、编辑器或独立窗口中。

![本地窗口通过 SSH 监控多台服务器](screenshots/local-ssh.png)

在 Remote-SSH 窗口中查看当前连接的服务器。

![Remote-SSH 窗口中的系统监控](screenshots/overview.png)

界面跟随 VS Code 的显示语言。

## 快速开始

从 [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor) 或 [Open VSX](https://open-vsx.org/extension/LiChenxi/sysmonitor) 安装 **System Monitor**，然后打开「系统监控」视图。

| 运行环境 | 使用方式 |
|---|---|
| 本地 Linux | 直接查看本机；进入「服务器」页，还可以打开 SSH 配置中的其他 Linux 服务器。 |
| 本地 macOS 或 Windows | 在「服务器」页选择 Linux 主机。暂不支持监控当前 macOS 或 Windows 电脑。 |
| Remote-SSH、WSL 或 Dev Container 中的 Linux | 在对应远程环境中安装或启用扩展，查看扩展所在机器的状态。 |

### 从本地窗口连接服务器

服务器列表读取 SSH 配置中的主机别名，优先使用 VS Code 的 `remote.SSH.configFile`，否则读取 `~/.ssh/config`（Windows 为 `%USERPROFILE%\.ssh\config`），也支持通过 `Include` 引入的配置文件。

后台采集需要本地有可用的 `ssh` 命令，并能够以非交互方式完成认证，即无需临时输入密码、私钥口令或验证码。可以使用 SSH 密钥、SSH agent（密钥代理）或已经完成认证的可复用连接。将下面的 `your-server` 替换为主机别名，可验证连接是否满足要求：

```sh
ssh -T -o BatchMode=yes your-server true
```

验证通过后，在「服务器」页选择主机并点击「打开」。需要交互式登录时，可以使用 SSH 终端快捷按钮。

如需在新建 Remote-SSH 窗口时自动安装本扩展，可在「设置 → 服务器」中点击「加入默认扩展」。Remote-SSH 会安装扩展市场上的已发布版本。

## 主要功能

### 查看资源与近期趋势

「性能」页展示 CPU 使用率与负载、内存、磁盘容量与读写、网络速率，以及 GPU 状态。背景图表用于观察近期变化，可在设置中选择显示的监控分组或关闭图表。

将鼠标悬停在磁盘信息图标上，可查看已用、预留和可用空间。通过磁盘过滤设置，可选择要显示的挂载点，包括网络存储。

### 查找占用资源的进程

「进程」页支持按 CPU、内存或 GPU 占用排序，也可以按进程名、PID、用户或命令搜索。输入 `GPU0` 或 `#0` 可筛选指定 GPU 上的进程，列表最多显示 100 条匹配结果。

展开命令列可查看进程的启动命令，右键可复制 PID、单元格或整行。CPU 可按单核或整机占比显示，内存可显示占用量或占比。

### GPU 使用情况与空闲 GPU 选择

对于 NVIDIA GPU，可查看利用率、显存、温度、功耗，以及各用户的显存占用。支持高亮当前用户正在使用的 GPU，并为选定的空闲 GPU 生成可复制的 `CUDA_VISIBLE_DEVICES` 设置。

GPU 监控需要被监控机器上有可用的 `nvidia-smi`。没有 NVIDIA GPU 的机器仍然可以使用其他系统监控功能。

### 多服务器与多窗口

支持侧栏设备标签、编辑器标签页和独立监控窗口。同一台服务器的多个视图共享监控数据，可通过顶栏按钮调整视图位置。

「打开 SSH 终端」用于进入命令行会话；「打开远程窗口」则通过 VS Code 的 Remote-SSH 打开开发工作区。在「设置 → 操作按钮」中，可以选择直接打开新工作区、最近工作区，或每次通过菜单选择。选择最近工作区但没有历史记录时，会打开空的远程窗口。

在本地或远程 Linux 环境中，还可以把常用指标放到状态栏。状态栏始终显示扩展所在的 Linux 机器；本地 macOS／Windows 窗口不显示本扩展的状态栏指标。

## 常用设置

点击监控视图中的「设置」即可调整。修改会保存到 VS Code 用户设置，并即时生效。

| 设置 | 用途 |
|---|---|
| 刷新间隔 | 默认 2 秒。服务器繁忙或网络较慢时，可增大间隔，降低采集频率。 |
| 显示与图表 | 选择显示哪些分组、图表的时间范围，以及是否显示 GPU 占用用户。 |
| 状态栏 | 选择常用指标，也可以只显示指定 GPU 或自己正在使用的 GPU。 |
| 磁盘过滤 | 显示更多挂载点，或排除不需要的文件系统和路径。 |
| 操作按钮 | 隐藏不常用的快捷按钮，并选择远程窗口按钮的打开方式。 |
| 服务器 | 启动时恢复标签页，或开启「仅刷新可见面板」以减少后台采集。 |

默认情况下，已打开的服务器标签在后台也会继续采集。开启「仅刷新可见面板」可降低后台采集开销，但重新显示时可能需要等待新数据。侧栏设备标签按工作区保存。

点击「运行中／已暂停」可暂停或恢复当前 VS Code 窗口的全部监控。暂停时点击「重试」只更新一次，之后仍保持暂停。

## 常见问题

### 服务器没有出现在列表中，或者连接失败

检查 VS Code 使用的 SSH 配置文件，然后刷新服务器列表。主机需要有明确的 `Host` 别名，通配符不会单独显示为服务器条目。

可先使用上面的非交互式 SSH 测试命令检查认证。使用带口令的 SSH 私钥时，可以先将密钥加载到 SSH agent。对于需要 TOTP 等交互认证的服务器，可以先在终端或通过已有的可信认证脚本完成认证，并建立可复用的 SSH 主连接。

如果本地 SSH 支持并已配置[连接复用](https://man.openbsd.org/ssh_config#ControlMaster)（如 `ControlMaster`、`ControlPath` 和 `ControlPersist`），扩展可以复用已认证的连接进行后台采集。完成认证后，再运行上述测试命令确认；主连接断开或过期后，需要重新认证。

如果当前环境不支持连接复用，或仍无法完成非交互式连接，可以使用「打开远程窗口」通过 Remote-SSH 完成登录，再在远程窗口中安装或启用 System Monitor，直接监控该服务器。

### GPU 或 SSH 指标不可用

NVIDIA GPU 指标需要被监控机器上的 `nvidia-smi` 能正常运行。SSH 流量和延迟需要 Linux 的 `ss` 命令及可读取的 TCP 统计信息；某项可选指标不可用时，其他监控区域仍可使用。

使用 SSH 连接复用时，流量读数可能包含共享同一 TCP 连接的其他会话。

### 磁盘占用与“已用空间”为何不同

磁盘占用包含普通用户无法使用的空间，例如文件系统预留空间。悬停信息图标即可查看各项明细；没有有效容量信息的挂载点不显示。

### 采集频繁超时，或者监控自动暂停

检查网络与服务器负载，并尝试增大刷新间隔。采集失败时，已有视图会保留最后可用的数据。

如果确认多条 SSH 采集任务在连接中断后仍未退出，扩展会暂停监控并提示对应 PID，供用户复制和检查。关闭提示后不会自动恢复，检查完成后可手动恢复监控。

本地 SSH 采集沿用系统的 SSH 配置，不在服务器上安装监控服务、不依赖 Python，也不创建监控临时文件。扩展不会自动清理远端进程；连接中断后，命令可能继续运行到自行结束。

## 反馈

遇到问题或有功能建议，可以提交 [GitHub Issue](https://github.com/lcx-0504/sysmonitor/issues)。连接问题请说明本地和远端系统、使用的是本地 SSH 监控还是远程窗口，并附上相关错误信息。分享日志前，请移除密码、令牌和其他隐私信息。

版本变化见[更新记录](CHANGELOG.md)。

## 贡献者

<a href="https://github.com/lcx-0504" title="作者"><img src="https://github.com/lcx-0504.png" width="50" style="border-radius:50%" alt="lcx-0504"/></a>
<a href="https://github.com/klay7w" title="协助修复 GPU 刷新稳定性"><img src="https://github.com/klay7w.png" width="50" style="border-radius:50%" alt="klay7w"/></a>

## 许可

[MIT](LICENSE)

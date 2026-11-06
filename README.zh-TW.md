# System Monitor — 系統監控

[![VS Marketplace](https://vsmarketplacebadges.dev/version/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Downloads](https://vsmarketplacebadges.dev/downloads-short/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Rating](https://vsmarketplacebadges.dev/rating-star/LiChenxi.sysmonitor.svg)](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor)
[![Open VSX](https://img.shields.io/open-vsx/v/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/LiChenxi/sysmonitor)](https://open-vsx.org/extension/LiChenxi/sysmonitor)
[![GitHub Stars](https://img.shields.io/github/stars/lcx-0504/sysmonitor)](https://github.com/lcx-0504/sysmonitor)
[![License](https://img.shields.io/github/license/lcx-0504/sysmonitor)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

System Monitor 是面向 VS Code 及其衍生版本（如 Cursor、Windsurf）的 Linux 系統監控擴展，顯示面板和狀態欄。支持監控本地 Linux 和 SSH 遠端伺服器，也可在 Remote-SSH、WSL 和 Linux 容器中使用。

從 Linux、macOS 或 Windows 本地視窗通過 SSH 連接監控，也可以在 Remote-SSH、WSL、Dev Container 的 Linux 環境中直接監控當前機器。監控面板可顯示在側欄、編輯器標籤頁和獨立監控視窗多個位置。

在本地視窗中查看本機Linux（如有）以及多台連接的伺服器。

![本地視窗通過 SSH 監控多台伺服器](screenshots/local-ssh.png)

在 Remote-SSH 視窗中查看當前連接的伺服器。

![遠端視窗中的伺服器監控](screenshots/overview.png)

界面跟隨編輯器主題和顯示語言，支持英文、簡體中文與繁體中文。

## 快速開始

從 [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor) 或 [Open VSX](https://open-vsx.org/extension/LiChenxi/sysmonitor) 安裝 **System Monitor**，然後打開「系統監控」視圖。

| 運行環境 | 使用方式 |
|---|---|
| 本地 Linux | 直接查看本機；進入「伺服器」頁，還可以打開 SSH 配置中的其他 Linux 伺服器。 |
| 本地 macOS 或 Windows | 在「伺服器」頁選擇 Linux 主機。暫不支持監控當前 macOS 或 Windows 電腦。 |
| Remote-SSH、WSL 或 Dev Container 中的 Linux | 在對應遠端環境中安裝或啓用擴展，查看擴展所在機器的狀態。 |

### 從本地視窗連接伺服器

伺服器列表讀取 SSH 配置中的主機別名，優先使用 VS Code 的 `remote.SSH.configFile`，否則讀取 `~/.ssh/config`（Windows 為 `%USERPROFILE%\.ssh\config`），也支持通過 `Include` 引入的配置檔案。

後台採集需要本地有可用的 `ssh` 命令，並能夠以非交互方式完成認證，即無需臨時輸入密碼、私鑰口令或驗證碼。可以使用 SSH 密鑰、SSH agent（密鑰代理）或已經完成認證的可復用連接。將下面的 `your-server` 替換為主機別名，可驗證連接是否滿足要求：

```sh
ssh -T -o BatchMode=yes your-server true
```

驗證通過後，在「伺服器」頁選擇主機並點擊「打開」。需要交互式登錄時，可以使用 SSH 終端快捷按鈕。

如需在新建 Remote-SSH 視窗時自動安裝本擴展，可在「設定 → 伺服器」中點擊「加入預設擴展」。Remote-SSH 會安裝擴展市場上的已發佈版本。

## 功能

### 性能監控與趨勢圖

「性能」頁展示 CPU 使用率與平均負載、記憶體容量與佔用、磁碟容量與讀寫速率、網路速率，以及 GPU 狀態。CPU、記憶體和 GPU 卡片提供利用率趨勢圖，磁碟與網路卡片展示速率變化。

支持調整圖表時間範圍、選擇顯示分組和關閉背景圖表。磁碟信息按鈕提供已用、預留和可用空間明細，磁碟過濾設定支持選擇掛載點與排除檔案系統或路徑。

### GPU 監控與空閒卡選擇

GPU 卡片展示利用率、顯示記憶體、溫度、功耗和利用率趨勢。GPU 總覽按佔用程序信息統計空閒卡，支持選擇空閒卡並複製對應的 `CUDA_VISIBLE_DEVICES` 設定。

程序資訊查詢失敗時，已取得的 GPU 指標仍會顯示；佔用情況未知時，空閒數量顯示為 `--`，對應卡片暫不可選擇。

當前用戶正在使用的 GPU 以主題強調色高亮邊框。用戶標籤展示各用戶的顯示記憶體佔用，多人共用的 GPU 支持懸停查看完整用戶列表；用戶標籤和邊框高亮支持分別關閉。

「查看程序」鏈接可跳轉至對應 GPU 的程序列表。NVIDIA GPU 監控需要被監控機器上有可用的 `nvidia-smi`；空閒狀態表示當前採集的計算程序列表中沒有任務佔用該 GPU。

### 程序列表

「程序」頁支持按 CPU、記憶體或 GPU 顯示記憶體佔用排序，以及按程序名、PID、用戶或命令搜索。伺服器分別取三項排名的前 100 條，合併去重後返回最多 300 條候選記錄，各視窗獨立排序並顯示前 100 條。搜索在這些候選記錄中進行，`GPU0`、`GPU 0` 和 `#0` 可篩選指定 GPU 上的程序。

程序名和命令列支持展開與收起，右鍵選單支持複製 PID、單元格或整行。CPU 支持單核佔比、整機佔比或同時顯示；記憶體支持佔用量、佔比或同時顯示。

### 多伺服器監控

在本地視窗中，伺服器列表讀取 SSH 配置中的主機別名，並顯示連接狀態、CPU、記憶體與 GPU 概況。支持同時監控多台伺服器，設備標籤支持拖動排序與工作區恢復。已打開的監控預設繼續在後台重新整理，也支持僅重新整理可見面板。

### 多視窗與快捷操作

支持側欄監控、編輯器標籤頁和獨立監控視窗。頂欄提供新建、切換與移動視圖的操作，同一伺服器的多個監控視圖共享數據。

提供編輯器、新視窗、SSH 終端和遠端視窗四類快捷操作，支持分別顯隱。遠端視窗支持打開新工作區、最近工作區或通過選單選擇歷史位置。設定中還提供 Remote-SSH 自動安裝選項。

### 狀態欄監控

本地或遠端 Linux 環境支持狀態欄監控，可在編輯器底部顯示 CPU、記憶體、磁碟、網路、SSH 與 GPU 指標，並有詳細的選項設定。例如 GPU 支持總覽、空閒卡號、指定卡號或僅顯示當前用戶使用的 GPU。顯示指標與狀態欄位置均可配置。

### 主題與界面設定

界面跟隨編輯器的深淺色主題，使用當前主題的背景、文字和強調色，並支持響應式佈局。高負載指標採用警示顏色，卡片佈局與頂欄操作根據可用寬度調整；較窄的視圖中，部分操作收納至「…」選單。

### 隱私說明與運行環境

擴展讀取系統信息並在編輯器中展示，不含遙測，也不向第三方監控服務上傳資源指標、程序列表、用戶名或 SSH 配置。SSH 使用系統客戶端與已有認證配置，除指定連接的 SSH 主機外，不向任何其他伺服器收發數據。

本地 SSH 監控無需在伺服器上安裝代理或監控服務，無監控臨時檔案，也無需 Python。在遠端 Linux 視窗中，則由 VS Code 安裝在該環境中的擴展執行監控。

## 設定

在面板和狀態欄中均關閉的指標會停止採集，伺服器列表的對應摘要也隨之隱藏。關閉全部 GPU 顯示後，程序頁隱藏 GPU 資訊；重新啟用時恢復採集。

預設重新整理間隔為 2 秒，可在監控設定中調整。設定同時提供圖表時間範圍、顯示分組、狀態欄、磁碟過濾和快捷操作等選項。

首次連線或監控連線發生變化後，SSH 延遲先顯示，上傳和下載速率在下一次成功重新整理後出現。設定儲存失敗時，對話框會提示原因並提供重試按鈕。

「連線與採集」中的「自訂採集策略」提供三項逾時設定：SSH 連線預設 15 秒；CPU、記憶體、網路、磁碟讀寫和 SSH 指標的一般採集預設 10 秒；磁碟容量、程序列表和 GPU 的延伸採集預設 30 秒。啟用後，各項支援設定為 5～120 秒；關閉時使用預設逾時，並保留已填寫的自訂數值。連線較慢或伺服器繁忙時可適當增加。 SSH 連線池上限用於本機視窗監控，預設每台伺服器最多 4 條連線，可設定為 1～8，連線按需建立。關閉自訂策略時，連線池與逾時均使用預設值。

「僅重新整理可見面板」用於減少後台採集，但切換到前台時需要重新載入，監控伺服器較多時可啓用。設定保存到 VS Code 用戶配置，並在各個監控視圖中生效。

## 常見問題

### 伺服器沒有出現在列表中，或者連接失敗

檢查 VS Code 使用的 SSH 配置檔案，然後重新整理伺服器列表。主機需要有明確的 `Host` 別名，通配符不會單獨顯示為伺服器條目。

可先使用上面的非交互式 SSH 測試命令檢查認證。使用帶口令的 SSH 私鑰時，可以先將密鑰載入到 SSH agent。對於需要 TOTP 等交互認證的伺服器，可以先在終端或通過已有的可信認證腳本完成認證，並建立可復用的 SSH 主連接。

如果本地 SSH 支持並已配置[連接復用](https://man.openbsd.org/ssh_config#ControlMaster)（如 `ControlMaster`、`ControlPath` 和 `ControlPersist`），擴展可以復用已認證的連接進行後台採集。完成認證後，再運行上述測試命令確認；主連接斷開或過期後，需要重新認證。

如果當前環境不支持連接復用，或仍無法完成非交互式連接，可以使用「打開遠端視窗」通過 Remote-SSH 完成登錄，再在遠端視窗中安裝或啓用 System Monitor，直接監控該伺服器。

### GPU 或 SSH 指標不可用

NVIDIA GPU 指標需要被監控機器上的 `nvidia-smi` 能正常運行。SSH 流量和延遲需要 Linux 的 `ss` 命令及可讀取的 TCP 統計信息；某項可選指標不可用時，其他監控區域仍可使用。

使用 SSH 連接復用時，流量讀數可能包含共享同一 TCP 連接的其他會話。

### 磁碟佔用與“已用空間”為何不同

磁碟佔用包含普通用戶無法使用的空間，例如檔案系統預留空間。懸停信息圖標即可查看各項明細；沒有有效容量信息的掛載點不顯示。

### 採集頻繁超時，或者監控自動暫停

檢查網路與伺服器負載，並嘗試增大重新整理間隔。採集失敗時，已有視圖會保留最後可用的數據。

點擊採集錯誤橫幅中的重試按鈕後，原錯誤會保留並顯示「採集中」。對應指標採集成功後，錯誤提示自動清除。

如果確認多條 SSH 採集任務在連接中斷後仍未退出，擴展會暫停監控並提示對應 PID，供用戶複製和檢查。關閉提示後不會自動恢復，檢查完成後可手動恢復監控。

伺服器上有可用的 `timeout` 工具時，遠端採集命令會設定執行期限。系統 I/O 阻塞等情況仍可能延遲程序退出，擴展會報告確認仍在執行的採集程序，供用戶檢查並決定是否清理。

## 反饋

遇到問題或有功能建議，可以提交 [GitHub Issue](https://github.com/lcx-0504/sysmonitor/issues)。連接問題請說明本地和遠端系統、使用的是本地 SSH 監控還是遠端視窗，並附上相關錯誤信息。分享日誌前，請移除密碼、令牌和其他隱私信息。

版本變化見[更新記錄](CHANGELOG.md)。

## 貢獻者

<a href="https://github.com/lcx-0504" title="作者"><img src="https://github.com/lcx-0504.png" width="50" style="border-radius:50%" alt="lcx-0504"/></a>
<a href="https://github.com/klay7w" title="協助修復 GPU 重新整理穩定性"><img src="https://github.com/klay7w.png" width="50" style="border-radius:50%" alt="klay7w"/></a>

## 許可

[MIT](LICENSE)

# Changelog

## Unreleased

- **Async GPU collection**: GPU data is now collected asynchronously via `execFile` (non-blocking), eliminating UI freezes caused by slow `nvidia-smi` responses. Cached snapshots survive transient timeouts (30 s TTL). State transitions (fresh / fallback / unavailable) are logged to the Output Channel. Inspired by @klay7w's PR #1.

## 1.1.2 — 2026-04-16

- **Tabular numbers toggle**: added on/off switch in Display settings (default: on) with info tooltip
- **Diagnostics**: added state-change logging for GPU, SSH, and Disk to Output Channel for easier troubleshooting

## 1.1.1 — 2026-04-16

- **Layout**: increased CPU/RAM card flex-basis from 140px to 146px, preventing load labels from wrapping at the single/dual row breakpoint

## 1.1.0 — 2026-04-16

- **Disk I/O**: real-time read/write speed displayed in disk card header (combined R+W; hover tooltip shows breakdown), with background sparkline chart (read=yellow, write=blue, dynamic scaling)
- **Status bar Disk I/O**: 5 display modes — off / read / write / both / combined — matching the network speed pattern
- **GPU idle card IDs**: status bar summary can now show idle GPU IDs (e.g. `3/8 (2,5,7)`) — new `showIdleIds` toggle in settings
- **GPU VRAM in process table**: GPU tags now show total VRAM (e.g. `#0 4.2G/80G 15%`) with RTL ellipsis on overflow
- **Tabular numbers**: applied `tabular-nums` globally for stable number widths across all metrics
- **Speed display**: `fmtBytes` / `fmtBytesShort` now support GB/s
- **Theme color**: accent color changed from `progressBar.background` to `button.background` for better compatibility with 2026 themes; button text and menu shadow also follow theme variables
- **UI polish**: fixed GPU card baseline alignment; limited process name column width; primary button active feedback changed to opacity

## 1.0.23 — 2026-04-13

- **Charts toggle responsive**: background sparklines now hide/show immediately without requiring Reload Window; also applies to dynamically created GPU cards
- **Process table sync**: process refresh interval now follows user setting (was hardcoded 5s); "Updated at" timestamp and process table refresh in sync
- **Copy PID**: right-click context menu in process table now includes "Copy PID" option
- **Leaf mount tooltip**: added example (`/autodl-fs` vs `/autodl-fs/data`) for clarity
- **Minor**: removed unnecessary forced reflow in settings panel

## 1.0.22 — 2026-04-13

- **Local Linux support**: extension now activates on local Linux desktops in addition to remote environments
- **Notification improvements**: local Linux users are prompted to add extension to SSH default settings; text refined across all scenarios
- **WSL2 → WSL**: updated references from "WSL2" to "WSL" for broader compatibility
- **Status bar tooltip**: simplified from "System Monitor (Remote)" to "System Monitor"

## 1.0.21 — 2026-04-13

- **GPU tag font size**: adjust to 11px for better visual balance

## 1.0.20 — 2026-04-13

- **GPU tag font size**: increase from 9px to 12px to match table body text

## 1.0.19 — 2026-04-13

- **GPU VRAM percentage**: GPU tags in process table now show `#idx vram pct%` format (e.g. `#0 1.2G 45%`)
- **Colored GPU tags**: tag background color changes based on VRAM usage threshold (blue < 70%, yellow ≥ 70%, red ≥ 90%), using `color-mix()` with theme variables
- **Table column width**: only the command column stretches to fill remaining space; all other columns stay compact

## 1.0.18 — 2026-04-12

- **Metadata update**: improved keywords, description, categories for better Marketplace discoverability; added homepage and bugs links to package.json

## 1.0.16 — 2026-04-12

- Fix README badges: replace deprecated shields.io VS Marketplace badges with vsmarketplacebadges.dev

## 1.0.15 — 2026-04-12

- Add Shields.io badges to README (Marketplace version/downloads/rating, Open VSX, GitHub stars, license)

## 1.0.14 — 2026-04-12

- **README refresh**: add screenshots (performance, process manager, settings), restructure documentation with feature tables
- **CHANGELOG**: add full version history from 1.0.8 onward
- **No GPU display**: show a clean "No GPU" label on the summary card; hide capsules and action buttons; fix card spacing

## 1.0.13 — 2026-04-12

- **Disk custom filter**: switching to "Custom" mode now preserves user-modified rules instead of always inheriting from the current preset
- **GPU status bar icon**: deduplicate `$(circuit-board)` icon when both summary and per-card details are enabled
- **No GPU display**: show a clean "No GPU" label on the summary card instead of a separate message; hide capsules and action buttons
- Remove misleading placeholder text from custom disk filter inputs

## 1.0.12 — 2026-04-12

- **Copy button**: replace timer-based "Copied" text feedback with CSS `:active` press color (no more flickering on rapid clicks)
- **GPU link flash**: fix "View Processes" link causing cursor/color flash on data refresh by avoiding unnecessary DOM re-append
- **Full command copy**: right-click "Copy Row" now copies the full command (previously truncated to 50 chars)
- **GPU tags vertical**: processes using multiple GPUs now display GPU tags vertically in the process table

## 1.0.11 — 2026-04-12

- **Status bar position**: configurable alignment (left/right) and priority
- **Refresh interval labels**: show `2秒` instead of `2s` in Chinese locale
- **Sticky settings header**: settings modal title bar stays fixed while content scrolls
- **Copyright links**: Marketplace, Open VSX, and GitHub links in settings footer
- **GPU left-truncation**: GPU model name and VRAM text truncate from the left when the panel is narrow
- **Default priority**: changed from 100 to 10
- **Process table right-click menu**: copy cell or copy entire row

## 1.0.10 — 2026-04-11

- Progress bar color transitions (green → yellow → red)
- PID column in process table
- Sparkline dark mode opacity fix

## 1.0.9 — 2026-04-11

- Fix refresh interval: cache `os.cpus()` to avoid stale data
- Time-based sparklines with configurable duration (1 / 2 / 5 / 10 / 30 min)
- Custom disk mount filter (default / more / all / custom modes)
- Progress bar animation
- Network speed calculation improvements
- Settings UI polish

## 1.0.8 — 2026-04-11

- Fix SSH sparkline direction & color convention (orange = upload, blue = download)
- Background sparkline charts
- Charts toggle setting
- RAM default enabled in status bar
- Disk monitoring with progress bars
- GPU overflow fix in narrow panels
- Responsive layout improvements
- Initial public release

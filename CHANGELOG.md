# Changelog

## 1.4.2 — 2026-09-24

- Kept rate-chart scaling tied to the visible time window so incoming samples do not abruptly rescale the entire chart.
- Split the Webview into smaller performance, process, and settings modules, and aligned GPU user-memory colors with process tags and card thresholds.
- Added stacked hover details for overflowed GPU user labels and compact hover details for disk capacity, with consistent popover spacing and non-clickable cursor behavior.
- Reworked disk capacity around total, used, and available bytes: a reserved/used/available segmented bar, an occupied-to-total value and percentage, and an always-available four-row breakdown. The reserved segment uses the current theme, and narrow layouts place its info icon beside the mount path.
- Rendered disk capacity with a rounded occupied bar and a square-ended reserved overlay, keeping the same shape at very small segment sizes.

## 1.4.1 — 2026-09-24

- Aligned chart color transitions with the metric bars while keeping time-based scrolling independent.
- Made GPU card footers compact: shared VRAM units, user labels with an immediate and live temperature/power popover, and temperature/power shown directly when no users are available or user labels are disabled.
- Restored GPU user labels immediately after returning from the process tab.
- Improved settings layout with content-sized controls, clearer descriptions, and a draggable overlay scrollbar that does not reserve content width.

## 1.4.0 — 2026-09-24

- Added five independent visibility groups for the performance panel: CPU/RAM, disk, network/SSH, GPU overview, and GPU cards. Collection and status-bar data remain available when a group is hidden.
- Added SSH TCP round-trip latency, shown with the same adaptive time units as other duration values.
- Added GPU model names with leading NVIDIA, GeForce, and Tesla prefixes removed; per-card user VRAM labels ranked by usage; an optional theme-color border for GPUs used by the current user; and a switch for the idle-GPU picker. User labels show each user's total VRAM on that card and use the process-tag color thresholds.
- Added a native view-title action to open multiple monitor Editor tabs with the extension icon. The sidebar and Editor views share live snapshots and process display preferences while keeping temporary view state independent.
- Improved the process table with horizontal expansion controls for process names and commands, single-core/machine/both CPU modes, used/percent/both RAM modes, consistent left-aligned columns except PID, and complete copy text for combined cells.
- Made background charts scroll continuously between samples without adding a foreground line. Unified capacity, rate, and duration formatting across the panel, status bar, process table, and tooltips using one decimal place and adaptive K/M/G/T or ms/s/m/h units.
- Reworked the built-in settings with animated switches, segmented alignment controls, stable dropdown menus, and conditional GPU options. Disk filter presets continue to show their disabled custom-field previews.

## 1.3.0 — 2026-09-23

- Reorganized monitoring into asynchronous collectors, one refresh scheduler, a shared snapshot store, and separate configuration, view, status-bar, and Webview modules.
- Added provider-based accelerator collection with stable device identities. NVIDIA GPU metrics and process data now update together after both collection steps complete.
- Normalized existing settings with deep defaults and validation, and added a configurable 1–30 second refresh interval.
- Fixed Linux kernel-thread names containing `/`, process sorting over the full process set while displaying the top 100, and process-table updates while its context menu is open.
- Fixed default-route network double counting, SSH traffic directions, GPU count changes, GPU tag opacity, and GPU process identity matching.
- Fixed Webview refreshes lost when a frontend helper replaced the browser's native `window.postMessage`.
- Added automated syntax, configuration, collector, scheduler, accelerator, status-bar, Webview, localization, and packaging checks.

## 1.2.0 — 2026-04-16

- **Fully async GPU pipeline**: All `nvidia-smi` calls are now non-blocking. GPU panel shows “Loading…” on first open, then data appears within seconds via instant callback. Merged UUID mapping into a single GPU query (2-step chain instead of 3). No more `execFileSync` — zero tick blocking from the very first frame. Inspired by @klay7w’s PR #1.
- **Async GPU process data**: Process table GPU tags (VRAM, card index) and “my GPU” detection are now fully asynchronous.
- **Contributors**: Added Contributors section to README.

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

# Changelog

## 1.0.15 — 2025-04-12

- Add Shields.io badges to README (Marketplace version/downloads/rating, Open VSX, GitHub stars, license)

## 1.0.14 — 2025-04-12

- **README refresh**: add screenshots (performance, process manager, settings), restructure documentation with feature tables
- **CHANGELOG**: add full version history from 1.0.8 onward
- **No GPU display**: show a clean "No GPU" label on the summary card; hide capsules and action buttons; fix card spacing

## 1.0.13 — 2025-04-12

- **Disk custom filter**: switching to "Custom" mode now preserves user-modified rules instead of always inheriting from the current preset
- **GPU status bar icon**: deduplicate `$(circuit-board)` icon when both summary and per-card details are enabled
- **No GPU display**: show a clean "No GPU" label on the summary card instead of a separate message; hide capsules and action buttons
- Remove misleading placeholder text from custom disk filter inputs

## 1.0.12 — 2025-04-12

- **Copy button**: replace timer-based "Copied" text feedback with CSS `:active` press color (no more flickering on rapid clicks)
- **GPU link flash**: fix "View Processes" link causing cursor/color flash on data refresh by avoiding unnecessary DOM re-append
- **Full command copy**: right-click "Copy Row" now copies the full command (previously truncated to 50 chars)
- **GPU tags vertical**: processes using multiple GPUs now display GPU tags vertically in the process table

## 1.0.11 — 2025-04-11

- **Status bar position**: configurable alignment (left/right) and priority
- **Refresh interval labels**: show `2秒` instead of `2s` in Chinese locale
- **Sticky settings header**: settings modal title bar stays fixed while content scrolls
- **Copyright links**: Marketplace, Open VSX, and GitHub links in settings footer
- **GPU left-truncation**: GPU model name and VRAM text truncate from the left when the panel is narrow
- **Default priority**: changed from 100 to 10
- **Process table right-click menu**: copy cell or copy entire row

## 1.0.10 — 2025-04-10

- Progress bar color transitions (green → yellow → red)
- PID column in process table
- Sparkline dark mode opacity fix

## 1.0.9 — 2025-04-09

- Fix refresh interval: cache `os.cpus()` to avoid stale data
- Time-based sparklines with configurable duration (1 / 2 / 5 / 10 / 30 min)
- Custom disk mount filter (default / more / all / custom modes)
- Progress bar animation
- Network speed calculation improvements
- Settings UI polish

## 1.0.8 — 2025-04-08

- Fix SSH sparkline direction & color convention (orange = upload, blue = download)
- Background sparkline charts
- Charts toggle setting
- RAM default enabled in status bar
- Disk monitoring with progress bars
- GPU overflow fix in narrow panels
- Responsive layout improvements
- Initial public release

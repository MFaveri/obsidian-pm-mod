<div align="center">

# PM Workbench

**Markdown-native project management inside Obsidian — extended with advanced scheduling, Critical Path (CPM), Schedule Baseline, FS/SS/FF Dependencies with Lag/Lead, Parent Rollup, and Team Workload analysis.**

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[About & Credits](#about--credits) | [Features Added](#features-added-on-top-of-dotpm) | [Install](#install) | [Development](#development) | [License](#license)

</div>

---

## About & Credits

**PM Workbench** (`pm-workbench`) is a personal spin-off built on top of the outstanding **[dotpm](https://github.com/dotpm/obsidian-pm)** plugin (original `id: project-manager`), created by **Stepan Kropachev** and the **dotpm contributors**.

> **Gratitude & Intent**  
> All credit for the core architecture — storing projects and tasks as plain Markdown notes, the Table/Gantt/Kanban engine, local HTTP/MCP API, i18n foundation, and static HTML viewer — belongs to the original **dotpm** developers. I deeply admire the quality and craftsmanship of their work.  
>
> This fork was created strictly for **personal use**, to tailor the tool to my specific scheduling and project-control workflows. Rather than trying to compare or compete with the original plugin, this repository simply documents the extra scheduling capabilities built on top of `dotpm` v2.6.0.

If you are looking for the official, community-maintained release in the Obsidian Community Plugins directory, please visit **[dotpm](https://github.com/dotpm/obsidian-pm)**.

---

## Features Added on Top of `dotpm`

- **Multi-Project Gantt & Summary Bars**
  - Group tasks across multiple projects under collapsible project summary bars (`min start .. max due` and aggregated progress).
  - Filter timelines by assignee across projects.
- **Critical Path Method (CPM) & Total Slack**
  - Forward and backward pass calculation (`Scheduler.ts`) computing earliest/latest dates and total float (`slackDays`) in working days.
  - Highlight critical tasks and critical dependency edges directly on the Gantt chart and inspect slack via floating tooltips.
- **Schedule Baseline Tracking**
  - Capture and clear schedule baselines (`baselineStart` / `baselineDue`) at the project or scope level.
  - Render baseline ghost bars on the Gantt chart and inspect schedule variance (ahead / on time / late).
- **Per-Project Working Calendar & Time-Off Overrides**
  - Configure working weekdays, holidays, extra workdays, and extra non-working days (including date-range entry) per project.
  - Visual shading in the Gantt grid distinguishing working days, non-working weekends, time-off, and extra workdays.
- **Mandatory Task Duration & Risk Detection (`durationDays`)**
  - Fixed **Duration (days)** field in task forms (omitted on milestones).
  - Auto-scheduling and CPM respect `Math.max(window, durationDays)`.
  - Detects when a task's scheduled window is shorter than its required execution duration, displaying risk borders/overflow bars in Gantt and a one-click **"Adjust deadline"** action in the task modal.
- **Dependency Types (`FS`, `SS`, `FF`) & Lag/Lead (`±days`)**
  - Support for Finish-to-Start (`FS`), Start-to-Start (`SS`), and Finish-to-Finish (`FF`) relationships with positive lag or negative lead days.
  - Inline type & lag selector in task modals, smart anchor routing and badges (e.g. `SS +2d`, `FF -1d`) in Gantt, and clickable arrow context menus.
- **Parent Task Rollup in Gantt**
  - Automatically rolls up subtask date ranges (`min start .. max due`), baselines, and weighted progress onto parent task rows.
  - Distinguishes expanded parents (bracket summary bar above indented subtasks) from collapsed parents (consolidated summary bar with subtask count badges).
- **Team Workload & Overload Detection**
  - Analyzes active task allocations day by day across working days for each assignee.
  - Highlights concurrent task overlaps (`≥ 2` active tasks on the same working day) via a **Workload** toggle in the Gantt toolbar and a **Team workload** card in Project Overview with clickable conflicting task links.
- **Integrated Schedule Metrics Across Views & Exports**
  - **Table View:** Optional sortable columns for **Duration**, **Slack**, and **Baseline**, plus native filters for **Critical path**, **Slack (days)**, and **Duration risk**.
  - **Project Overview:** **Schedule health** card (critical tasks count, baseline variance summary, clickable duration risk alerts) and **Team workload** panel.
  - **Static HTML Snapshots:** Exported standalone HTML snapshots and the static viewer preserve CPM highlighting, baseline ghost bars, duration risks, parent rollups, and schedule table columns.

---

## Install

> This spin-off is currently shared on GitHub only (not submitted to the Obsidian Community Plugins store). Its plugin ID is `pm-workbench` so it does not collide with `project-manager`.

### Manual Install

1. Build the plugin (or download `main.js`, `manifest.json`, and `styles.css` from a GitHub release if available).
2. Create the folder `<your-vault>/.obsidian/plugins/pm-workbench/`.
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
4. Reload Obsidian and enable **PM Workbench** under **Settings > Community plugins**.

### Build from Source

Requires **Node.js** and **pnpm**:

```bash
pnpm install
pnpm build
```

The compiled plugin artifacts (`main.js`, `styles.css`, `manifest.json`) are generated in the repository root.

---

## Development

```bash
# Typecheck, lint, and tests
pnpm check:types
pnpm check:code
pnpm check:submission
pnpm test

# Development watch build
pnpm dev
```

---

## License

Licensed under the **MIT License** — see [LICENSE](LICENSE) for full details.

- Original work: `Copyright (c) 2026 Stepan Kropachev and dotpm contributors`
- Modifications in this repository: `Copyright (c) 2026 MFaveri (PM Workbench modifications)`

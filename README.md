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

- **Executive Portfolio Cockpit (Multi-Project Dashboard)**
  - Default interactive **Executive Cockpit** mode in the Projects Dashboard (alongside a focused **Cards** mode and the classic **Table** list, with a one-click **"Use as default view"** toggle in the view switcher).
  - **Portfolio KPIs:** overall completion, overdue & critical task counts, duration/baseline schedule risks, and cross-project assignee overload alerts.
  - **Immediate Focus & Next Actions Queue:** automatically ranks the top actionable, unblocked tasks across all active projects (overdue, critical path, duration risk, near due, and project priority tier) with a configurable visible limit (default 10), one-click status updates, and modal editing.
  - **Project Priority Tiers (`tier-00`, `tier-01`, …):** extensible per-project priority tiers (defaulting to `tier-00` for new/unclassified projects) with one-click switching on Cockpit cards and Table rows, tier-grouped collapsible sections in the Cockpit, and full filter/sort/group support.
  - **Upcoming Portfolio Milestones & Project Cards:** side-by-side project cards with health traffic lights (*On track*, *Attention*, *At risk*), next milestone, projected finish date, and the next 3 actionable steps per project.
  - **Custom Project Selection & Saved Views:** dedicated **Projects** selector (and filter section) to choose exactly which and how many projects are included in the Cockpit KPIs, focus queue, milestones, workload, and cards, with full support for saving custom subsets as named views.
- **Project Analytics & Charts Dashboard (`ProjectChartsView`)**
  - Dedicated interactive **Charts** view per project, accessible directly via the **"Open charts"** button on Cockpit project cards, the Project Overview header, and tab navigation menus.
  - **Weekly Workload Histogram:** dynamic SVG histogram plotting active tasks overlapping each week with current-week highlighting, overload alerts (`⚡`), completed markers, and toggle between *By status* (on track vs. risk) and *By assignee* (stacked color bars), complete with click drill-down.
  - **Assignee Workload & Capacity Bars:** horizontal stacked distribution bars (*Overdue / Active / Done*) per team member with daily concurrent peak badges (`Max N/day`) and interactive task inspection.
  - **Scope & Delivery Burn-up Curve:** cumulative tracking of total scope created, planned due dates, baseline planned schedule, and actual completed tasks with pace diagnosis (*Ahead / Behind by N tasks*).
  - **Schedule Fragility & Slack Profile (CPM):** interactive proportional bar and category breakdown (*Overdue*, *Critical 0d*, *Tight 1–3d*, *Margin >3d*, *Unscheduled*) with clickable task lists.
  - **Baseline Variance Diverging Chart:** visual delta bars (`-Xd` ahead vs. `+Xd` slipped) per tracked task against captured baseline.
  - **Effort Tracking (Estimated vs. Logged):** comparative progress bars per team member with over-budget alerts.
  - **Time Window Toggle:** instant switch between **12 weeks** rolling window and **Full span**.
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
- **Note-to-Project Conversion & Task-to-Subproject Promotion**
  - **Convert Note to Project:** Turn any existing Markdown note into a recognized project (keeping it in place or moving it to the projects folder) via the file context menu or command palette, preserving its body and custom frontmatter.
  - **Promote Task to Subproject:** Promote any task (along with its subtasks) into a nested subproject directly from the task modal `...` menu, Gantt/Table/Kanban context menus, or file menu, migrating subtasks and stripping task-only frontmatter cleanly.

---

## Differences at a Glance (dotpm vs PM Workbench)

The table below summarizes the technical extensions introduced in **PM Workbench**:

| Capability | dotpm (v2.6.0) | PM Workbench |
| :--- | :---: | :---: |
| **Projects Dashboard** | Table list with search & grouping | **Executive Portfolio Cockpit** (portfolio KPIs, unblocked focus queue, upcoming milestones, project health cards) + instant toggle to classic Table |
| **Project Analytics & Charts** | — | **Dedicated Project Charts dashboard** with weekly workload histogram (by status/assignee), assignee capacity bars, scope burn-up curve, CPM slack profile, baseline divergence, and effort tracking |
| **Critical Path Method (CPM)** | — | **Automated CPM engine** calculating critical path, earliest/latest dates, and working-day Total Slack with Gantt highlighting |
| **Schedule Baseline Tracking** | — | **Baseline snapshot capture** (`baselineStart` / `baselineDue`), Gantt ghost bars, and schedule variance tracking |
| **Mandatory Duration & Risk** | Date window only | **Explicit duration (`durationDays`)** with execution shortfall detection, visual warning badges, and 1-click deadline adjustment |
| **Advanced Dependencies** | Finish-to-Start (`FS`) only | **`FS`, `SS`, `FF` dependencies** with customizable Lag/Lead offset (`±days`) and inline Gantt routing |
| **Parent Task Rollup in Gantt** | Subtasks rendered independently | **Hierarchical summary rollup** (date range, baselines, progress) with expanded brackets and collapsed summary bars |
| **Team Workload & Overload** | — | **Assignee workload analysis** detecting concurrent overlapping tasks across working days with conflict links |
| **Working Calendar & Time-Off** | Default calendar | **Per-project calendar overrides**: customizable working weekdays, holidays, extra workdays, and time-off date ranges |
| **Schedule Health in Overview** | Basic status counts | **Dedicated Schedule Health & Team Workload panels** with clickable risk alerts and overload diagnosis |
| **Table View Scheduling Columns** | Standard task fields | **Duration, Slack, and Baseline columns** with dedicated CPM, Slack, and Duration Risk filters |
| **Standalone HTML Snapshots** | Standard snapshot export | **Full schedule metadata export**, preserving CPM styling, baseline ghost bars, duration risks, and rollup summaries |

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

## Permissions & Privacy

PM Workbench reads and writes only the Markdown notes you organize into projects/tasks (via Obsidian's `Vault` API), so it needs to enumerate vault files to find and link those notes — it never reads unrelated files' content, and nothing leaves your machine. The optional **Local API** (HTTP/MCP, off by default) only binds to `127.0.0.1`, requires a token, and lets other local tools on the same computer read/edit tasks. Clipboard access is used solely for explicit user actions (e.g. "Copy as Markdown" / paste-to-import), never read in the background.

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

trigger2
trigger3

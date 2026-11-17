import { type PMSettings, type Project, flattenTasks } from '@dotpm/core'

/**
 * Which parents are collapsed is the reader's own state, so it is read from settings at
 * render time and never carried on the task objects a reload replaces. Task ids are unique
 * across the vault, so a scope covering several projects reads one merged set.
 */
export function collapsedTaskIds(settings: PMSettings, projects: Project[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const project of projects) {
    for (const id of settings.collapsedTasks[project.filePath] ?? []) ids.add(id)
  }
  return ids
}

export function toggleCollapsed(settings: PMSettings, project: Project, taskId: string): void {
  const ids = settings.collapsedTasks[project.filePath] ?? []
  const at = ids.indexOf(taskId)
  if (at === -1) ids.push(taskId)
  else ids.splice(at, 1)
  settings.collapsedTasks[project.filePath] = ids
}

export function collapsedGanttProjectPaths(settings: PMSettings, projects: Project[]): ReadonlySet<string> {
  const inScope = new Set(projects.map((p) => p.filePath))
  return new Set((settings.collapsedGanttProjects ?? []).filter((path) => inScope.has(path)))
}

export function toggleGanttProjectCollapsed(settings: PMSettings, projectPath: string): void {
  const paths = settings.collapsedGanttProjects ?? []
  const at = paths.indexOf(projectPath)
  if (at === -1) paths.push(projectPath)
  else paths.splice(at, 1)
  settings.collapsedGanttProjects = paths
}

export function setAllCollapsed(
  settings: PMSettings,
  projects: Project[],
  collapsed: boolean,
  includeProjects = false
): void {
  for (const project of projects) {
    settings.collapsedTasks[project.filePath] = collapsed
      ? flattenTasks(project.tasks)
          .filter((flat) => flat.task.subtasks.length > 0)
          .map((flat) => flat.task.id)
      : []
  }
  if (!includeProjects) return
  const scopePaths = new Set(projects.map((p) => p.filePath))
  const remaining = (settings.collapsedGanttProjects ?? []).filter((path) => !scopePaths.has(path))
  settings.collapsedGanttProjects = collapsed ? [...remaining, ...scopePaths] : remaining
}

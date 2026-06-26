import { useMemo } from 'react';
import type { Project, ProjectGroup, Session } from '@pinloom/shared';

// Sidebar-style hierarchy shared by every session/project picker: project groups
// → projects → sessions. Extracted from SessionPickerModal so the add-worker /
// add-member / move pickers stop rendering one flat wall of rows. The current
// project's group is surfaced first so the most-likely target sits on top;
// `groupId === null` projects collect under a synthetic 'Ungrouped' tail.

export interface ProjectBucket {
  project: Project;
  sessions: Session[];
  isCurrent: boolean;
}

export interface GroupSection {
  key: string;
  label: string;
  isUngrouped: boolean;
  projects: ProjectBucket[];
}

export interface GroupedSessionsOptions {
  sessions: Session[];
  projects: Project[];
  groups: ProjectGroup[];
  /** The originating project — its group floats to the top. */
  currentProjectId: string;
  /** Hide a single session (e.g. the one being routed from). */
  excludeSessionId?: string;
  /** Extra per-session predicate (e.g. drop sessions already in a team). */
  sessionFilter?: (s: Session) => boolean;
  /** Drop projects that end up with zero sessions (pure session pickers). */
  hideEmptyProjects?: boolean;
}

export function useGroupedSessions({
  sessions,
  projects,
  groups,
  currentProjectId,
  excludeSessionId,
  sessionFilter,
  hideEmptyProjects,
}: GroupedSessionsOptions): GroupSection[] {
  return useMemo(() => {
    const sessionsByProject = new Map<string, Session[]>();
    for (const s of sessions) {
      if (excludeSessionId && s.id === excludeSessionId) continue;
      if (sessionFilter && !sessionFilter(s)) continue;
      const arr = sessionsByProject.get(s.projectId) ?? [];
      arr.push(s);
      sessionsByProject.set(s.projectId, arr);
    }

    const buckets: ProjectBucket[] = projects.map((p) => ({
      project: p,
      sessions: sessionsByProject.get(p.id) ?? [],
      isCurrent: p.id === currentProjectId,
    }));

    const bucketsByGroupId = new Map<string | null, ProjectBucket[]>();
    for (const bucket of buckets) {
      if (hideEmptyProjects && bucket.sessions.length === 0) continue;
      const key = bucket.project.groupId;
      const arr = bucketsByGroupId.get(key) ?? [];
      arr.push(bucket);
      bucketsByGroupId.set(key, arr);
    }
    for (const arr of bucketsByGroupId.values()) {
      arr.sort((a, b) => a.project.name.localeCompare(b.project.name));
    }

    const currentGroupId =
      projects.find((p) => p.id === currentProjectId)?.groupId ?? null;
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    const sortedGroups = [...groups].sort((a, b) => a.orderIndex - b.orderIndex);

    function makeSection(groupIdKey: string | null, label: string): GroupSection | null {
      const projectsInGroup = bucketsByGroupId.get(groupIdKey) ?? [];
      if (projectsInGroup.length === 0) return null;
      return {
        key: groupIdKey ?? '__ungrouped__',
        label,
        isUngrouped: groupIdKey === null,
        projects: projectsInGroup,
      };
    }

    const out: GroupSection[] = [];
    // 1. Current project's group first (or Ungrouped if it's itself ungrouped).
    if (currentGroupId !== null && groupsById.has(currentGroupId)) {
      const sec = makeSection(currentGroupId, groupsById.get(currentGroupId)?.name ?? '');
      if (sec) out.push(sec);
    } else if (currentGroupId === null) {
      const sec = makeSection(null, 'Ungrouped');
      if (sec) out.push(sec);
    }
    // 2. Other named groups by orderIndex.
    for (const g of sortedGroups) {
      if (g.id === currentGroupId) continue;
      const sec = makeSection(g.id, g.name);
      if (sec) out.push(sec);
    }
    // 3. Ungrouped tail (unless already surfaced as #1).
    if (currentGroupId !== null) {
      const sec = makeSection(null, 'Ungrouped');
      if (sec) out.push(sec);
    }
    return out;
  }, [
    sessions,
    projects,
    groups,
    currentProjectId,
    excludeSessionId,
    sessionFilter,
    hideEmptyProjects,
  ]);
}

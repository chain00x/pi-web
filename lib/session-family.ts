import type { SessionInfo } from "./types";

export interface SessionFamily {
  root: SessionInfo;
  subagents: SessionInfo[];
  latestModified: string;
}

function resolveFamilyRoots(sessions: readonly SessionInfo[]): Map<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, string | null>();

  for (const session of sessions) {
    if (roots.has(session.id)) continue;

    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = session.id;
    let rootId: string | null = null;

    while (true) {
      if (roots.has(currentId)) {
        rootId = roots.get(currentId) ?? null;
        break;
      }
      if (visited.has(currentId)) break;

      visited.add(currentId);
      path.push(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      if (current.relation?.kind !== "subagent") {
        rootId = current.id;
        break;
      }
      currentId = current.relation.parentSessionId;
    }

    for (const id of path) roots.set(id, rootId);
  }

  return roots;
}

/** Groups visible main/fork sessions with every persisted subagent descendant. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const rootsBySessionId = resolveFamilyRoots(sessions);
  const families = new Map<string, SessionFamily>();

  for (const session of sessions) {
    if (session.relation?.kind === "subagent") continue;
    families.set(session.id, {
      root: session,
      subagents: [],
      latestModified: session.modified,
    });
  }

  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const rootId = rootsBySessionId.get(session.id);
    const family = rootId ? families.get(rootId) : undefined;
    if (!family) continue;
    family.subagents.push(session);
    if (session.modified > family.latestModified) family.latestModified = session.modified;
  }

  // Pinned families float to the top (relative order still by recency).
  const pinOf = (family: SessionFamily) => (family.root.pinned ? 1 : 0);
  return [...families.values()].sort((a, b) =>
    (pinOf(b) - pinOf(a)) || b.latestModified.localeCompare(a.latestModified)
  );
}

/**
 * Pick the nearest surviving session (same project) to select after a delete.
 *
 * Orders the deleted session's project peers the same way the sidebar does
 * (pinned first, then latest modified), finds where the deleted session sat,
 * and returns the session that takes (or precedes) its slot so deleting the
 * viewed conversation never kicks the user back to a blank new-chat page.
 */
export function pickNeighborSession(
  sessions: readonly SessionInfo[],
  deletedId: string,
  cwd: string | null | undefined,
): SessionInfo | null {
  const inProject = (session: SessionInfo) =>
    session.relation?.kind !== "subagent" && (cwd ? session.cwd === cwd : !session.cwd);
  const byRecency = (a: SessionInfo, b: SessionInfo) =>
    ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    || (b.modified ?? "").localeCompare(a.modified ?? "");
  const withSelf = sessions.filter(inProject).sort(byRecency);
  const survivors = withSelf.filter((session) => session.id !== deletedId);
  if (survivors.length === 0) return null;
  const index = withSelf.findIndex((session) => session.id === deletedId);
  // Prefer the next newer session (the row above the deleted one); when the
  // deleted one was the newest (index 0) or is already absent from the
  // catalog, fall back to the closest older one. Inserting at the deleted
  // row's position on the survivor list gives exactly that.
  const insertAt = index === -1 ? 0 : index;
  return survivors[Math.max(insertAt - 1, 0)] ?? null;
}

export function getSessionFamily(
  sessions: readonly SessionInfo[],
  sessionId: string | null | undefined,
): SessionFamily | null {
  if (!sessionId) return null;
  return listSessionFamilies(sessions).find((family) => (
    family.root.id === sessionId
    || family.subagents.some((session) => session.id === sessionId)
  )) ?? null;
}

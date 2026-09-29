import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { pickNeighborSession } = await createJiti(import.meta.url).import("./session-family.ts");

function session(overrides = {}) {
  return {
    id: "s",
    name: null,
    title: null,
    firstMessage: "",
    path: "/tmp/s.jsonl",
    cwd: "/proj",
    modified: "2026-01-01T00:00:00.000Z",
    created: "2026-01-01T00:00:00.000Z",
    entryCount: 1,
    ...overrides,
  };
}

test("selects the next newer session when the deleted one had newer neighbors", () => {
  const older = session({ id: "older", modified: "2026-01-01T00:00:00.000Z" });
  const target = session({ id: "target", modified: "2026-01-02T00:00:00.000Z" });
  const newer = session({ id: "newer", modified: "2026-01-03T00:00:00.000Z" });
  assert.equal(pickNeighborSession([older, target, newer], "target", "/proj").id, "newer");
});

test("selects the previous session when the deleted one was the oldest", () => {
  const older = session({ id: "older", modified: "2026-01-01T00:00:00.000Z" });
  const target = session({ id: "target", modified: "2026-01-02T00:00:00.000Z" });
  const newer = session({ id: "newer", modified: "2026-01-03T00:00:00.000Z" });
  assert.equal(pickNeighborSession([older, target, newer], "older", "/proj").id, "target");
});

test("skips subagent sessions", () => {
  const sub = session({
    id: "sub",
    modified: "2026-01-03T00:00:00.000Z",
    relation: { kind: "subagent", parentSessionId: "newer" },
  });
  const target = session({ id: "target", modified: "2026-01-02T00:00:00.000Z" });
  assert.equal(pickNeighborSession([sub, target], "target", "/proj"), null);
  assert.equal(
    pickNeighborSession([sub, target, session({ id: "keep", modified: "2026-01-01T00:00:00.000Z" })], "target", "/proj").id,
    "keep",
  );
});

test("pinned sessions sort first, matching the sidebar order", () => {
  const target = session({ id: "target", modified: "2026-01-02T00:00:00.000Z" });
  const pinnedOld = session({ id: "pinned", modified: "2026-01-01T00:00:00.000Z", pinned: true });
  // Sorted: pinnedOld, target. Deleting target -> neighbor index clamps to sameProject[1-1]=pinnedOld.
  assert.equal(pickNeighborSession([target, pinnedOld], "target", "/proj").id, "pinned");
});

test("selects the next older session when the deleted one was the newest", () => {
  const target = session({ id: "target", modified: "2026-01-03T00:00:00.000Z" });
  const older1 = session({ id: "older1", modified: "2026-01-02T00:00:00.000Z" });
  const older2 = session({ id: "older2", modified: "2026-01-01T00:00:00.000Z" });
  // Old bug: index 0 clamped to sameProject[0] which was the deleted session
  // itself, so handleSelectSession bailed on "same session" and the user was
  // left with a dead URL and no navigation.
  assert.equal(pickNeighborSession([target, older1, older2], "target", "/proj").id, "older1");
});

test("returns the newest survivor when the deleted session is absent from the catalog", () => {
  const survivor = session({ id: "survivor", modified: "2026-01-02T00:00:00.000Z" });
  const older = session({ id: "older", modified: "2026-01-01T00:00:00.000Z" });
  assert.equal(pickNeighborSession([survivor, older], "gone", "/proj").id, "survivor");
});

test("returns null when no sibling survives in the same project", () => {
  const target = session({ id: "target" });
  const otherProject = session({ id: "other", cwd: "/elsewhere" });
  assert.equal(pickNeighborSession([target, otherProject], "target", "/proj"), null);
});

test("never returns the deleted session itself", () => {
  const target = session({ id: "target" });
  const result = pickNeighborSession([target], "target", "/proj");
  assert.equal(result, null);
});

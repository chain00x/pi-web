import assert from "node:assert/strict";
import { test } from "node:test";

// lib/subweb.ts 是 TS，用 node strip-types 直接 import（与 npm test 的 glob 匹配方式一致，
// 但 glob 只收 .test.mjs，所以这里手动指到源文件）。
const { parseAsyncSnapshotWidget, classifyRunState, formatRunDuration, formatRunActivity } =
  await import("./subweb.ts");

const snapshotLine = (snapshot) => `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`;

test("parseAsyncSnapshotWidget: 正常快照", () => {
  const snap = {
    kind: "pi-subagents.async-status", version: 1, generatedAt: 1,
    runs: [{ id: "a260b60e", kind: "single", label: "vuln-sqli", state: "running" }],
  };
  assert.deepEqual(parseAsyncSnapshotWidget([snapshotLine(snap)]), snap);
});

test("parseAsyncSnapshotWidget: 多行时取含前缀的行", () => {
  const snap = { kind: "k", version: 1, generatedAt: 1, runs: [{ id: "x", label: "y", state: "paused" }] };
  assert.deepEqual(parseAsyncSnapshotWidget(["noise", snapshotLine(snap), "more"]), snap);
});

test("parseAsyncSnapshotWidget: 无前缀/坏 JSON/空 runs/缺字段 → null", () => {
  assert.equal(parseAsyncSnapshotWidget(["hello"]), null);
  assert.equal(parseAsyncSnapshotWidget(["PI_SUBAGENT_ASYNC_JSON:{bad"]), null);
  assert.equal(parseAsyncSnapshotWidget([snapshotLine({ kind: "k", runs: [] })]), null);
  assert.equal(parseAsyncSnapshotWidget([snapshotLine({ kind: "k", runs: [{ bad: true }] })]), null);
  assert.equal(parseAsyncSnapshotWidget([]), null);
});


test("classifyRunState: complete→completed/done, failed→err, running→live, paused→idle", () => {
  assert.deepEqual(classifyRunState("complete"), { key: "completed", tone: "done" });
  assert.deepEqual(classifyRunState("completed"), { key: "completed", tone: "done" });
  assert.deepEqual(classifyRunState("failed"), { key: "failed", tone: "err" });
  assert.deepEqual(classifyRunState("timeout"), { key: "timeout", tone: "err" });
  assert.deepEqual(classifyRunState("running"), { key: "running", tone: "live" });
  assert.deepEqual(classifyRunState("paused"), { key: "paused", tone: "idle" });
  assert.deepEqual(classifyRunState(""), { key: "unknown", tone: "idle" });
});

test("formatRunDuration: s/m/h 分档", () => {
  const now = 1_000_000;
  assert.equal(formatRunDuration(now - 30_000, undefined, now), "30s");
  assert.equal(formatRunDuration(now - 12 * 60_000, undefined, now), "12m");
  assert.equal(formatRunDuration(now - 3 * 3600_000, undefined, now), "3h");
  assert.equal(formatRunDuration(undefined, undefined, now), "");
  // endedAt 早于 startedAt → 0s
  assert.equal(formatRunDuration(now, now - 5000, now), "0s");
});

test("formatRunActivity: 字符串/结构化对象/空值均归一为字符串（回归：对象直渲染会触发 React #31 崩页）", () => {
  // pi-subagents activityFor() 的真实形状
  assert.equal(
    formatRunActivity({ currentTool: "bash", lastActivityAt: 1, currentToolStartedAt: 2, turnCount: 3, toolCount: 4 }),
    "bash · 3 turns · 4 tools",
  );
  assert.equal(formatRunActivity({ state: "thinking", turnCount: 1 }), "thinking · 1 turns");
  assert.equal(formatRunActivity("running bash"), "running bash");
  assert.equal(formatRunActivity(undefined), "");
  assert.equal(formatRunActivity({}), "");
  // 非法类型不抛错
  assert.equal(formatRunActivity({ currentTool: 123 }), "");
  assert.equal(formatRunActivity({ turnCount: "x" }), "");
});

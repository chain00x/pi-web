/**
 * pi-subagents `subagent-async` widget 快照解析：
 * 供侧边栏（SubagentSidebar）渲染会话内 subagent 运行列表与状态。
 */
export const ASYNC_SNAPSHOT_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
export const SUBAGENT_ASYNC_WIDGET_KEY = "subagent-async";

/** activity 可能是字符串，也可能是 projection 的结构化对象（activityFor 输出），宽松可选字段。 */
export interface AsyncSnapshotActivity {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
}

/** 快照里的单个 run 节点（与 pi-subagents async-status-projection 对齐，宽松可选字段）。 */
export interface AsyncSnapshotRunNode {
  id: string;
  kind: string;
  label: string;
  state: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: string | AsyncSnapshotActivity;
  children?: AsyncSnapshotRunNode[];
}

export interface AsyncSnapshot {
  kind: string;
  version: number;
  generatedAt: number;
  runs: AsyncSnapshotRunNode[];
}

/** 把 activity（字符串或结构化对象）归一成单行展示文本；绝不能把对象渲染进 JSX（React #31）。 */
export function formatRunActivity(activity: AsyncSnapshotRunNode["activity"]): string {
  if (!activity) return "";
  if (typeof activity === "string") return activity;
  const parts: string[] = [];
  if (typeof activity.state === "string" && activity.state) parts.push(activity.state);
  if (typeof activity.currentTool === "string" && activity.currentTool) parts.push(activity.currentTool);
  if (typeof activity.turnCount === "number" && Number.isFinite(activity.turnCount)) parts.push(`${activity.turnCount} turns`);
  if (typeof activity.toolCount === "number" && Number.isFinite(activity.toolCount)) parts.push(`${activity.toolCount} tools`);
  return parts.join(" · ");
}

/** 从 widget 行里解析快照；不可解析（旧版/损坏/空）返回 null，调用方回退到原始文本渲染。 */
export function parseAsyncSnapshotWidget(lines: readonly string[]): AsyncSnapshot | null {
  const line = lines.find((candidate) => candidate.startsWith(ASYNC_SNAPSHOT_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(ASYNC_SNAPSHOT_PREFIX.length)) as AsyncSnapshot | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) return null;
    if (parsed.runs.length === 0) return null;
    if (typeof parsed.runs[0]?.id !== "string" || typeof parsed.runs[0]?.label !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 状态归一化 + 展示分类：live=进行中 done=正常结束 err=异常结束。 */
export function classifyRunState(state: string): { key: string; tone: "live" | "done" | "err" | "idle" } {
  switch (state) {
    case "complete":
    case "completed":
      return { key: "completed", tone: "done" };
    case "failed":
    case "timeout":
    case "cancelled":
      return { key: state, tone: "err" };
    case "stopped":
      return { key: "stopped", tone: "idle" };
    case "paused":
      return { key: "paused", tone: "idle" };
    case "running":
    case "awaiting_input":
      return { key: state, tone: "live" };
    default:
      return { key: state || "unknown", tone: "idle" };
  }
}

/** 时长文本：startedAt→(endedAt|now)。 */
export function formatRunDuration(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  if (!startedAt) return "";
  const total = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  if (total < 90) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

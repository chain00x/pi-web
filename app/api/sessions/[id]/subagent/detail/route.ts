import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";

/**
 * subagent 运行详情：读取 pi-subagents 异步 run 目录里的 status.json
 * 与 output-*.log 尾部，供侧边栏详情视图轮询展示。
 * 只允许读取属于当前会话（路由 [id]）的 run。
 */

const TAIL_BYTES = 16 * 1024;
const TRANSCRIPT_MAX_ITEMS = 20000;
const TRANSCRIPT_MAX_TEXT = 100000; // 与主对话 SafeMarkdownBody 同款上限
const TRANSCRIPT_READ_BYTES = 12 * 1024 * 1024; // 极端保护：超过则只读尾部窗口

function runRoots(): string[] {
  const out: string[] = [];
  let base: string[];
  try {
    base = readdirSync(tmpdir());
  } catch {
    return out;
  }
  for (const d of base) {
    if (!d.startsWith("pi-subagents-")) continue;
    const runs = join(tmpdir(), d, "async-subagent-runs");
    if (existsSync(runs)) out.push(runs);
  }
  return out;
}

function findRunDir(runId: string): string | undefined {
  if (!/^[a-f0-9-]{8,64}$/i.test(runId)) return undefined;
  for (const root of runRoots()) {
    const dir = join(root, runId);
    if (existsSync(join(dir, "status.json"))) return dir;
  }
  return undefined;
}

/** status.json 的 sessionId 是会话文件路径：…/<ISO>_<uuid>.jsonl */
function sessionFileBelongsTo(sessionFilePath: string | undefined, sessionId: string): boolean {
  if (!sessionFilePath) return false;
  return basename(sessionFilePath).endsWith(`_${sessionId}.jsonl`);
}

interface RunSummary {
  runId: string;
  label: string;
  agent?: string;
  state: string;
  mode?: string;
  startedAt?: number;
  endedAt?: number;
  totalTokens?: number;
}

/** 归属当前会话的全部历史 run（扫 status.json，不依赖 live widget 快照）。 */
function listRunsForSession(sessionId: string): RunSummary[] {
  const out: RunSummary[] = [];
  for (const root of runRoots()) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[a-f0-9-]{8,64}$/i.test(name)) continue;
      const statusPath = join(root, name, "status.json");
      if (!existsSync(statusPath)) continue;
      try {
        const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
        // workflow 组合 run（runs.all 容器）：无自身会话/输出，子任务各有 run 目录，不单独立行
        if (status.mode === "workflow") continue;
        if (!sessionFileBelongsTo(status.sessionId as string | undefined, sessionId)) continue;
        const steps = Array.isArray(status.steps) ? (status.steps as Array<Record<string, unknown>>) : [];
        const first = steps[0] ?? {};
        out.push({
          runId: (status.runId as string) ?? name,
          label: (first.sessionName as string) ?? name.slice(0, 8),
          agent: first.agent as string | undefined,
          state: (status.state as string) ?? "unknown",
          mode: status.mode as string | undefined,
          startedAt: status.startedAt as number | undefined,
          endedAt: status.endedAt as number | undefined,
          totalTokens: status.totalTokens as number | undefined,
        });
      } catch {
        // 单个 status.json 损坏不影响其余
      }
    }
  }
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out;
}

interface TranscriptItem {
  role: string;
  kind: string;
  name?: string;
  text: string;
  args?: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  callId?: string;
  mid?: string; // 所属 message id：前端按它把同一轮的 thinking/text/toolCall 合并成一条消息
}

/** 从工具入参中提炼一个简短的行内摘要（命令/路径/URL 等），用于折叠行展示。 */
function argsPreview(input: unknown): string {
  if (!input || typeof input !== "object") {
    return typeof input === "string" ? input.replace(/\s+/g, " ").slice(0, 80) : "";
  }
  const args = input as Record<string, unknown>;
  const pick = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? ""));
  const preferred = ["command", "path", "file_path", "file", "pattern", "url", "query", "cmd"];
  for (const key of preferred) {
    if (typeof args[key] === "string" && (args[key] as string).trim()) {
      return (args[key] as string).replace(/\s+/g, " ").slice(0, 80);
    }
  }
  const first = Object.entries(args)[0];
  if (!first) return "";
  return `${first[0]}=${pick(first[1])}`.replace(/\s+/g, " ").slice(0, 80);
}

/** 序列化后截断，避免超大工具入参撑爆 detail 响应（仅用于展示）。 */
function clipSerialized(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  try {
    const json = JSON.stringify(value ?? {});
    if (json.length <= max) return value;
    return { _truncated: true, preview: `${json.slice(0, max)}…` };
  } catch {
    return String(value);
  }
}

/** status 里的会话文件定位：顶层字段缺失时回退 steps[0].sessionFile / transcriptPath。 */
function resolveSessionFile(status: Record<string, unknown>): string | undefined {
  const direct = status.sessionFile;
  if (typeof direct === "string" && direct) return direct;
  const steps = Array.isArray(status.steps) ? (status.steps as Array<Record<string, unknown>>) : [];
  for (const step of steps) {
    for (const key of ["sessionFile", "transcriptPath"] as const) {
      const value = step[key];
      if (typeof value === "string" && value.endsWith(".jsonl") && existsSync(value)) return value;
    }
  }
  return undefined;
}

function clip(text: string, max = TRANSCRIPT_MAX_TEXT): string {
  const clean = text.replace(/[ \t]+\n/g, "\n").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 读子代理会话 jsonl 尾部，抽取可读对话（主输出 + 可折叠工具调用）。 */
function transcriptOf(sessionFile: unknown): { items: TranscriptItem[]; truncated: boolean } {
  if (typeof sessionFile !== "string" || !sessionFile.endsWith(".jsonl") || !existsSync(sessionFile)) {
    return { items: [], truncated: false };
  }
  // 默认即完整：主对话同款体验；仅超大文件时退化为尾部窗口（极端保护）
  const maxText = TRANSCRIPT_MAX_TEXT;
  const maxResult = 20000;
  const maxInput = 65536;
  const maxItems = TRANSCRIPT_MAX_ITEMS;
  let raw: string;
  let truncatedStart = false;
  try {
    const buf = readFileSync(sessionFile);
    if (buf.length > TRANSCRIPT_READ_BYTES) {
      raw = buf.subarray(buf.length - TRANSCRIPT_READ_BYTES).toString("utf8");
      truncatedStart = true;
    } else {
      raw = buf.toString("utf8");
    }
  } catch {
    return { items: [], truncated: false };
  }
  const lines = raw.split("\n");
  if (truncatedStart && lines.length > 1) lines.shift(); // 仅截断窗口的首行大概率不完整
  const items: TranscriptItem[] = [];
  const byCallId = new Map<string, TranscriptItem>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const role = String(message.role ?? "?");
    const mid = typeof entry.id === "string" ? entry.id : undefined;
    if (role === "toolResult") {
      // 工具结果：配对进对应的 toolCall 条目，不独立成行
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      const resultText = content
        .filter((block) => typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n");
      const isError = message.isError === true;
      const target = callId ? byCallId.get(callId) : undefined;
      if (target) {
        target.result = clip(resultText, maxResult);
        if (isError) target.isError = true;
      } else {
        items.push({ role, kind: "tool", name: toolName, text: "", result: clip(resultText, maxResult), isError, mid });
      }
      continue;
    }
    const content = message.content;
    const blocks = Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
      : [{ type: "text", text: String(content ?? "") }];
    for (const block of blocks) {
      const kind = String(block.type ?? "");
      if (kind === "text" && typeof block.text === "string" && block.text.trim()) {
        items.push({ role, kind: "text", text: clip(block.text, maxText), mid });
      } else if (kind === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        // 思考块：与主对话一致，折叠展示
        items.push({ role, kind: "thinking", text: clip(block.thinking, maxText), mid });
      } else if (kind === "toolCall") {
        const input = block.arguments ?? block.input ?? block.partialInput;
        const callId = typeof block.id === "string" ? block.id : undefined;
        const item: TranscriptItem = {
          role,
          kind: "tool",
          name: typeof block.name === "string" ? block.name : undefined,
          text: clip(typeof input === "string" ? input : JSON.stringify(input ?? {}), 200),
          args: argsPreview(input),
          input: clipSerialized(input, maxInput),
          callId,
          mid,
        };
        items.push(item);
        if (callId) byCallId.set(callId, item);
      } else if (kind === "image") {
        items.push({ role, kind: "image", text: "[image]", mid });
      }
      // 其它块型（如 redacted_thinking）不展示
    }
  }
  return { items: items.slice(-maxItems), truncated: truncatedStart };
}

function tailOfFiles(dir: string): { tail: string; truncated: boolean } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /^output-\d+\.log$/.test(f)).sort();
  } catch {
    return { tail: "", truncated: false };
  }
  let buf = "";
  for (const name of names) {
    const p = join(dir, name);
    try {
      const size = statSync(p).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const fh = readFileSync(p);
      buf += fh.subarray(start).toString("utf8");
      if (start > 0) buf += `\n…[output-${name} 前段已截断]\n`;
    } catch {
      // 单文件读取失败跳过
    }
  }
  const truncated = buf.length > TAIL_BYTES;
  return {
    tail: truncated ? buf.slice(-TAIL_BYTES) : buf,
    truncated,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(_req.url);

  if (url.searchParams.get("list") === "1") {
    return NextResponse.json({ ok: true, runs: listRunsForSession(id) });
  }

  const runId = url.searchParams.get("run") ?? "";
  const dir = findRunDir(runId);
  if (!dir) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  let status: Record<string, unknown> = {};
  try {
    status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Status unreadable" }, { status: 500 });
  }

  if (!sessionFileBelongsTo(status.sessionId as string | undefined, id)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const steps = Array.isArray(status.steps) ? (status.steps as Array<Record<string, unknown>>) : [];
  const label = typeof steps[0]?.sessionName === "string" ? (steps[0].sessionName as string) : runId.slice(0, 8);
  const { tail, truncated } = tailOfFiles(dir);
  const { items: transcript, truncated: transcriptTruncated } = transcriptOf(resolveSessionFile(status));

  return NextResponse.json({
    runId,
    label,
    agent: typeof steps[0]?.agent === "string" ? (steps[0].agent as string) : undefined,
    state: status.state,
    mode: status.mode,
    startedAt: status.startedAt,
    endedAt: status.endedAt,
    lastActivityAt: status.lastActivityAt,
    steering: status.steering,
    totalTokens: status.totalTokens,
    turnCount: status.turnCount,
    toolCount: status.toolCount,
    tail,
    truncated,
    transcript,
    transcriptTruncated,
  });
}

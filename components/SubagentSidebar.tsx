"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import {
  classifyRunState,
  formatRunActivity,
  formatRunDuration,
  type AsyncSnapshotRunNode,
} from "@/lib/subweb";
import { fetchWithTimeout } from "./ExtensionStatusBar";
import { MessageView } from "./MessageView";
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage } from "@/lib/types";

/**
 * 会话内 subagent 侧边栏（Claude Code 风格）：
 * - dock 模式：右侧固定宽度面板，与聊天并列
 * - 全屏模式：portal 覆盖整个视口，左列表 + 右详情双栏
 * 数据：runs 来自 pi-subagents async widget 快照；详情/输出尾部由
 * /api/sessions/[id]/subagent/detail 轮询；插话/停止/恢复走
 * /api/sessions/[id]/subagent（邮箱桥 → 拥有者会话进程）。
 */

interface DetailData {
  runId: string;
  label?: string;
  agent?: string;
  state?: string;
  mode?: string;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  steering?: { requested?: number; delivered?: number; pending?: number; failed?: number };
  tail?: string;
  truncated?: boolean;
  transcript?: TranscriptItem[];
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
  mid?: string;
}

/** 把扁平 transcript items 重组为主对话同款的消息序列 + 工具结果配对表。 */
function buildTranscriptMessages(items: TranscriptItem[]): {
  messages: AgentMessage[];
  toolResults: Map<string, ToolResultMessage>;
} {
  const messages: AgentMessage[] = [];
  const toolResults = new Map<string, ToolResultMessage>();
  // 与主对话一致：同一轮（同 messageId）的 thinking/text/toolCall 合并为一条 assistant 消息
  let group: { role: string; mid?: string; content: AssistantMessage["content"] } | null = null;
  const flush = () => {
    if (!group) return;
    if (group.content.length > 0) {
      messages.push({ role: "assistant", model: "", provider: "", content: group.content });
    }
    group = null;
  };
  const belongs = (item: TranscriptItem) =>
    group !== null && group.role === item.role && (group.mid ?? "?") === (item.mid ?? "?");
  for (const item of items) {
    if (item.kind === "tool") {
      if (!belongs(item)) flush();
      const toolCallId = item.callId ?? `orphan-${messages.length}-${item.name ?? "tool"}`;
      const callBlock = {
        type: "toolCall" as const,
        toolCallId,
        toolName: item.name || "tool",
        input: typeof item.input === "object" && item.input !== null
          ? item.input as Record<string, unknown>
          : {},
      };
      if (group) group.content.push(callBlock);
      else group = { role: item.role, mid: item.mid, content: [callBlock] };
      if (item.result !== undefined) {
        toolResults.set(toolCallId, {
          role: "toolResult",
          toolCallId,
          toolName: item.name || "tool",
          content: [{ type: "text", text: item.result }],
          isError: item.isError,
        });
      }
      continue;
    }
    if (item.kind === "image") {
      flush();
      messages.push({ role: "user", content: item.text || "[image]" });
      continue;
    }
    if (item.kind === "thinking") {
      if (!belongs(item)) flush();
      const thinkBlock = { type: "thinking" as const, thinking: item.text };
      if (group) group.content.push(thinkBlock);
      else group = { role: item.role, mid: item.mid, content: [thinkBlock] };
      continue;
    }
    if (item.role === "user") {
      flush();
      const msg: UserMessage = { role: "user", content: item.text };
      messages.push(msg);
    } else {
      if (!belongs(item)) flush();
      const textBlock = { type: "text" as const, text: item.text };
      if (group) group.content.push(textBlock);
      else group = { role: item.role, mid: item.mid, content: [textBlock] };
    }
  }
  flush();
  return { messages, toolResults };
}
interface HistoryRun {
  runId: string;
  label: string;
  agent?: string;
  state: string;
  mode?: string;
  startedAt?: number;
  endedAt?: number;
}

interface FlatRun {
  run: AsyncSnapshotRunNode;
  depth: number;
}

function flattenRuns(runs: AsyncSnapshotRunNode[], depth = 0, out: FlatRun[] = []): FlatRun[] {
  for (const run of runs) {
    // UUID 节点自身就是可查看的 run（single run 也可能带 children=live step 子节点），
    // 有独立 run 目录就进列表；子任务递归下移一层。非 UUID 聚合节点（workflow 容器/
    // step:N）无自身会话，不进列表，只上提子任务。
    if (RUN_ID_RE.test(run.id) && !out.some((existing) => existing.run.id === run.id)) {
      out.push({ run, depth });
    }
    if (run.children?.length) flattenRuns(run.children, depth + 1, out);
  }
  return out;
}

type SubagentAction = "steer" | "stop" | "resume";
const RUN_ID_RE = /^[a-f0-9-]{8,64}$/i;

export function SubagentSidebar({
  sessionId,
  runs,
  open,
  fullscreen,
  onOpenChange,
  onFullscreenChange,
}: {
  sessionId: string;
  runs: AsyncSnapshotRunNode[];
  open: boolean;
  fullscreen: boolean;
  onOpenChange: (open: boolean) => void;
  onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const { t } = useI18n();
  const [historyRuns, setHistoryRuns] = useState<HistoryRun[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  // widget 快照只覆盖本会话进行中的 run；历史 run 由服务端扫 status.json 得出。
  // 打开时拉一次，之后每 15s 轻量刷新；widget 与历史按 runId 去重（widget 优先）。
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    const load = (): void => {
      fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/subagent/detail?list=1`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((json: { runs?: HistoryRun[] } | null) => {
          if (!cancelled && json?.runs) {
            setHistoryRuns(json.runs);
            setListError(null);
          } else if (!cancelled) {
            setListError("error");
          }
        })
        .catch(() => {
          // 连接池耗尽/超时：保留上次数据，标记错误态（下一次 15s 轮询自愈）
          if (!cancelled) setListError((e) => e ?? "error");
        });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, sessionId]);

  // 列表以 list API（status.json 具体目录）为主体；widget 快照仅按 runId 提供 live 状态补充。
  // widget 树的聚合节点（非 UUID id，如多 run 合并行）不进列表，避免点击后 detail 404。
  const mergedRuns: AsyncSnapshotRunNode[] = (() => {
    const widgetById = new Map<string, AsyncSnapshotRunNode>();
    const walk = (nodes: AsyncSnapshotRunNode[]): void => {
      for (const run of nodes) {
        if (RUN_ID_RE.test(run.id) && !widgetById.has(run.id)) widgetById.set(run.id, run);
        if (run.children?.length) walk(run.children);
      }
    };
    walk(runs);
    const listed = historyRuns.map(
      (run) =>
        widgetById.get(run.runId) ?? {
          id: run.runId,
          kind: "async",
          label: run.label,
          state: run.state,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          activity: "",
        } satisfies AsyncSnapshotRunNode,
    );
    const listedIds = new Set(historyRuns.map((run) => run.runId));
    const extras = [...widgetById.entries()]
      .filter(([runId]) => !listedIds.has(runId))
      .sort((a, b) => (b[1].startedAt ?? 0) - (a[1].startedAt ?? 0))
      .map(([, run]) => run);
    return [...extras, ...listed];
  })();
  const flat = flattenRuns(mergedRuns);
  const liveCount = flat.filter(({ run }) => classifyRunState(run.state).tone === "live").length;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<{ ok: boolean; text: string } | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // 上一次渲染后对话流的位置（判断用户是否主动上滑，不依赖 scroll 事件）
  const prevPosRef = useRef<{ top: number; height: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // transcript 重组为主对话同款消息序列（MessageView 渲染）
  const transcriptView = useMemo(
    () => detail?.transcript
      ? buildTranscriptMessages(detail.transcript)
      : { messages: [] as AgentMessage[], toolResults: new Map<string, ToolResultMessage>() },
    [detail?.transcript],
  );

  // 默认选中：当前选中失效时选第一个 live，否则第一个（跳过无 run 目录的聚合节点已由 flatten 保证）
  useEffect(() => {
    if (flat.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && flat.some(({ run }) => run.id === selectedId)) return;
    const firstLive = flat.find(({ run }) => classifyRunState(run.state).tone === "live");
    setSelectedId((firstLive ?? flat[0]).run.id);
  }, [flat, selectedId]);

  // 列表项显示：剥掉 "agent: " 前缀，任务正文更有信息量
  const displayLabel = (label: string): string => label.replace(/^[A-Za-z][\w-]{0,31}:\s*/, "");

  const fetchDetail = useCallback(async (runId: string) => {
    if (!RUN_ID_RE.test(runId)) {
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    try {
      const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/subagent/detail?run=${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (!res.ok) {
        setDetailError(`HTTP ${res.status}`);
        return;
      }
      setDetail((await res.json()) as DetailData);
      setDetailError(null);
    } catch (error) {
      setDetailError(String(error));
    } finally {
      setDetailLoading(false);
    }
  }, [sessionId]);

  // 轮询详情（完整对话模式下暂停：全量解析重，且快照不再变化）
  useEffect(() => {
    if (!open || !selectedId) return;
    prevPosRef.current = null;
    setDetailLoading(true);
    void fetchDetail(selectedId);
    pollRef.current = setInterval(() => void fetchDetail(selectedId), 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, selectedId, fetchDetail]);

  // 输出区跟随滚动到底部
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.tail, selectedId]);

  // 对话流跟随滚动：位置自检而非 scroll 事件。
  // 规则：上次贴底且未上滑 → 跟随；用户上滑 → 停；用户滑回底部附近 → 恢复跟随；切 run → 强制贴底
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const prev = prevPosRef.current;
    let follow = true;
    if (prev) {
      const wasAtBottom = prev.height - prev.top - el.clientHeight < 60;
      const scrolledUp = el.scrollTop < prev.top - 4;
      follow = wasAtBottom ? !scrolledUp : el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }
    if (follow) el.scrollTop = el.scrollHeight;
    prevPosRef.current = { top: el.scrollTop, height: el.scrollHeight };
  }, [detail?.transcript, selectedId]);

  useEffect(() => {
    if (!selectedId) setDetail(null);
  }, [selectedId]);

  const selected = flat.find(({ run }) => run.id === selectedId)?.run ?? null;
  const selectedTone = selected ? classifyRunState(selected.state).tone : "done";
  const selectedTerminal = selectedTone !== "live" && selectedTone !== "idle";

  async function call(action: SubagentAction) {
    if (!selected || busy) return;
    if ((action === "steer" || action === "resume") && !message.trim()) return;
    setBusy(true);
    setReceipt(null);
    try {
      const res = await fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/subagent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, runId: selected.id, message: message.trim() }),
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (json.ok) {
        setReceipt({
          ok: true,
          text: t(action === "stop" ? "chat.subagentStopSent" : action === "resume" ? "chat.subagentResumed" : "chat.subagentSent"),
        });
        if (action !== "stop") setMessage("");
        if (selectedId) void fetchDetail(selectedId);
      } else {
        setReceipt({ ok: false, text: `${t("chat.subagentFailed")}: ${json.error?.message ?? `HTTP ${res.status}`}` });
      }
    } catch (error) {
      setReceipt({ ok: false, text: `${t("chat.subagentFailed")}: ${String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const body = (
    <div
      className={`subagent-sidebar${fullscreen ? " is-fullscreen" : ""}`}
      role="complementary"
      aria-label={t("chat.subagentPanelTitle")}
    >
      <div className="subagent-sidebar-header">
        <span className="subagent-sidebar-title">{t("chat.subagentPanelTitle")}</span>
        {liveCount > 0 && (
          <span className="subagent-sidebar-live-badge">
            {t("chat.subagentLiveCount", { count: liveCount })}
          </span>
        )}
        <span className="subagent-sidebar-spacer" />
        <button
          type="button"
          className="subagent-sidebar-icon-btn"
          title={fullscreen ? t("chat.subagentPanelExitFullscreen") : t("chat.subagentPanelFullscreen")}
          aria-label={fullscreen ? t("chat.subagentPanelExitFullscreen") : t("chat.subagentPanelFullscreen")}
          onClick={() => onFullscreenChange(!fullscreen)}
        >
          {fullscreen ? "⤡" : "⤢"}
        </button>
        <button
          type="button"
          className="subagent-sidebar-icon-btn"
          title={t("chat.subagentPanelClose")}
          aria-label={t("chat.subagentPanelClose")}
          onClick={() => { onOpenChange(false); onFullscreenChange(false); }}
        >
          ✕
        </button>
      </div>

      {flat.length === 0 ? (
        <div className="subagent-sidebar-empty">
          {listError && historyRuns.length === 0 ? t("chat.subagentListError") : t("chat.subagentPanelEmpty")}
        </div>
      ) : fullscreen ? (
        <div className="subagent-sidebar-columns">
          <div className="subagent-sidebar-list" role="list">
            {flat.map(({ run, depth }) => {
              const { key: stateKey, tone } = classifyRunState(run.state);
              const duration = formatRunDuration(run.startedAt, run.endedAt, Date.now());
              return (
                <button
                  key={run.id}
                  type="button"
                  role="listitem"
                  className={`subagent-sidebar-item tone-${tone} st-${stateKey}${run.id === selectedId ? " is-selected" : ""}`}
                  style={depth > 0 ? { paddingLeft: `${10 + depth * 16}px` } : undefined}
                  onClick={() => setSelectedId(run.id)}
                >
                  <span className="subagent-run-dot" aria-hidden="true" />
                  <span className="subagent-sidebar-item-label">{displayLabel(run.label)}</span>
                  <span className="subagent-sidebar-item-state">{run.state}</span>
                </button>
              );
            })}
          </div>
          <div className="subagent-sidebar-detail">{renderDetail()}</div>
        </div>
      ) : (
        <>
          <div className="subagent-sidebar-list" role="list">
            {flat.map(({ run, depth }) => {
              const { key: stateKey, tone } = classifyRunState(run.state);
              return (
                <button
                  key={run.id}
                  type="button"
                  role="listitem"
                  className={`subagent-sidebar-item tone-${tone} st-${stateKey}${run.id === selectedId ? " is-selected" : ""}`}
                  style={depth > 0 ? { paddingLeft: `${10 + depth * 16}px` } : undefined}
                  onClick={() => setSelectedId(run.id)}
                >
                  <span className="subagent-run-dot" aria-hidden="true" />
                  <span className="subagent-sidebar-item-label">{displayLabel(run.label)}</span>
                  <span className="subagent-sidebar-item-state">{run.state}</span>
                </button>
              );
            })}
          </div>
          <div className="subagent-sidebar-detail">{renderDetail()}</div>
        </>
      )}
    </div>
  );

  function renderDetail() {
    if (!selected) return <div className="subagent-sidebar-empty">{t("chat.subagentPanelEmpty")}</div>;
    const duration = formatRunDuration(selected.startedAt, selected.endedAt, Date.now());
    return (
      <>
        <div className="subagent-sidebar-detail-head">
          <span className={`subagent-run-dot tone-${selectedTone}`} aria-hidden="true" />
          <span className="subagent-sidebar-detail-title">{displayLabel(selected.label)}</span>
          {duration && <span className="subagent-sidebar-detail-duration">{duration}</span>}
        </div>
        <div className="subagent-sidebar-detail-meta">
          <span>{selected.state}</span>
          <span>{formatRunActivity(selected.activity)}</span>
          {detail?.steering && detail.steering.delivered ? (
            <span>{t("chat.subagentSteeredCount", { count: detail.steering.delivered })}</span>
          ) : null}
        </div>
        {detail?.transcript && detail.transcript.length > 0 ? (
          <div className="subagent-tx" ref={transcriptRef} aria-label={t("chat.subagentTranscript")}>
            <div className="subagent-tx-title">
              {t("chat.subagentTranscript")}
            </div>
            {transcriptView.messages.map((message, index) => (
              <MessageView
                key={index}
                message={message}
                toolResults={transcriptView.toolResults}
              />
            ))}
          </div>
        ) : (
          <div className="subagent-tx subagent-tx-empty">{detailLoading ? "…" : t("chat.subagentTranscriptEmpty")}</div>
        )}
        <details className="subagent-output-fold">
          <summary>
            {t("chat.subagentOutput")}
            {detail?.truncated ? <span className="subagent-output-fold-note">16KB</span> : null}
          </summary>
          <pre ref={outputRef} className="subagent-sidebar-output" aria-label={t("chat.subagentOutput")}>
            {detail?.tail ? detail.tail : detailLoading ? "…" : t("chat.subagentNoOutput")}
          </pre>
          {detail?.truncated && (
            <div className="subagent-sidebar-truncated">{t("chat.subagentOutputTruncated")}</div>
          )}
        </details>
        {detailError && <div className="subagent-run-receipt err">{detailError}</div>}
        <div className="subagent-sidebar-actions">
          {!selectedTerminal && (
            <button
              type="button"
              className="subagent-run-btn danger"
              disabled={busy}
              onClick={() => void call("stop")}
            >
              {t("chat.subagentStop")}
            </button>
          )}
          <textarea
            className="subagent-run-input"
            rows={2}
            value={message}
            placeholder={selectedTerminal ? t("chat.subagentResumePlaceholder") : t("chat.subagentSteerPlaceholder")}
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void call(selectedTerminal ? "resume" : "steer");
              }
            }}
          />
          <button
            type="button"
            className="subagent-run-btn"
            disabled={busy || !message.trim()}
            onClick={() => void call(selectedTerminal ? "resume" : "steer")}
          >
            {busy ? "…" : selectedTerminal ? t("chat.subagentResume") : t("chat.subagentSteer")}
          </button>
        </div>
        {receipt && (
          <div className={`subagent-run-receipt${receipt.ok ? " ok" : " err"}`}>{receipt.text}</div>
        )}
      </>
    );
  }

  if (fullscreen && typeof document !== "undefined") {
    return createPortal(body, document.body);
  }
  return body;
}

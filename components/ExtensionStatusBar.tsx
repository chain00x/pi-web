"use client";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { SUBAGENT_ASYNC_WIDGET_KEY, isSubagentWidgetKey } from "@/lib/subweb";
import { useI18n } from "@/hooks/useI18n";
import { useEffect, useState } from "react";

/**
 * Chrome 对同一 HTTP/1.1 host 限制 6 个连接；每个打开的 Pi Web 标签页各占一条 SSE 长连接，
 * 一旦有请求挂死占满连接池，后续所有 fetch（含 SSE 重连）都会无限排队 → 页面呈「不稳定/offline」。
 * 所以所有辅助 fetch 必须带超时：挂死请求最多占用 8s 后自动让出连接，连接池自愈。
 */
export function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 8_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}


export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  onOpenSubagents,
  sessionId,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  onOpenSubagents?: () => void;
  sessionId?: string;
}) {
  const { t } = useI18n();
  // 有 subagent 类 widget（async 快照或新版 fleet 状态）就显示常驻入口；否则只在有历史 run 时显示
  const pillVisible = widgets.some((widget) => isSubagentWidgetKey(widget.key));
  const [hasHistory, setHasHistory] = useState(false);
  useEffect(() => {
    setHasHistory(false);
    if (pillVisible || !sessionId) return;
    let cancelled = false;
    fetchWithTimeout(`/api/sessions/${encodeURIComponent(sessionId)}/subagent/detail?list=1`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { runs?: unknown[] } | null) => {
        if (!cancelled) setHasHistory(Array.isArray(json?.runs) && json.runs.length > 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pillVisible, sessionId]);
  if (statuses.length === 0 && widgets.length === 0 && !onOpenSubagents) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);
  const hasStatusText = statuses.length > 0 && plainStatusLine.trim().length > 0;
  // 无 live pill、无有效状态文本、无历史入口时完全不渲染（不占位）
  if (!pillVisible && !hasStatusText && !hasHistory) return null;

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {widgets.length > 0 && <ExtensionWidgets widgets={widgets} onOpenSubagents={onOpenSubagents} />}
      {onOpenSubagents && widgets.every((widget) => widget.key !== SUBAGENT_ASYNC_WIDGET_KEY) && hasHistory && (
        <div className="extension-widget-triggers subagent-entry" aria-label={t("chat.extensionWidgets")}>
          <button
            type="button"
            className="extension-widget-trigger"
            title="subagent-async"
            onClick={onOpenSubagents}
          >
            <span className="extension-widget-placement" aria-hidden="true">
              <svg
                className="extension-widget-placement-icon"
                viewBox="0 0 8 6"
                width="8"
                height="6"
                data-direction="down"
                focusable="false"
              >
                <path d="M0 0h8L4 6z" />
              </svg>
            </span>
            <span className="extension-widget-key">subagent-async</span>
          </button>
        </div>
      )}
      {hasStatusText && (
        <div
          role="status"
          className="extension-status-line"
          aria-label={plainStatusLine}
          title={plainStatusLine}
        >
          <span className="extension-status-text">
            <AnsiText text={statusLine} />
          </span>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AnsiText } from "@/components/AnsiText";
import type { ExtensionWidgetItem } from "@/lib/types";
import {
  isSubagentWidgetKey,
} from "@/lib/subweb";

export const DEFAULT_EXPANDED_WIDGET_LINES = 3;
export const WIDGET_UPDATE_IDLE_MS = 1100;

export function formatExtensionWidgetContent(lines: string[]): string {
  return lines.join("\n");
}

export function snapshotExtensionWidgetContents(
  widgets: ExtensionWidgetItem[],
): Map<string, string[]> {
  return new Map(widgets.map((widget) => [widget.key, [...widget.lines]]));
}

export function getUpdatedExtensionWidgetKeys(
  previous: ReadonlyMap<string, readonly string[]> | null,
  next: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!previous) return [];
  return Array.from(next, ([key, lines]) => {
    const previousLines = previous.get(key);
    if (!previousLines || previousLines.length !== lines.length) {
      return previousLines ? key : null;
    }
    return lines.some((line, index) => line !== previousLines[index]) ? key : null;
  }).filter((key): key is string => key !== null);
}

function getDefaultExpandedWidgetKey(widgets: ExtensionWidgetItem[]): string | null {
  // subagent-async 已迁至侧边栏，不再参与默认展开
  return widgets.find((widget) => {
    if (widget.key.startsWith("file:")) return false;
    const lineCount = widget.lines.length;
    return lineCount > 1 && lineCount <= DEFAULT_EXPANDED_WIDGET_LINES;
  })?.key ?? null;
}

export function getNextExpandedWidgetKey(
  currentKey: string | null,
  requestedKey: string,
): string | null {
  return currentKey === requestedKey ? null : requestedKey;
}

/**
 * 「文件 chip」约定（vuln-hunt 等扩展使用）：
 *   key    = `file:<绝对路径>`        ← 稳定标识，计数变化不改 key（避免 chip 顺序抖动）
 *   lines  = [显示文本, "unread:<n>", ...]
 * 点击 = 在右侧面板打开该文件（onOpenFile），并上报「已读」水位。
 */
export interface FileChipSpec {
  path: string;
  label: string;
  unread: number;
}

export function parseFileChip(widget: { key: string; lines: string[] }): FileChipSpec | null {
  if (!widget.key.startsWith("file:")) return null;
  const path = widget.key.slice(5).trim();
  if (!path.startsWith("/")) return null;
  const label = (widget.lines[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim()
    || path.split("/").pop()
    || path;
  const unread = Number.parseInt((widget.lines[1] ?? "").replace(/[^0-9]/g, ""), 10);
  return { path, label, unread: Number.isFinite(unread) && unread > 0 ? unread : 0 };
}

export function markFileChipSeen(path: string): void {
  try {
    void fetch("/api/vuln-hunt/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).catch(() => {});
  } catch {
    // 静默：只是水位记录
  }
}

export function ExtensionWidgets({ widgets, onOpenSubagents, onOpenFile, onToggleFile }: { widgets: ExtensionWidgetItem[]; onOpenSubagents?: () => void; onOpenFile?: (filePath: string) => void; onToggleFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const idPrefix = useId();
  const previousContentsRef = useRef<Map<string, string[]> | null>(null);
  const updateClearTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [expandedWidgetKey, setExpandedWidgetKey] = useState<string | null>(
    () => getDefaultExpandedWidgetKey(widgets),
  );
  const [updatingWidgetKeys, setUpdatingWidgetKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const nextContents = snapshotExtensionWidgetContents(widgets);
    const updatedKeys = getUpdatedExtensionWidgetKeys(
      previousContentsRef.current,
      nextContents,
    );
    previousContentsRef.current = nextContents;

    for (const [key, timer] of updateClearTimersRef.current) {
      if (nextContents.has(key)) continue;
      clearTimeout(timer);
      updateClearTimersRef.current.delete(key);
    }

    setUpdatingWidgetKeys((current) => {
      const next = new Set(Array.from(current).filter((key) => nextContents.has(key)));
      for (const key of updatedKeys) next.add(key);
      if (
        next.size === current.size
        && Array.from(next).every((key) => current.has(key))
      ) return current;
      return next;
    });

    for (const key of updatedKeys) {
      const currentTimer = updateClearTimersRef.current.get(key);
      if (currentTimer) clearTimeout(currentTimer);
      updateClearTimersRef.current.set(key, setTimeout(() => {
        updateClearTimersRef.current.delete(key);
        setUpdatingWidgetKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }, WIDGET_UPDATE_IDLE_MS));
    }
  }, [widgets]);

  useEffect(() => () => {
    for (const timer of updateClearTimersRef.current.values()) clearTimeout(timer);
    updateClearTimersRef.current.clear();
  }, []);

  if (widgets.length === 0) return null;

  const expandedWidget = widgets.find((widget) => (
    widget.key === expandedWidgetKey
    && widget.lines.length > 0
  ));

  const toggleWidget = (widget: ExtensionWidgetItem) => {
    // subagent 运行面板已迁至侧边栏：点 pill 直达，不再展开内嵌面板
    if (isSubagentWidgetKey(widget.key)) {
      onOpenSubagents?.();
      return;
    }
    setExpandedWidgetKey((current) => getNextExpandedWidgetKey(current, widget.key));
  };

  return (
    <>
      {expandedWidget && (
        <div className="extension-widget-panels">
          {(() => {
            const widget = expandedWidget;
            const index = widgets.indexOf(widget);
            const triggerId = `${idPrefix}-trigger-${index}`;
            const panelId = `${idPrefix}-panel-${index}`;
            return (
              <section
                key={widget.key}
                id={panelId}
                className="extension-widget-panel"
                aria-labelledby={triggerId}
              >
                <div className="extension-widget-panel-heading">{widget.key}</div>
                <pre className="extension-widget-content">
                  <AnsiText text={formatExtensionWidgetContent(widget.lines)} />
                </pre>
              </section>
            );
          })()}
        </div>
      )}
      <div className="extension-widget-triggers" aria-label={t("chat.extensionWidgets")}>
        {widgets.map((widget, index) => {
          const fileChip = parseFileChip(widget);
          if (fileChip) {
            const updatingFile = updatingWidgetKeys.has(widget.key);
            return (
              <button
                key={widget.key}
                type="button"
                className={`extension-file-chip${fileChip.unread > 0 ? " has-unread" : ""}${updatingFile ? " is-updating" : ""}`}
                title={`${fileChip.path}${fileChip.unread > 0 ? `  ·  ${fileChip.unread} 条未读` : ""}`}
                onClick={() => {
                  markFileChipSeen(fileChip.path);
                  // 已打开就关闭，没打开就打开
                  if (onToggleFile) onToggleFile(fileChip.path);
                  else onOpenFile?.(fileChip.path);
                }}
              >
                <span className="extension-file-chip-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
                    <path
                      fill="currentColor"
                      d="M4 1.5h5L13 5.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Zm4.5 1.7V6h2.8L8.5 3.2Z"
                    />
                  </svg>
                </span>
                <span className="extension-file-chip-label">{fileChip.label}</span>
                {fileChip.unread > 0 && (
                  <span className="extension-file-chip-badge">{fileChip.unread}</span>
                )}
              </button>
            );
          }
          const expandable = widget.lines.length > 0;
          const expanded = expandable && widget.key === expandedWidget?.key;
          const updating = updatingWidgetKeys.has(widget.key);
          const lineCountLabel = t(
            widget.lines.length === 1 ? "chat.extensionWidgetLine" : "chat.extensionWidgetLines",
            { count: widget.lines.length },
          );
          const placementLabel = t(
            widget.placement === "belowEditor"
              ? "chat.extensionWidgetBelow"
              : "chat.extensionWidgetAbove",
          );
          const triggerId = `${idPrefix}-trigger-${index}`;
          const panelId = `${idPrefix}-panel-${index}`;
          const content = (
            <>
              <span className="extension-widget-update-pulse" aria-hidden="true" />
              <span className="extension-widget-placement" aria-hidden="true">
                <svg
                  className="extension-widget-placement-icon"
                  viewBox="0 0 8 6"
                  width="8"
                  height="6"
                  data-direction={widget.placement === "belowEditor" ? "down" : "up"}
                  focusable="false"
                >
                  <path
                    d={widget.placement === "belowEditor"
                      ? "M0 0h8L4 6z"
                      : "M4 0l4 6H0z"}
                  />
                </svg>
              </span>
              <span className="extension-widget-key">{widget.key}</span>
            </>
          );

          return expandable ? (
            <button
              key={widget.key}
              id={triggerId}
              type="button"
              className={`extension-widget-trigger${expanded ? " is-expanded" : ""}${updating ? " is-updating" : ""}`}
              aria-controls={panelId}
              aria-expanded={expanded}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel} - ${expanded ? t("i18n.collapse") : t("i18n.expand")}`}
              onClick={() => toggleWidget(widget)}
            >
              {content}
            </button>
          ) : (
            <div
              key={widget.key}
              className={`extension-widget-trigger${updating ? " is-updating" : ""}`}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel}`}
            >
              {content}
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Session pin-to-top store.
 *
 * Pinned sessions float to the top of the sidebar list. The flag is stored
 * server-side (survives across browsers/devices, unlike localStorage) in a
 * pi-web-owned file under the agent dir — outside `sessions/` so the session
 * scanner never sees it. Session transcripts are never mutated.
 *
 * Best-effort by design: a missing/corrupt file simply means nothing is
 * pinned; writes are atomic (temp file + rename) so a crash never truncates
 * the JSON.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type PinMap = Record<string, true>;

export function getSessionPinsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "session-pins.json");
}

function parsePinMap(raw: string): PinMap {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: PinMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === "string" && key.length > 0 && value === true) out[key] = true;
  }
  return out;
}

export function readSessionPins(agentDir = getAgentDir()): Set<string> {
  const path = getSessionPinsPath(agentDir);
  if (!existsSync(path)) return new Set();
  try {
    return new Set(Object.keys(parsePinMap(readFileSync(path, "utf8"))));
  } catch {
    return new Set();
  }
}

/** Set or clear the pin flag for one session id. Idempotent. */
export function setSessionPinned(sessionId: string, pinned: boolean, agentDir = getAgentDir()): void {
  const path = getSessionPinsPath(agentDir);
  let pins: PinMap = {};
  if (existsSync(path)) {
    try {
      pins = parsePinMap(readFileSync(path, "utf8"));
    } catch {
      pins = {};
    }
  }
  if (pinned) pins[sessionId] = true;
  else delete pins[sessionId];
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(pins, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Drop a session's pin if present; never throws. Used after DELETE. */
export function clearSessionPin(sessionId: string): void {
  try {
    if (readSessionPins().has(sessionId)) setSessionPinned(sessionId, false);
  } catch {
    // Best-effort cleanup only.
  }
}

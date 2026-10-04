import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";

/**
 * 会话内 subagent 控制：把命令写进 pi-subagents 控制桥的邮箱
 * （~/.pi/agent/subweb/control/<id>.json），由拥有该 run 的 pi 会话进程内的
 * subweb-bridge 扩展认领执行（steer/stop/resume 走 subagents:rpc:v1 总线），
 * 回复落在 reply/<id>.json。只操作本会话派发的 run——归属校验由桥扩展按
 * run 的 ownerSessionFile 强制执行，跨会话 run 会留在原地直到超时。
 */

const CONTROL_DIR = join(homedir(), ".pi", "agent", "subweb", "control");
const REPLY_DIR = join(homedir(), ".pi", "agent", "subweb", "reply");
const REPLY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

interface ReplyPayload {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  by?: string;
  ts?: number;
}

function atomicWrite(path: string, data: string) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await params; // 会话维度命名空间；归属由桥扩展校验
  let body: { action?: string; runId?: string; message?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: { code: "bad_body", message: "JSON body required" } }, { status: 400 });
  }

  const action = body.action;
  if (action !== "steer" && action !== "stop" && action !== "resume" && action !== "ping") {
    return NextResponse.json({ ok: false, error: { code: "bad_action", message: `不支持的操作 ${action}` } }, { status: 400 });
  }
  if (action !== "ping" && (!body.runId || typeof body.runId !== "string")) {
    return NextResponse.json({ ok: false, error: { code: "bad_run", message: "runId required" } }, { status: 400 });
  }

  try {
    mkdirSync(CONTROL_DIR, { recursive: true });
    mkdirSync(REPLY_DIR, { recursive: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: { code: "fs_error", message: String(error) } }, { status: 500 });
  }

  const requestId = randomUUID();
  atomicWrite(
    join(CONTROL_DIR, `${requestId}.json`),
    JSON.stringify({ id: requestId, cmd: action, runId: body.runId, message: body.message ?? "", ts: Date.now() }),
  );

  const replyPath = join(REPLY_DIR, `${requestId}.json`);
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (existsSync(replyPath)) {
        let reply: ReplyPayload;
        try {
          reply = JSON.parse(readFileSync(replyPath, "utf8")) as ReplyPayload;
        } catch {
          continue; // 半截写入，下一轮
        }
        rmSync(replyPath, { force: true });
        return NextResponse.json({ ok: reply.ok, data: reply.data, error: reply.error });
      }
    }
  } finally {
    // 超时/异常时清掉未认领的请求，避免留垃圾
    rmSync(join(CONTROL_DIR, `${requestId}.json`), { force: true });
    rmSync(join(CONTROL_DIR, `${requestId}.json.claim`), { force: true });
  }

  return NextResponse.json(
    { ok: false, error: { code: "bridge_timeout", message: "控制桥无响应：目标 subagent 所属会话可能已关闭" } },
    { status: 504 },
  );
}

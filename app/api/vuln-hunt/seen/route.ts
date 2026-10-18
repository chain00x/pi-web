import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

/**
 * 「已读水位」标记（vuln-hunt 看板用）：
 * 点击文件 chip 打开台账时，把当前时间写进 <台账>.seen，扩展据此算出未读条数。
 * 只允许写允许根内真实存在的文件，避免变成任意写。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { path?: unknown };
    const target = typeof body.path === "string" ? body.path.trim() : "";
    if (!target || !path.isAbsolute(target)) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    if (!target.endsWith(".md")) {
      return NextResponse.json({ error: "only .md files are supported" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(target, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    await fs.writeFile(`${target}.seen`, JSON.stringify({ at: Date.now() }), "utf8");
    return NextResponse.json({ ok: true, at: Date.now() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

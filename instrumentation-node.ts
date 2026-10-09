import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { announcePiHostPackageRoot, ensureHostPackagesInAgentDir } from "@/lib/pi-host-package";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // 包装型宿主（见 lib/pi-host-package.ts）：
  // 1) 显式声明宿主包根，否则 pi-subagents 的 async/后台子代理直接 fail closed；
  // 2) 幂等补上 $AGENT_DIR/npm/node_modules/@earendil-works/* 软链，否则扩展在进程内
  //    建子会话时 import 宿主包会 ERR_MODULE_NOT_FOUND（pi 的包管理器会把它们当
  //    extraneous 清掉）。必须在任何会话/扩展加载之前完成。
  announcePiHostPackageRoot();
  const hostLinks = ensureHostPackagesInAgentDir();
  if (hostLinks.linked.length > 0) {
    console.log(`[pi-web] host packages linked into ${hostLinks.targetDir}: ${hostLinks.linked.join(", ")}`);
  }

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}

import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { announcePiHostPackageRoot } from "@/lib/pi-host-package";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // 包装型宿主（见 lib/pi-host-package.ts）：不声明宿主包根时 pi-subagents 的
  // async/后台子代理会直接 fail closed。必须在任何会话/扩展加载之前设好。
  announcePiHostPackageRoot();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi Web 是「包装型宿主」：会话直接跑在 Next server 进程里，扩展包既找不到独立的
 * `pi` 可执行文件，也无法从 argv[1] / 自身 import 路径推出宿主核心包的位置
 * （pi-web 由 `next start` 启动，argv[1] 是 next 的入口）。
 *
 * pi-subagents 起**后台（async）子代理**时会先解析宿主包根，解析不到就 fail closed：
 *   Background children require a supported standalone Pi host or the installed
 *   npm package (@earendil-works/pi-coding-agent); neither is available.
 * （前台/进程内子代理不受影响，所以症状是「前台能跑、async 全挂」。）
 *
 * 该包提供的官方逃生门就是下面这个环境变量，这里把 pi-web 自己依赖的 pi 核心包根
 * 显式声明出去；外部已设置时一律尊重外部值。
 */
export const PI_HOST_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_HOST_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

const PI_HOST_PACKAGE_SEGMENTS = ["node_modules", "@earendil-works", "pi-coding-agent"];

/** 从 startDir 逐级向上找 node_modules 里的 pi 核心包根（校验 package.json 的 name）。 */
export function findPiHostPackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ...PI_HOST_PACKAGE_SEGMENTS);
    if (existsSync(join(candidate, "package.json"))) {
      try {
        const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: unknown };
        if (manifest.name === PI_HOST_PACKAGE) return candidate;
      } catch {
        // 清单坏了就继续向上找
      }
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) return undefined;
    dir = parent;
  }
}

/** 本模块所在目录（Next server bundle 编译后位于 .next/server/...，同样在包根之下）。 */
function moduleDir(): string | undefined {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

export function resolvePiHostPackageRoot(): string | undefined {
  const bases = [process.cwd(), moduleDir()].filter((base): base is string => Boolean(base));
  for (const base of bases) {
    const root = findPiHostPackageRoot(base);
    if (root) return root;
  }
  return undefined;
}

/** 幂等：只在未显式设置时声明宿主包根；返回实际生效的值（可能为空）。 */
export function announcePiHostPackageRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const existing = env[PI_HOST_PACKAGE_ROOT_ENV]?.trim();
  if (existing) return existing;
  const root = resolvePiHostPackageRoot();
  if (root) env[PI_HOST_PACKAGE_ROOT_ENV] = root;
  return root;
}

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
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
 *
 * 但它还不够：pi-subagents 在**进程内建子会话**时还会真的 `import` 宿主包
 * （`src/runs/shared/child-session.js`），这条 import 按 Node 的 node_modules 规则从
 * 扩展包实际所在位置解析 —— 也就是 `$AGENT_DIR/npm/node_modules/@earendil-works/*`。
 * 那个目录由 pi 的包管理器负责，而 `@earendil-works/*` 只是 pi-subagents 的
 * optional peerDependencies（不在 package.json 里）→ 每次 `npm install` 都被当成
 * extraneous 清掉，只留一个空的 scope 目录 → 新进程里 import 直接
 * ERR_MODULE_NOT_FOUND，于是前台子会话和 async 子代理一起挂。
 * 所以这里再补一层：每次 pi-web 启动时幂等地把宿主包链接回该目录（已存在的绝不覆盖）。
 */
export const PI_HOST_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_HOST_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
export const PI_HOST_SCOPE = "@earendil-works";

const PI_HOST_SCOPE_SEGMENTS = ["node_modules", PI_HOST_SCOPE];
const PI_HOST_PACKAGE_SEGMENTS = [...PI_HOST_SCOPE_SEGMENTS, "pi-coding-agent"];

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

/** agent 目录（与核心 getAgentDir 同规则）：$PI_CODING_AGENT_DIR / $TAU_CODING_AGENT_DIR，否则 ~/.pi/agent。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ["PI_CODING_AGENT_DIR", "TAU_CODING_AGENT_DIR"] as const) {
    const value = env[key]?.trim();
    if (value) return value.replace(/^~(?=\/|$)/, homedir());
  }
  return join(homedir(), ".pi", "agent");
}

/** 扩展解析宿主包的位置：$AGENT_DIR/npm/node_modules/@earendil-works */
export function agentHostScopeDir(agentDir = resolveAgentDir()): string {
  return join(agentDir, "npm", "node_modules", PI_HOST_SCOPE);
}

export interface HostLinkResult {
  scopeDir: string;
  targetDir: string;
  linked: string[];
  present: string[];
}

/**
 * 幂等把宿主包（pi-web 自带的 @earendil-works/*）链接进 agent 的 npm 目录。
 * 已存在（真目录 / 可用软链）的条目一概不动；只在缺失时补软链；任何失败都吞掉不影响启动。
 */
export function ensureHostPackagesInAgentDir(options: {
  scopeDir?: string;
  targetDir?: string;
} = {}): HostLinkResult {
  const scopeDir = options.scopeDir ?? (() => {
    const root = resolvePiHostPackageRoot();
    return root ? dirname(root) : "";
  })();
  const targetDir = options.targetDir ?? agentHostScopeDir();
  const result: HostLinkResult = { scopeDir, targetDir, linked: [], present: [] };
  if (!scopeDir || !existsSync(scopeDir)) return result;
  let names: string[];
  try {
    names = readdirSync(scopeDir);
  } catch {
    return result;
  }
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch {
    return result;
  }
  for (const name of names) {
    const source = join(scopeDir, name);
    const target = join(targetDir, name);
    // 链接指向的目标必须真的在（避免留下半截软链）
    if (!existsSync(join(source, "package.json"))) continue;
    if (existsSync(target) && existsSync(join(target, "package.json"))) {
      result.present.push(name);
      continue;
    }
    try {
      symlinkSync(source, target, "dir");
      result.linked.push(name);
    } catch {
      // 并发/权限问题：保持启动可用，下轮再补
    }
  }
  return result;
}

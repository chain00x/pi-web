import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// lib/pi-host-package.ts 是 TS，用 node strip-types 直接 import（与 npm test 的 glob 一致）。
const {
  PI_HOST_PACKAGE,
  PI_HOST_PACKAGE_ROOT_ENV,
  PI_HOST_SCOPE,
  findPiHostPackageRoot,
  announcePiHostPackageRoot,
  resolveAgentDir,
  agentHostScopeDir,
  ensureHostPackagesInAgentDir,
} = await import("./pi-host-package.ts");

test("ensureHostPackagesInAgentDir: 幂等补链，已存在的条目不动", () => {
  withTempDir((root) => {
    const scopeDir = makeScopeTree(join(root, "scope"), ["pi-coding-agent", "pi-ai", "pi-tui"]);
    const targetDir = join(root, "agent", "npm", "node_modules", PI_HOST_SCOPE);
    // 先放一个「自己装的」真目录：不能被覆盖
    mkdirSync(join(targetDir, "pi-tui"), { recursive: true });
    writeFileSync(join(targetDir, "pi-tui", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }));

    const first = ensureHostPackagesInAgentDir({ scopeDir, targetDir });
    assert.deepEqual(first.linked.sort(), ["pi-ai", "pi-coding-agent"]);
    assert.deepEqual(first.present, ["pi-tui"]);
    assert.equal(realpathSync(join(targetDir, "pi-coding-agent")), realpathSync(join(scopeDir, "pi-coding-agent")));

    // 第二次：全部已就位，不再新建
    const second = ensureHostPackagesInAgentDir({ scopeDir, targetDir });
    assert.deepEqual(second.linked, []);
    assert.deepEqual(second.present.sort(), ["pi-ai", "pi-coding-agent", "pi-tui"]);
  });
});

test("ensureHostPackagesInAgentDir: scope 目录不存在时不报错、不写入", () => {
  withTempDir((root) => {
    const targetDir = join(root, "agent", "npm", "node_modules", PI_HOST_SCOPE);
    const result = ensureHostPackagesInAgentDir({ scopeDir: join(root, "missing"), targetDir });
    assert.deepEqual(result.linked, []);
    assert.equal(existsSync(targetDir), false);
  });
});

test("resolveAgentDir / agentHostScopeDir: 尊重 PI_CODING_AGENT_DIR", () => {
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/x" }), "/tmp/x");
  assert.equal(resolveAgentDir({ TAU_CODING_AGENT_DIR: "~/tau" }), join(homedir(), "tau"));
  assert.equal(resolveAgentDir({}), join(homedir(), ".pi", "agent"));
  assert.equal(
    agentHostScopeDir("/tmp/agent"),
    join("/tmp/agent", "npm", "node_modules", "@earendil-works"),
  );
});

/** 造一棵「包根 + node_modules/@earendil-works/pi-coding-agent」的假宿主树。 */
function makeHostTree(root, packageName = PI_HOST_PACKAGE) {
  const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName }));
  mkdirSync(join(root, "app", "api", "deep"), { recursive: true });
  return packageDir;
}

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), "pi-host-package-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 造一棵「宿主包 scope 目录」：<root>/node_modules/@earendil-works/<name>/package.json。 */
function makeScopeTree(root, names) {
  const scopeDir = join(root, "node_modules", "@earendil-works");
  for (const name of names) {
    const dir = join(scopeDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@earendil-works/${name}` }));
  }
  return scopeDir;
}

test("findPiHostPackageRoot: 从深层子目录逐级向上找到宿主包根", () => {
  withTempDir((root) => {
    const packageDir = makeHostTree(root);
    assert.equal(findPiHostPackageRoot(join(root, "app", "api", "deep")), packageDir);
    assert.equal(findPiHostPackageRoot(packageDir), packageDir);
  });
});

test("findPiHostPackageRoot: package.json 的 name 不匹配时不认", () => {
  withTempDir((root) => {
    makeHostTree(root, "@agegr/pi-web");
    assert.equal(findPiHostPackageRoot(join(root, "app")), undefined);
  });
});

test("findPiHostPackageRoot: 没有 node_modules 时返回 undefined", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "app", "api"), { recursive: true });
    assert.equal(findPiHostPackageRoot(join(root, "app", "api")), undefined);
  });
});

test("announcePiHostPackageRoot: 外部已显式设置时原样尊重", () => {
  const env = { [PI_HOST_PACKAGE_ROOT_ENV]: " /custom/pi-root " };
  assert.equal(announcePiHostPackageRoot(env), "/custom/pi-root");
  assert.equal(env[PI_HOST_PACKAGE_ROOT_ENV], " /custom/pi-root ");
});

test("announcePiHostPackageRoot: 未设置时按 cwd 自动声明，且幂等", () => {
  withTempDir((root) => {
    const packageDir = makeHostTree(root);
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const env = {};
      const announced = announcePiHostPackageRoot(env);
      // cwd 可能被系统 realpath 化（macOS /var → /private/var），比 realpath 即可
      assert.equal(realpathSync(announced), realpathSync(packageDir));
      assert.equal(env[PI_HOST_PACKAGE_ROOT_ENV], announced);
      // 第二次调用时 env 里已有值：不再重新解析
      assert.equal(announcePiHostPackageRoot(env), announced);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

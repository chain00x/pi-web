import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/pi-host-package.ts 是 TS，用 node strip-types 直接 import（与 npm test 的 glob 一致）。
const {
  PI_HOST_PACKAGE,
  PI_HOST_PACKAGE_ROOT_ENV,
  findPiHostPackageRoot,
  announcePiHostPackageRoot,
} = await import("./pi-host-package.ts");

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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRuntimeLaunchArgs, buildRuntimeSpawnOptions, resolveRuntimeLayout, selectRuntimeBaseGamePath } from "../lib/runtime-layout.mjs";

async function withRoots(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-runtime-layout-"));
  const coreRoot = path.join(root, "core");
  const gameRoot = path.join(root, "game");
  const homeRoot = path.join(root, "server", "home");
  try {
    await fs.mkdir(coreRoot);
    await fs.mkdir(path.join(gameRoot, "main"), { recursive: true });
    await fs.mkdir(path.join(gameRoot, "zone"), { recursive: true });
    await fs.writeFile(path.join(gameRoot, "main", "pak0.iwd"), "iwd");
    await fs.writeFile(path.join(gameRoot, "zone", "localized.ff"), "zone");
    await run({ coreRoot, gameRoot, homeRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("resolves independent Core, BaseGame, and server home paths", async () => {
  await withRoots(async ({ coreRoot, gameRoot, homeRoot }) => {
    const layout = await resolveRuntimeLayout({
      coreExecutablePath: path.join(coreRoot, "cod4x18_dedrun.exe"),
      baseGamePath: gameRoot,
      serverHomePath: homeRoot,
    });

    assert.equal(layout.coreWorkingDirectory, coreRoot);
    assert.equal(layout.filesystemBasePath, gameRoot);
    assert.equal(layout.filesystemHomePath, homeRoot);
    assert.equal(layout.baseGame.valid, true);
    assert.equal((await fs.stat(homeRoot)).isDirectory(), true);
  });
});

test("rejects invalid BaseGame assets before creating server home", async () => {
  await withRoots(async ({ coreRoot, gameRoot, homeRoot }) => {
    await fs.rm(path.join(gameRoot, "main", "pak0.iwd"));
    await assert.rejects(
      resolveRuntimeLayout({
        coreExecutablePath: path.join(coreRoot, "cod4x18_dedrun.exe"),
        baseGamePath: gameRoot,
        serverHomePath: homeRoot,
      }),
      (error) => error.code === "BASEGAME_INVALID",
    );
    await assert.rejects(fs.stat(homeRoot), { code: "ENOENT" });
  });
});

test("rejects the BaseGame root as the server home", async () => {
  await withRoots(async ({ coreRoot, gameRoot }) => {
    await assert.rejects(
      resolveRuntimeLayout({
        coreExecutablePath: path.join(coreRoot, "cod4x18_dedrun.exe"),
        baseGamePath: gameRoot,
        serverHomePath: gameRoot,
      }),
      { code: "RUNTIME_HOME_WITHIN_BASEGAME" },
    );
  });
});

test("rejects a server home nested inside BaseGame", async () => {
  await withRoots(async ({ coreRoot, gameRoot }) => {
    const nestedHome = path.join(gameRoot, "server-home");
    await assert.rejects(
      resolveRuntimeLayout({
        coreExecutablePath: path.join(coreRoot, "cod4x18_dedrun.exe"),
        baseGamePath: gameRoot,
        serverHomePath: nestedHome,
      }),
      { code: "RUNTIME_HOME_WITHIN_BASEGAME" },
    );
    await assert.rejects(fs.stat(nestedHome), { code: "ENOENT" });
  });
});

test("rejects a missing Core parent without creating it", async () => {
  await withRoots(async ({ gameRoot, homeRoot }) => {
    const missingCoreRoot = path.join(gameRoot, "missing-core");
    await assert.rejects(
      resolveRuntimeLayout({
        coreExecutablePath: path.join(missingCoreRoot, "cod4x18_dedrun.exe"),
        baseGamePath: gameRoot,
        serverHomePath: homeRoot,
      }),
      { code: "RUNTIME_CORE_DIRECTORY_INVALID" },
    );
    await assert.rejects(fs.stat(missingCoreRoot), { code: "ENOENT" });
  });
});

test("constructs launch args for separate filesystem paths", () => {
  assert.deepEqual(buildRuntimeLaunchArgs({
    filesystemBasePath: "C:\\game",
    filesystemHomePath: "C:\\server\\home",
  }, ["+map", "mp_crash"]), [
    "+set", "dedicated", "2",
    "+set", "fs_basepath", "C:\\game",
    "+set", "fs_homepath", "C:\\server\\home",
    "+map", "mp_crash",
  ]);
});

test("spawns with the Core working directory and shell disabled", () => {
  assert.deepEqual(buildRuntimeSpawnOptions({ coreWorkingDirectory: "C:\\core" }), {
    cwd: "C:\\core",
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
});

test("selects the stored BaseGame path when restart omits an explicit path", () => {
  assert.equal(selectRuntimeBaseGamePath("", {
    baseGamePath: "C:\\shared\\game",
    filesystemBasePath: "C:\\legacy\\game",
  }), "C:\\shared\\game");
});

test("uses the stored filesystem base path for older runtime state", () => {
  assert.equal(selectRuntimeBaseGamePath("", {
    filesystemBasePath: "C:\\legacy\\game",
  }), "C:\\legacy\\game");
});

test("prefers an explicit BaseGame path over stored runtime state", () => {
  assert.equal(selectRuntimeBaseGamePath("C:\\new\\game", {
    baseGamePath: "C:\\shared\\game",
    filesystemBasePath: "C:\\legacy\\game",
  }), "C:\\new\\game");
});

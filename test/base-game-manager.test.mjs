import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { inspectBaseGame, assertValidBaseGame } from "../lib/base-game-manager.mjs";

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cod4x-basegame-"));
  try {
    await run(root);
  } finally {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeAsset(root, relativePath, content = "asset") {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function treeSnapshot(root) {
  const entries = [];
  async function walk(directory, relative = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path: name, type: "directory" });
        await walk(fullPath, name);
      } else {
        entries.push({ path: name, type: "file", bytes: await fs.readFile(fullPath) });
      }
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

test("accepts complete BaseGame assets without changing the source tree", async () => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/pak0.iwd", "iwd");
    await writeAsset(root, "zone/english/localized_code_post_gfx_mp.ff", "zone");
    const before = await treeSnapshot(root);

    const result = await inspectBaseGame(root);

    assert.equal(result.valid, true);
    assert.equal(result.baseGamePath, path.resolve(root));
    assert.equal(result.mainPath, path.join(path.resolve(root), "main"));
    assert.equal(result.zonePath, path.join(path.resolve(root), "zone"));
    assert.deepEqual(result.iwdFiles, ["main/pak0.iwd"]);
    assert.deepEqual(result.zoneFiles, ["zone/english/localized_code_post_gfx_mp.ff"]);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(await treeSnapshot(root), before);
    assert.deepEqual(await assertValidBaseGame(root), result);
  });
});

test("accepts a read-only BaseGame without changing its contents", async () => {
  await withFixture(async (root) => {
    const iwd = await writeAsset(root, "main/pak0.iwd", "iwd");
    const zone = await writeAsset(root, "zone/english/localized_code_post_gfx_mp.ff", "zone");
    await fs.chmod(iwd, 0o444);
    await fs.chmod(zone, 0o444);
    const before = await treeSnapshot(root);

    const result = await inspectBaseGame(root);

    assert.equal(result.valid, true);
    assert.deepEqual(await treeSnapshot(root), before);
  });
});

function assertReason(result, code, expectedPath) {
  assert.equal(result.valid, false);
  const reason = result.reasons.find((item) => item.code === code);
  assert.ok(reason, `Expected ${code}; got ${JSON.stringify(result.reasons)}`);
  assert.match(reason.message, new RegExp(expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("rejects blank input before resolving it to the current directory", async () => {
  const result = await inspectBaseGame("  ");
  assertReason(result, "BASEGAME_PATH_REQUIRED", "BaseGame");
  assert.equal(result.baseGamePath, "");
  await assert.rejects(assertValidBaseGame(""), (error) => {
    assert.equal(error.code, "BASEGAME_INVALID");
    assertReason(error.inspection, "BASEGAME_PATH_REQUIRED", "BaseGame");
    return true;
  });
});

test("reports a missing root with its normalized path", async () => {
  await withFixture(async (root) => {
    const missing = path.join(root, "missing");
    const result = await inspectBaseGame(missing);
    assertReason(result, "BASEGAME_NOT_FOUND", missing);
    assert.equal(result.baseGamePath, path.resolve(missing));
  });
});

test("rejects a file-valued root", async () => {
  await withFixture(async (root) => {
    const file = await writeAsset(root, "not-a-directory", "bytes");
    assertReason(await inspectBaseGame(file), "BASEGAME_NOT_DIRECTORY", file);
  });
});

test("reports missing main and zone together", async () => {
  await withFixture(async (root) => {
    const result = await inspectBaseGame(root);
    assertReason(result, "BASEGAME_MAIN_MISSING", path.join(root, "main"));
    assertReason(result, "BASEGAME_ZONE_MISSING", path.join(root, "zone"));
    assert.equal(result.reasons.length, 2);
  });
});

test("rejects file-valued main and zone branches together", async () => {
  await withFixture(async (root) => {
    await writeAsset(root, "main", "bytes");
    await writeAsset(root, "zone", "bytes");
    const result = await inspectBaseGame(root);
    assertReason(result, "BASEGAME_MAIN_NOT_DIRECTORY", path.join(root, "main"));
    assertReason(result, "BASEGAME_ZONE_NOT_DIRECTORY", path.join(root, "zone"));
    assert.equal(result.reasons.length, 2);
  });
});

test("requires a direct non-empty iwd in main", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "main"));
    await writeAsset(root, "main/nested/pak0.iwd", "nested");
    await writeAsset(root, "zone/english/asset.ff", "zone");
    assertReason(await inspectBaseGame(root), "BASEGAME_MAIN_IWD_MISSING", path.join(root, "main"));
    await writeAsset(root, "main/pak0.iwd", "");
    assertReason(await inspectBaseGame(root), "BASEGAME_MAIN_IWD_MISSING", path.join(root, "main"));
  });
});

test("accepts case-insensitive IWD extension and sorts relative asset paths", async () => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/z.IWD", "z");
    await writeAsset(root, "main/a.iwd", "a");
    await writeAsset(root, "zone/z/last.ff", "z");
    await writeAsset(root, "zone/a/first.ff", "a");
    const result = await inspectBaseGame(root);
    assert.equal(result.valid, true);
    assert.deepEqual(result.iwdFiles, ["main/a.iwd", "main/z.IWD"]);
    assert.deepEqual(result.zoneFiles, ["zone/a/first.ff", "zone/z/last.ff"]);
  });
});

test("rejects an empty zone and zero-byte zone files", async () => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/pak0.iwd", "iwd");
    await fs.mkdir(path.join(root, "zone"));
    assertReason(await inspectBaseGame(root), "BASEGAME_ZONE_ASSETS_MISSING", path.join(root, "zone"));
    await writeAsset(root, "zone/english/empty.ff", "");
    assertReason(await inspectBaseGame(root), "BASEGAME_ZONE_ASSETS_MISSING", path.join(root, "zone"));
  });
});

test("rejects a zone tree beyond the documented scan depth", async () => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/pak0.iwd", "iwd");
    await writeAsset(root, `zone/${Array.from({ length: 17 }, (_, i) => `d${i}`).join("/")}/asset.ff`, "zone");
    assertReason(await inspectBaseGame(root), "BASEGAME_ZONE_SCAN_LIMIT", path.join(root, "zone"));
  });
});

test("reports permission denial when the host enforces unreadable directories", async (context) => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/pak0.iwd", "iwd");
    await writeAsset(root, "zone/asset.ff", "zone");
    const zonePath = path.join(root, "zone");
    await fs.chmod(zonePath, 0o000);
    let denied = false;
    try {
      await fs.readdir(zonePath);
    } catch (error) {
      denied = error.code === "EACCES" || error.code === "EPERM";
    }
    if (!denied) {
      context.skip("Host does not enforce read denial via chmod");
      return;
    }
    try {
      assertReason(await inspectBaseGame(root), "BASEGAME_ACCESS_DENIED", zonePath);
    } finally {
      await fs.chmod(zonePath, 0o700);
    }
  });
});

test("rejects a main asset whose contents cannot be opened", async (context) => {
  await withFixture(async (root) => {
    const iwdPath = await writeAsset(root, "main/pak0.iwd", "iwd");
    await writeAsset(root, "zone/asset.ff", "zone");
    const realOpen = fs.open;
    context.mock.method(fs, "open", async (target, ...options) => {
      if (target === iwdPath) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return realOpen(target, ...options);
    });

    const result = await inspectBaseGame(root);

    assertReason(result, "BASEGAME_ACCESS_DENIED", iwdPath);
  });
});

test("rejects a zone asset whose contents cannot be opened", async (context) => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/pak0.iwd", "iwd");
    const zoneAsset = await writeAsset(root, "zone/asset.ff", "zone");
    const realOpen = fs.open;
    context.mock.method(fs, "open", async (target, ...options) => {
      if (target === zoneAsset) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return realOpen(target, ...options);
    });

    const result = await inspectBaseGame(root);

    assertReason(result, "BASEGAME_ACCESS_DENIED", zoneAsset);
  });
});

test("rejects an unreadable root even when its children are traversable", async (context) => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/pak0.iwd", "iwd");
    await writeAsset(root, "zone/asset.ff", "zone");
    const realOpendir = fs.opendir;
    context.mock.method(fs, "opendir", async (target, ...options) => {
      if (target === root) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return realOpendir(target, ...options);
    });

    const result = await inspectBaseGame(root);

    assertReason(result, "BASEGAME_ACCESS_DENIED", root);
    assert.deepEqual(result.iwdFiles, []);
    assert.deepEqual(result.zoneFiles, []);
  });
});

test("stops the zone scan at 4096 entries without bulk-loading the directory", async (context) => {
  await withFixture(async (root) => {
    await writeAsset(root, "main/pak0.iwd", "iwd");
    const zonePath = path.join(root, "zone");
    await fs.mkdir(zonePath);
    for (let offset = 0; offset < 4095; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 4095 - offset) }, (_, index) =>
        fs.writeFile(path.join(zonePath, `empty-${offset + index}.ff`), "")));
    }
    await writeAsset(root, "zone/asset.ff", "zone");
    const realReaddir = fs.readdir;
    context.mock.method(fs, "readdir", async (target, ...options) => {
      if (target === zonePath) throw new Error("zone must use incremental directory iteration");
      return realReaddir(target, ...options);
    });

    assert.equal((await inspectBaseGame(root)).valid, true);
    await writeAsset(root, "zone/extra.ff", "extra");
    assertReason(await inspectBaseGame(root), "BASEGAME_ZONE_SCAN_LIMIT", zonePath);
  });
});

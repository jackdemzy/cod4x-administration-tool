import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { mergeBaseGameState } from "../lib/runtime-layout.mjs";

test("initializes BaseGame state without inventing a path", () => {
  const merged = mergeBaseGameState({ status: "STOPPED", baseGamePath: null });

  assert.equal(merged.baseGamePath, null);
  assert.equal(merged.status, "STOPPED");
});

test("normalizes a stored relative BaseGame path while preserving runtime fields", () => {
  const merged = mergeBaseGameState(
    { status: "STOPPED", baseGamePath: null, platform: "windows" },
    { baseGamePath: ".\\shared\\game", cod4x: "21.5" },
  );

  assert.equal(merged.baseGamePath, path.resolve(".\\shared\\game"));
  assert.equal(merged.status, "STOPPED");
  assert.equal(merged.platform, "windows");
  assert.equal(merged.cod4x, "21.5");
});

test("normalizes a stored absolute BaseGame path", () => {
  const absolutePath = path.resolve("C:\\games\\cod4");

  const merged = mergeBaseGameState({}, { baseGamePath: absolutePath });

  assert.equal(merged.baseGamePath, absolutePath);
});

test("clears a missing or empty stored BaseGame path", () => {
  assert.equal(mergeBaseGameState({}, {}).baseGamePath, null);
  assert.equal(mergeBaseGameState({}, { baseGamePath: "" }).baseGamePath, null);
});

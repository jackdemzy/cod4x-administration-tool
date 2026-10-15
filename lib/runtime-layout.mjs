import fs from "node:fs/promises";
import path from "node:path";

import { assertValidBaseGame } from "./base-game-manager.mjs";

export function mergeBaseGameState(current, stored = {}) {
  return {
    ...current,
    ...stored,
    baseGamePath: stored.baseGamePath ? path.resolve(stored.baseGamePath) : null,
  };
}

export function selectRuntimeBaseGamePath(explicitPath, runtimeState = {}) {
  return explicitPath || runtimeState.baseGamePath || runtimeState.filesystemBasePath || "";
}

export async function resolveRuntimeLayout({ coreExecutablePath, baseGamePath, serverHomePath }) {
  const coreWorkingDirectory = path.resolve(path.dirname(coreExecutablePath));
  const baseGame = await assertValidBaseGame(baseGamePath);
  const filesystemBasePath = baseGame.baseGamePath;
  const filesystemHomePath = path.resolve(serverHomePath);
  const homeRelativeToBaseGame = path.relative(filesystemBasePath, filesystemHomePath);
  if (homeRelativeToBaseGame === "" ||
      (!path.isAbsolute(homeRelativeToBaseGame) && homeRelativeToBaseGame !== ".." && !homeRelativeToBaseGame.startsWith(`..${path.sep}`))) {
    const error = new Error(`Runtime-Arbeitsverzeichnis darf nicht innerhalb der BaseGame liegen: ${filesystemHomePath}`);
    error.code = "RUNTIME_HOME_WITHIN_BASEGAME";
    error.runtimeTarget = { filesystemBasePath, filesystemHomePath };
    throw error;
  }

  let coreStats;
  try {
    coreStats = await fs.stat(coreWorkingDirectory);
  } catch (cause) {
    const error = new Error(`Dedicated-Core-Verzeichnis konnte nicht geprüft werden: ${coreWorkingDirectory} (${cause.message})`);
    error.code = "RUNTIME_CORE_DIRECTORY_INVALID";
    throw error;
  }
  if (!coreStats.isDirectory()) {
    const error = new Error(`Dedicated-Core-Verzeichnis ist kein Ordner: ${coreWorkingDirectory}`);
    error.code = "RUNTIME_CORE_DIRECTORY_INVALID";
    throw error;
  }

  try {
    await fs.mkdir(filesystemHomePath, { recursive: true });
    const homeStats = await fs.stat(filesystemHomePath);
    if (!homeStats.isDirectory()) throw Object.assign(new Error("path is not a directory"), { code: "ENOTDIR" });
  } catch (cause) {
    const error = new Error(`Runtime-Arbeitsverzeichnis konnte nicht erstellt oder geprüft werden: ${filesystemHomePath} (${cause.message})`);
    error.code = cause.code === "ENOTDIR" ? "RUNTIME_CWD_INVALID" : "RUNTIME_CWD_CREATE_FAILED";
    error.runtimeTarget = { target: filesystemHomePath };
    throw error;
  }

  return { coreWorkingDirectory, filesystemBasePath, filesystemHomePath, baseGame };
}

export function buildRuntimeLaunchArgs(layout, extraArgs = []) {
  return [
    "+set", "dedicated", "2",
    "+set", "fs_basepath", layout.filesystemBasePath,
    "+set", "fs_homepath", layout.filesystemHomePath,
    ...extraArgs,
  ];
}

export function buildRuntimeSpawnOptions(layout) {
  return {
    cwd: layout.coreWorkingDirectory,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  };
}

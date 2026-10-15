import fs from "node:fs/promises";
import path from "node:path";

const MAX_ZONE_DEPTH = 16;
const MAX_ZONE_ENTRIES = 4096;

function reason(code, target, detail) {
  return { code, message: `BaseGame ${detail}: ${target}` };
}

function mappedError(error, target, missingCode, detail) {
  if (error.code === "EACCES" || error.code === "EPERM") {
    return reason("BASEGAME_ACCESS_DENIED", target, "access denied");
  }
  if (error.code === "ENOENT") return reason(missingCode, target, detail);
  throw error;
}

async function inspectDirectory(directory, missingCode, notDirectoryCode, reasons) {
  let stats;
  try {
    stats = await fs.stat(directory);
  } catch (error) {
    reasons.push(mappedError(error, directory, missingCode, "directory missing"));
    return false;
  }
  if (!stats.isDirectory()) {
    reasons.push(reason(notDirectoryCode, directory, "is not a directory"));
    return false;
  }
  return true;
}

async function checkReadableFile(assetPath) {
  const handle = await fs.open(assetPath, "r");
  await handle.close();
}

export async function inspectBaseGame(input) {
  const suppliedPath = typeof input === "string" ? input.trim() : "";
  const baseGamePath = suppliedPath ? path.resolve(suppliedPath) : "";
  const mainPath = baseGamePath ? path.join(baseGamePath, "main") : "";
  const zonePath = baseGamePath ? path.join(baseGamePath, "zone") : "";
  const reasons = [];
  const iwdFiles = [];
  const zoneFiles = [];
  const result = () => ({
    valid: reasons.length === 0,
    baseGamePath,
    mainPath,
    zonePath,
    iwdFiles: iwdFiles.sort(),
    zoneFiles: zoneFiles.sort(),
    reasons,
  });

  if (!suppliedPath) {
    reasons.push(reason("BASEGAME_PATH_REQUIRED", "BaseGame", "path required"));
    return result();
  }
  if (!await inspectDirectory(baseGamePath, "BASEGAME_NOT_FOUND", "BASEGAME_NOT_DIRECTORY", reasons)) {
    return result();
  }
  let rootDirectory;
  try {
    rootDirectory = await fs.opendir(baseGamePath);
    await rootDirectory.read();
  } catch (error) {
    reasons.push(mappedError(error, baseGamePath, "BASEGAME_NOT_FOUND", "directory missing"));
    return result();
  } finally {
    await rootDirectory?.close();
  }

  if (await inspectDirectory(mainPath, "BASEGAME_MAIN_MISSING", "BASEGAME_MAIN_NOT_DIRECTORY", reasons)) {
    const priorReasonCount = reasons.length;
    try {
      for (const entry of await fs.readdir(mainPath, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.iwd$/i.test(entry.name)) continue;
        const assetPath = path.join(mainPath, entry.name);
        try {
          if ((await fs.stat(assetPath)).size > 0) {
            await checkReadableFile(assetPath);
            iwdFiles.push(`main/${entry.name}`);
          }
        } catch (error) {
          reasons.push(mappedError(error, assetPath, "BASEGAME_MAIN_IWD_MISSING", "asset missing"));
        }
      }
      if (iwdFiles.length === 0 && reasons.length === priorReasonCount) {
        reasons.push(reason("BASEGAME_MAIN_IWD_MISSING", mainPath, "has no non-empty direct .iwd file"));
      }
    } catch (error) {
      reasons.push(mappedError(error, mainPath, "BASEGAME_MAIN_MISSING", "directory missing"));
    }
  }

  if (await inspectDirectory(zonePath, "BASEGAME_ZONE_MISSING", "BASEGAME_ZONE_NOT_DIRECTORY", reasons)) {
    let entriesSeen = 0;
    let limitReached = false;
    const priorReasonCount = reasons.length;
    async function walk(directory, relative, depth) {
      if (depth > MAX_ZONE_DEPTH) {
        limitReached = true;
        return;
      }
      const handle = await fs.opendir(directory, { bufferSize: 32 });
      try {
        let entry;
        while ((entry = await handle.read()) !== null) {
          entriesSeen += 1;
          if (entriesSeen > MAX_ZONE_ENTRIES) {
            limitReached = true;
            return;
          }
          const child = path.join(directory, entry.name);
          const childRelative = `${relative}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(child, childRelative, depth + 1);
          } else if (entry.isFile()) {
            try {
              if ((await fs.stat(child)).size > 0) {
                await checkReadableFile(child);
                zoneFiles.push(childRelative);
              }
            } catch (error) {
              reasons.push(mappedError(error, child, "BASEGAME_ZONE_ASSETS_MISSING", "asset missing"));
            }
          }
          if (limitReached) return;
        }
      } finally {
        await handle.close();
      }
    }
    try {
      await walk(zonePath, "zone", 0);
      if (limitReached) reasons.push(reason("BASEGAME_ZONE_SCAN_LIMIT", zonePath, `scan exceeds ${MAX_ZONE_DEPTH} levels or ${MAX_ZONE_ENTRIES} entries`));
      else if (zoneFiles.length === 0 && reasons.length === priorReasonCount) {
        reasons.push(reason("BASEGAME_ZONE_ASSETS_MISSING", zonePath, "has no non-empty file"));
      }
    } catch (error) {
      reasons.push(mappedError(error, error.path || zonePath, "BASEGAME_ZONE_MISSING", "directory missing"));
    }
  }

  return result();
}

export async function assertValidBaseGame(input) {
  const inspection = await inspectBaseGame(input);
  if (inspection.valid) return inspection;
  const error = new Error(inspection.reasons.map((item) => item.message).join("; "));
  error.code = "BASEGAME_INVALID";
  error.inspection = inspection;
  throw error;
}

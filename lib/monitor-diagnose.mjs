// Block 24: probable cause of a server outage from the end of its console log.
// Adapted from cod4-monitor internal/watch/crash.go (Diagnose, Hint);
// Copyright (c) 2026 Florian Martinez, AGPL-3.0, commit 71aaf32.
import { stripColorCodes } from './rcon-protocol.mjs';

const FATAL = /\bERROR\b|Sys_Error|Exceeded limit|Segmentation|\bsignal\b|SIGSEGV|Hunk_|out of memory|G_Spawn|assert|exception|fatal/i;
const SHUTDOWN = /Server Shutdown|^\s*\]?\s*quit\s*$|Sys_Quit/i;
const ERROR_LINE = /^\s*ERROR:\s*/i;
const SCAN_LINES = 120;
export const CONSOLE_KEEP = 40;

const truncate = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…` : text;

// The most telling error line of a run, and whether it ended normally
// (a shutdown without any error: quit command, planned restart).
export function diagnoseConsole(text) {
  const lines = String(text ?? '').split(/\r?\n/).slice(-SCAN_LINES);
  let reason = null, shutdown = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = stripColorCodes(lines[index]).trim();
    if (!line || !line.replace(/[*\-= ]/g, '')) continue;
    if (SHUTDOWN.test(line)) { shutdown = true; continue; }
    // An "ERROR:" line beats anything else; otherwise keep the last matching line.
    if (ERROR_LINE.test(line)) return { reason: truncate(line, 300), clean: false };
    if (!reason && FATAL.test(line)) reason = truncate(line, 300);
  }
  return { reason, clean: !reason && shutdown };
}

// A known crash message in plain words ([de, en]); null when unknown.
export function explainCause(reason) {
  const text = String(reason ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('exceeded limit')) return ['Eine Engine-Grenze wurde überschritten (zu viele Modelle, Sounds, Effekte oder Materialien für diese Map mit dem Mod). Assets aus dem Mod oder die betroffene Map entfernen.', 'An engine limit was exceeded (too many models, sounds, effects or materials loaded for this map with the mod). Remove assets from the mod or that map.'];
  if (text.includes('hunk_') || text.includes('out of memory')) return ['Dem Server ist der Speicher ausgegangen (Hunk). Oft eine zu schwere Map oder ein zu schwerer Mod.', 'The server ran out of memory (hunk). Often a map or mod that is too heavy.'];
  if (text.includes('g_spawn')) return ['Keine freien Entities mehr: zu viele Objekte gleichzeitig (Waffen am Boden, Effekte …).', 'No free entities left: too many objects created at the same time (dropped weapons, effects ...).'];
  if (text.includes('segmentation') || text.includes('signal') || text.includes('sigsegv')) return ['Das Serverprogramm ist abgestürzt (Speicherfehler). Bei Wiederholung Map und Situation notieren.', 'The server program crashed (memory error). If it happens again, note the map and what was going on.'];
  if (text.includes('script')) return ['Fehler in einem Mod-Skript: Die Zeile nennt die betroffene Datei.', 'Error in a mod script: the line names the file at fault.'];
  if (text.includes("couldn't find") || text.includes('could not find') || text.includes("can't find")) return ['Auf dem Server fehlt eine Datei (Map, .ff oder .iwd des Mods).', 'A file is missing on the server (map, mod .ff or .iwd).'];
  return null;
}

export const lastConsoleLines = text => String(text ?? '').split(/\r?\n/).filter(line => line.trim()).slice(-CONSOLE_KEEP);

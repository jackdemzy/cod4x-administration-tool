// One closure per server instance; OS and core policy remain shared dependencies.
export function createRuntimeManager(dependencies, { stateFile, seedState = {}, fixedConfiguration = null, ownership = null } = {}) {
  const { path, fs, crypto, process, dataPath, SERVER_CORE_DEFINITIONS, serverCoreDefinition, execFileAsync, spawn, normalizeServerPlatform, normalizeRuntimePath, resolveServerTarget, resolveRuntimeExecutable, verifiedRuntimeCoreStatus, selectRuntimeBaseGamePath, resolveRuntimeLayout, mergeBaseGameState, policyState } = dependencies;
const RUNTIME_STATE_FILE = path.resolve(stateFile || process.env.COD4X_RUNTIME_STATE || dataPath("config", "runtime-state.json"));
const RUNTIME_MAX_HISTORY = 100;
const RUNTIME_OUTPUT_MAX_BYTES = 64 * 1024;
const RUNTIME_STOP_GRACE_MS = 5_000;
let runtimeChild = null;
let runtimeOperation = null;
const runtimeChildRecords = new WeakMap();

async function withRuntimeOperation(operation, action) {
  if (runtimeOperation) {
    const err = new Error(`Runtime operation ${runtimeOperation} is already in progress.`);
    err.code = "RUNTIME_OPERATION_BUSY";
    throw err;
  }
  runtimeOperation = operation;
  try {
    const result = await action();
    if (operation !== "configure") await persistRuntimeState();
    return result;
  }
  finally { runtimeOperation = null; }
}

function assertRuntimeConfigurationMutable() {
  if (runtimeOperation || runtimeChild || ["STARTING", "RUNNING", "STOPPING"].includes(runtimeState.status)) {
    const err = new Error("Stop the runtime before changing or adopting its configuration.");
    err.code = "RUNTIME_CONFIGURATION_BUSY";
    throw err;
  }
}

async function withRuntimeConfiguration(action) {
  assertRuntimeConfigurationMutable();
  return withRuntimeOperation("configure", action);
}
let runtimeState = {
  version: 1,
  status: "STOPPED",
  target: null,
  resolvedTarget: null,
  runtimeRoot: null,
  workingDirectory: null,
  filesystemBasePath: null,
  baseGamePath: null,
  filesystemHomePath: null,
  executablePath: null,
  cod4x: null,
  platform: process.platform === "win32" ? "windows" : "linux",
  executable: SERVER_CORE_DEFINITIONS[process.platform === "win32" ? "windows" : "linux"].executable,
  pid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  lastError: "",
  outputPolicy: "standard",
  consoleOutputPrivate: false,
  output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
  updatedAt: new Date().toISOString(),
  history: [],
};
runtimeState = { ...runtimeState, ...seedState };
let runtimeWriteQueue = null;
let pendingRuntimeSnapshot = null;

async function loadRuntimeState() {
  try {
    const raw = JSON.parse(await fs.readFile(RUNTIME_STATE_FILE, "utf8"));
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||raw.version!==1||!["STARTING","RUNNING","STOPPING","STOPPED","FAILED"].includes(raw.status)||!(raw.pid===null||(Number.isSafeInteger(raw.pid)&&raw.pid>0)))throw Object.assign(new Error("Runtime-State hat eine ungültige Version oder Prozessstruktur."),{code:"RUNTIME_STATE_INVALID"});
    if ((raw.outputPolicy !== undefined && !['standard', 'private'].includes(raw.outputPolicy)) || (raw.consoleOutputPrivate !== undefined && typeof raw.consoleOutputPrivate !== 'boolean') || (raw.outputPolicy === 'private' && raw.platform !== 'windows')) throw Object.assign(new Error('Invalid runtime output policy checkpoint.'), { code: 'RUNTIME_STATE_INVALID' });
    if (raw && typeof raw === "object") runtimeState = {
      ...runtimeState,
      ...mergeBaseGameState(runtimeState, raw),
      ...(fixedConfiguration || {}),
      history: Array.isArray(raw.history) ? raw.history.slice(0, RUNTIME_MAX_HISTORY) : [],
    };
    invalidateCredentialActivation();
    if (runtimeState.outputPolicy === 'private') {
      runtimeState.consoleOutputPrivate = true;
      runtimeState.output = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
    }
    if (raw.pid === null && ["STARTING", "RUNNING", "STOPPING"].includes(raw.status)) {
      runtimeState.recoveryBlocked = true;
      runtimeState.lastError = "Unterbrochener aktiver Runtime-Zustand ohne PID; Prozesszuordnung muss zuerst geklärt werden.";
      return; // A stop cannot prove absence without identity; preserve checkpoint.
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[runtime] state read failed: ${err.message}`);
      runtimeState.status="FAILED";runtimeState.lastError=err.message;runtimeState.recoveryBlocked=true;
      return; // Preserve unreadable/corrupt evidence and never assume no process exists.
    }
  }
  try { await reconcileRuntimeState(); }
  catch (err) {
    runtimeState.lastError = err.message;
    runtimeEvent("runtime.recovery.blocked", { code: err.code || "RUNTIME_RECOVERY_BLOCKED", error: err.message });
  }
}

function invalidateCredentialActivation() {
  const activation = runtimeState.credentialActivation;
  if (activation && ['READY', 'PENDING'].includes(activation.state) &&
      (activation.runId !== runtimeState.runId || runtimeState.status !== 'RUNNING' || !runtimeState.pid)) {
    runtimeState.credentialActivation = { state: 'INACTIVE', runId: activation.runId || null };
  }
}

function persistRuntimeState() {
  invalidateCredentialActivation();
  if (runtimeState.outputPolicy === 'private') runtimeState.output = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
  pendingRuntimeSnapshot = JSON.stringify({ ...runtimeState, persistenceError: null }, null, 2);
  if (runtimeWriteQueue) return runtimeWriteQueue;
  runtimeWriteQueue = (async () => {
    while (pendingRuntimeSnapshot !== null) {
      const snapshot = pendingRuntimeSnapshot;
      pendingRuntimeSnapshot = null;
      const tmp = `${RUNTIME_STATE_FILE}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try {
        await fs.mkdir(path.dirname(RUNTIME_STATE_FILE), { recursive: true });
        await fs.writeFile(tmp, snapshot, "utf8");
        await fs.rename(tmp, RUNTIME_STATE_FILE);
        runtimeState.persistenceError = null;
      } catch (cause) {
        pendingRuntimeSnapshot = null;
        if (typeof fs.unlink === "function") await fs.unlink(tmp).catch(() => {});
        runtimeState.persistenceError = { code: "RUNTIME_PERSISTENCE_FAILED", causeCode: cause.code || null, message: cause.message };
        throw Object.assign(new Error(`Runtime state could not be saved: ${cause.message}`, { cause }), { code: "RUNTIME_PERSISTENCE_FAILED" });
      }
    }
  })().finally(() => { runtimeWriteQueue = null; });
  return runtimeWriteQueue;
}

function persistRuntimeStateInBackground() {
  persistRuntimeState().catch(err => console.error(`[runtime] state write failed: ${err.message}`));
}

function runtimeEvent(event, details = {}) {
  runtimeState.history.unshift({ timestamp: new Date().toISOString(), event, ...details });
  if (runtimeState.history.length > RUNTIME_MAX_HISTORY) runtimeState.history.length = RUNTIME_MAX_HISTORY;
  runtimeState.updatedAt = new Date().toISOString();
  // Explicit metadata allowlist: never forward args, output or raw error text.
  if (dependencies.onRuntimeEvent) {
    try {
      dependencies.onRuntimeEvent({ event, timestamp: runtimeState.updatedAt, instanceId: runtimeState.instanceId || null, runId: runtimeState.runId || null,
        pid: Number.isSafeInteger(details.pid) ? details.pid : runtimeState.pid,
        status: runtimeState.status, expected: typeof details.expected === "boolean" ? details.expected : null,
        exitCode: Number.isInteger(details.code) ? details.code : runtimeState.exitCode,
        code: typeof details.code === "string" ? details.code : null });
    } catch {
      runtimeState.eventDeliveryError = "RUNTIME_EVENT_DELIVERY_FAILED";
    }
  }
  persistRuntimeStateInBackground();
}

function appendRuntimeOutput(stream, chunk) {
  // Drop before decoding, copying or retaining any process bytes. This mode is
  // chosen before STARTING is persisted and before early output can arrive.
  if (runtimeState.outputPolicy === 'private') return;
  const field = stream === "stderr" ? "stderr" : "stdout";
  const truncatedField = field === "stderr" ? "stderrTruncated" : "stdoutTruncated";
  const output = runtimeState.output && typeof runtimeState.output === "object"
    ? runtimeState.output
    : { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
  const next = `${String(output[field] || "")}${Buffer.from(chunk).toString("utf8")}`;
  if (Buffer.byteLength(next, "utf8") > RUNTIME_OUTPUT_MAX_BYTES) {
    const retained = Buffer.from(next, "utf8").subarray(-RUNTIME_OUTPUT_MAX_BYTES).toString("utf8");
    runtimeState.output = { ...output, [field]: retained, [truncatedField]: true };
  } else {
    runtimeState.output = { ...output, [field]: next };
  }
  runtimeState.updatedAt = new Date().toISOString();
  persistRuntimeStateInBackground();
}

async function windowsProcessInfo(pid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) {
    return { alive: null, executable: null, executablePath: null, error: "Invalid Windows process inspection target" };
  }
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FI", `PID eq ${Number(pid)}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 });
    const line = String(stdout || "").trim().split(/\r?\n/).find(Boolean) || "";
    if (!line) throw new Error("Windows process inspection returned no result");
    const fields = line.split(",").map(v => v.replace(/^"|"$/g, ""));
    const tasklistMatches = fields.length >= 2 && Number(fields[1]) === Number(pid);
    const command = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\"; if($p){[Console]::Out.Write((@{found=$true;executablePath=$p.ExecutablePath;commandLine=$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress))}else{[Console]::Out.Write('{\"found\":false}')}`;
    const detailsResult = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 });
    const details = JSON.parse(String(detailsResult.stdout || ""));
    if(details.found===false)return {alive:false,executable:null,executablePath:null};
    if(!tasklistMatches)throw new Error("Windows process inspections disagree or returned an unrecognized result");
    const alive = true;
    let executablePath = null, commandLine = null, createdAt = null;
    if (alive) {
        executablePath = typeof details.executablePath === "string" ? details.executablePath : null;
        commandLine = typeof details.commandLine === "string" ? details.commandLine : null;
        createdAt = typeof details.createdAt === "string" ? details.createdAt : null;
    }
    return { alive, executable: fields[0] || null, executablePath, commandLine, createdAt };
  } catch (err) { return { alive: null, executable: null, executablePath: null, error: err.message }; }
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(String(left || "")).toLowerCase() === path.win32.normalize(String(right || "")).toLowerCase();
}

function linuxOwnership() {
  if (!Number.isInteger(runtimeState.runtimePort) || runtimeState.runtimePort < 1024 || runtimeState.runtimePort > 65535) throw Object.assign(new Error("Linux runtime requires an explicit owned port."), { code: "INSTANCE_PROCESS_IDENTITY_BLOCKED" });
  return { homePath: runtimeState.filesystemHomePath, port: runtimeState.runtimePort };
}

// Adapters contain OS operations only. State, persistence and lifecycle stay shared.
function runtimeAdapter(platform = runtimeState.platform) {
  if (platform === "windows") return {
    assertHost() { if (process.platform !== "win32") throw Object.assign(new Error("Windows runtime requires Windows process control."), { code: "RUNTIME_PLATFORM_NOT_SUPPORTED" }); },
    inspectProcess: windowsProcessInfo,
    terminate: (pid, forced) => execFileAsync("taskkill.exe", forced ? ["/PID",String(pid),"/T","/F"] : ["/PID",String(pid),"/T"], {windowsHide:true,timeout:10000}),
  };
  if (platform === "linux" && dependencies.linuxRuntimeAdapter) return {
    ...dependencies.linuxRuntimeAdapter,
    terminate: (pid, forced) => dependencies.linuxRuntimeAdapter.signal(pid, { ...(ownership || linuxOwnership()), executablePath: runtimeState.executablePath, createdAt: runtimeState.processCreatedAt }, forced ? "SIGKILL" : "SIGTERM"),
  };
  throw Object.assign(new Error("Runtime platform adapter is unavailable."), { code: "RUNTIME_PLATFORM_NOT_SUPPORTED" });
}

async function waitForRuntimeProcess(pid, options = {}) {
  if (runtimeState.platform === "windows") return waitForWindowsProcess(pid, options);
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  let info;
  do {
    info = await runtimeAdapter().inspectProcess(pid);
    if (info.alive === null) {
      if (options.requireGone && ["ENOENT", "ESRCH"].includes(info.errorCode) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      throw Object.assign(new Error(`Linux process inspection failed: ${info.error}`), { code: "RUNTIME_PROCESS_INSPECTION_FAILED" });
    }
    if (options.requireGone ? info.alive === false : info.alive === true) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return { ok: options.requireGone ? info.alive === false : info.alive === true && info.executable === options.expectedExecutable && info.executablePath === options.expectedPath, info };
}

function assertRuntimeProcessIdentity(info, expectedPath) {
  if (runtimeState.platform === "linux") {
    if (info.alive !== true || info.executable !== serverCoreDefinition("linux").executable || info.executablePath !== expectedPath) throw Object.assign(new Error("Linux runtime executable identity could not be verified."), { code: "RUNTIME_PROCESS_IDENTITY_BLOCKED" });
    if (!runtimeState.processCreatedAt) throw Object.assign(new Error("Saved Linux process birth identity is missing."), { code: "INSTANCE_PROCESS_IDENTITY_BLOCKED" });
    dependencies.assertLinuxInstanceOwnership(info, { ...(ownership || linuxOwnership()), createdAt: runtimeState.processCreatedAt, uid: process.getuid(), gid: process.getgid() });
    return;
  }
  if (info.alive !== true || String(info.executable || "").toLowerCase() !== serverCoreDefinition("windows").executable.toLowerCase()
      || !info.executablePath || !sameWindowsPath(info.executablePath, expectedPath)) {
    const err = new Error("Runtime process identity could not be verified; process control was refused.");
    err.code = "RUNTIME_PROCESS_IDENTITY_BLOCKED";
    throw err;
  }
  if(ownership) {
    if(!runtimeState.processCreatedAt)throw Object.assign(new Error("Gespeicherte Prozess-Erstellzeit fehlt; Stop/Recovery verweigert."),{code:"INSTANCE_PROCESS_IDENTITY_BLOCKED"});
    dependencies.assertWindowsInstanceOwnership(info,{...ownership,createdAt:runtimeState.processCreatedAt});
  }
}

async function waitForWindowsProcess(pid, { expectedExecutable, expectedPath, timeoutMs = 3_000, requireGone = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let info = { alive: false, executable: null, executablePath: null };
  do {
    info = await windowsProcessInfo(pid);
    if (info.alive === null) {
      const err = new Error(`Windows process inspection failed: ${info.error || "unknown result"}`);
      err.code = "RUNTIME_PROCESS_INSPECTION_FAILED";
      throw err;
    }
    if (requireGone ? info.alive === false : info.alive === true) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  if (requireGone) return { ok: info.alive === false, info };
  const imageMatches = String(info.executable || "").toLowerCase() === String(expectedExecutable || "").toLowerCase();
  const pathMatches = Boolean(info.executablePath) && sameWindowsPath(info.executablePath, expectedPath);
  return { ok: info.alive && imageMatches && pathMatches, info };
}

async function reconcileRuntimeState() {
  if (runtimeState.recoveryBlocked)throw Object.assign(new Error("Runtime-State ist nicht lesbar; Recovery muss zuerst geklärt werden."),{code:"RUNTIME_RECOVERY_BLOCKED"});
  if (runtimeState.platform === "linux" && runtimeState.runId && runtimeState.filesystemHomePath) {
    const output = await runtimeAdapter().readOutput(runtimeState.filesystemHomePath, runtimeState.runId, RUNTIME_OUTPUT_MAX_BYTES);
    if (JSON.stringify(output) !== JSON.stringify(runtimeState.output)) { runtimeState.output = output; persistRuntimeStateInBackground(); }
  }
  if (!runtimeState.pid) return;
  const info = await runtimeAdapter().inspectProcess(runtimeState.pid);
  if (info.alive === null) {
    const err = new Error(`Runtime process inspection failed: ${info.error || "unknown result"}`);
    err.code = "RUNTIME_PROCESS_INSPECTION_FAILED";
    throw err;
  }
  const expected = serverCoreDefinition(runtimeState.platform).executable;
  if (info.alive === true && !info.executablePath) {
    const err = new Error("Runtime executable path could not be inspected.");
    err.code = "RUNTIME_PROCESS_INSPECTION_FAILED";
    throw err;
  }
  if (info.alive === true) assertRuntimeProcessIdentity(info, runtimeState.executablePath);
  if (info.alive === false) {
    runtimeState.status = "FAILED";
    runtimeState.lastError = `Persisted runtime PID is no longer an active ${expected} process.`;
    runtimeState.stoppedAt = new Date().toISOString();
    runtimeState.pid = null;
    runtimeEvent("runtime.reconciled", { reason: "process-missing", executable: expected });
  }
}

function describeRuntimeSpawnError(err, exe, target) {
  const code = String(err?.code || "UNKNOWN");
  const syscall = String(err?.syscall || "spawn");
  const message = String(err?.message || `Windows could not start ${path.basename(exe)}.`);
  const details = [
    `code=${code}`,
    `syscall=${syscall}`,
    `executable=${exe}`,
    `workingDirectory=${target}`,
  ];
  const wrapped = new Error(`${message} (${details.join(", ")})`);
  wrapped.code = "RUNTIME_SPAWN_FAILED";
  wrapped.spawnCode = code;
  wrapped.runtimeTarget = { executablePath: exe, workingDirectory: target };
  return wrapped;
}

async function ensureRuntimeWorkingDirectory(target) {
  const resolved = path.resolve(target);
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch (err) {
    const wrapped = new Error(`Runtime-Arbeitsverzeichnis konnte nicht erstellt werden: ${resolved} (${err?.message || err})`);
    wrapped.code = "RUNTIME_CWD_CREATE_FAILED";
    wrapped.runtimeTarget = { target: resolved };
    throw wrapped;
  }
  let stats;
  try { stats = await fs.stat(resolved); } catch (err) {
    const wrapped = new Error(`Runtime-Arbeitsverzeichnis konnte nicht geprüft werden: ${resolved} (${err?.message || err})`);
    wrapped.code = "RUNTIME_CWD_INVALID";
    wrapped.runtimeTarget = { target: resolved };
    throw wrapped;
  }
  if (!stats.isDirectory()) {
    const wrapped = new Error(`Runtime-Arbeitsverzeichnis ist kein Ordner: ${resolved}`);
    wrapped.code = "RUNTIME_CWD_INVALID";
    wrapped.runtimeTarget = { target: resolved };
    throw wrapped;
  }
  return resolved;
}

async function spawnRuntimeProcess(exe, launchArgs, target, platform) {
  if (platform === "linux") await runtimeAdapter(platform).validateExecutable(exe);
  const filesystemHomePath = await ensureRuntimeWorkingDirectory(target);
  const filesystemBasePath = path.resolve(path.dirname(exe));
  let baseStats;
  try { baseStats = await fs.stat(filesystemBasePath); } catch (err) {
    const wrapped = new Error(`CoD4-Dateisystem-Basispfad konnte nicht geprüft werden: ${filesystemBasePath} (${err?.message || err})`);
    wrapped.code = "RUNTIME_BASEPATH_INVALID";
    wrapped.runtimeTarget = { executablePath: exe, filesystemBasePath, filesystemHomePath };
    throw wrapped;
  }
  if (!baseStats.isDirectory()) {
    const wrapped = new Error(`CoD4-Dateisystem-Basispfad ist kein Ordner: ${filesystemBasePath}`);
    wrapped.code = "RUNTIME_BASEPATH_INVALID";
    wrapped.runtimeTarget = { executablePath: exe, filesystemBasePath, filesystemHomePath };
    throw wrapped;
  }
  const outputHandles = platform === "linux" ? await runtimeAdapter(platform).prepareOutput(filesystemHomePath, runtimeState.runId) : null;
  try { return await new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(exe, launchArgs, { cwd: filesystemBasePath, detached: true, windowsHide: true, stdio: outputHandles ? ["ignore", outputHandles[0].fd, outputHandles[1].fd] : ["ignore", "pipe", "pipe"], shell: false });
    monitorRuntimeChild(child, exe, filesystemBasePath, filesystemHomePath, platform);
    const onSpawn = () => { if (settled) return; settled = true; resolve(child); };
    const onError = (err) => { if (settled) return; settled = true; reject(describeRuntimeSpawnError(err, exe, filesystemBasePath)); };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  }); } finally { if (outputHandles) await Promise.all(outputHandles.map(handle => handle.close())); }
}

function monitorRuntimeChild(child, exe, workingDirectory, filesystemHomePath, platform) {
  const record = { runId: runtimeState.runId, exited: false, code: null, error: null, stopRequested: false };
  runtimeChildRecords.set(child, record);
  runtimeChild = child;
  const currentRun = () => runtimeState.runId === record.runId;
  for (const stream of ["stdout", "stderr"]) {
    child[stream]?.on("data", chunk => { if (currentRun()) appendRuntimeOutput(stream, chunk); });
    child[stream]?.on("error", err => { if (currentRun()) runtimeEvent("runtime.output.error", { stream, error: runtimeState.outputPolicy === 'private' ? 'RUNTIME_PRIVATE_OUTPUT_ERROR' : err.message }); });
  }
  child.on("error", err => {
    record.error = describeRuntimeSpawnError(err, exe, workingDirectory);
    if (currentRun()) {
      runtimeState.status = "FAILED";
      runtimeState.lastError = record.error.message;
      runtimeEvent("runtime.error", { pid: child.pid || null, executablePath: exe, error: record.error.message });
    }
    if (!child.pid && runtimeChild === child) runtimeChild = null;
  });
  child.on("exit", (code, signal) => {
    record.exited = true;
    record.code = code;
    if (currentRun()) {
      runtimeState.status = record.stopRequested ? "STOPPING" : "FAILED";
      runtimeState.exitCode = code;
      runtimeState.exitSignal = signal || null;
      runtimeState.pid = null;
      runtimeState.stoppedAt = new Date().toISOString();
      runtimeState.lastError = record.stopRequested ? "" : `${serverCoreDefinition(platform).executable} exited unexpectedly with code ${code}${signal ? ` (${signal})` : ""}`;
      runtimeEvent("runtime.exited", { pid: child.pid, code, signal: signal || null, expected: record.stopRequested, workingDirectory, filesystemHomePath });
    }
    if (runtimeChild === child) runtimeChild = null;
  });
}

async function startRuntime(options) {
  validateOutputPolicy(options);
  return withRuntimeOperation("start", () => startRuntimeUnlocked(options));
}

function validateOutputPolicy(options) {
  const policy = options?.outputPolicy === undefined ? 'standard' : options.outputPolicy;
  if (!['standard', 'private'].includes(policy)) throw Object.assign(new Error('Invalid runtime output policy.'), { code: 'RUNTIME_OUTPUT_POLICY_INVALID' });
  if (policy === 'private' && (options?.platform || runtimeState.platform) !== 'windows') throw Object.assign(new Error('Private output mode is currently Windows-only.'), { code: 'RUNTIME_PRIVATE_OUTPUT_UNSUPPORTED' });
}

async function startRuntimeUnlocked({relative,executablePath="",baseGamePath="",expectedCod4x="21.5",args=[],platform=runtimeState.platform||"windows",outputPolicy='standard'}) {
  const serverPlatform=normalizeServerPlatform(platform);
  runtimeAdapter(serverPlatform).assertHost();
  await reconcileRuntimeState();
  if(runtimeState.pid||["STARTING","RUNNING","STOPPING"].includes(runtimeState.status)||runtimeChild)throw new Error("Production Runtime is already running or requires recovery.");
  if(!policyState.security.allowedCod4xVersions.includes(expectedCod4x))throw new Error("Unsupported CoD4x version");

  const normalized=normalizeRuntimePath(relative||"./server");
  const resolved=await resolveServerTarget(normalized);
  const target=resolved.target;
  const exe=await resolveRuntimeExecutable({target,executablePath:executablePath||runtimeState.executablePath||"",platform:serverPlatform});
  const filesystemHomePath=path.resolve(target);
  const requestedBaseGamePath=selectRuntimeBaseGamePath(baseGamePath,runtimeState);
  const core=await verifiedRuntimeCoreStatus(exe,expectedCod4x,serverPlatform);
  if(!core.verified){
    const detail=core.reasons.length?`: ${core.reasons.join("; ")}`:"";
    const err=new Error(`Verified-Core gate blocked server start${detail}`);
    err.code="VERIFIED_CORE_BLOCKED";
    err.runtimeTarget={requested:normalized,resolved:target,executablePath:exe,filesystemBasePath:requestedBaseGamePath,filesystemHomePath,candidates:resolved.checks,core};
    throw err;
  }

  if(dependencies.beforeLaunch)await dependencies.beforeLaunch({filesystemHomePath,filesystemBasePath:requestedBaseGamePath,executablePath:exe});
  const layout=await resolveRuntimeLayout({coreExecutablePath:exe,baseGamePath:requestedBaseGamePath,serverHomePath:target});
  const filesystemBasePath=layout.filesystemBasePath;
  const coreWorkingDirectory=layout.coreWorkingDirectory;

  const extraArgs=Array.isArray(args)?args.map(String).slice(0,64):[];
  if(extraArgs.some(a=>/[\0\r\n]/.test(a)))throw new Error("Invalid runtime argument");
  const forbiddenFilesystemOverrides=new Set(["fs_basepath","fs_homepath"]);
  for(let i=0;i<extraArgs.length;i++){
    if(extraArgs[i]==="+set"&&forbiddenFilesystemOverrides.has(String(extraArgs[i+1]||"").toLowerCase())){
      const err=new Error(`Runtime argument darf ${extraArgs[i+1]} nicht überschreiben.`); err.code="RUNTIME_FILESYSTEM_OVERRIDE_BLOCKED"; throw err;
    }
  }
  const launchArgs=["+set","dedicated","2","+set","fs_basepath",filesystemBasePath,"+set","fs_homepath",filesystemHomePath,...extraArgs];
  let runtimePort = null;
  if (serverPlatform === "linux") {
    const ports = [];
    for (let index = 0; index < extraArgs.length; index++) if (extraArgs[index].toLowerCase() === "+set" && String(extraArgs[index + 1]).toLowerCase() === "net_port") ports.push(extraArgs[index + 2]);
    if (ports.length !== 1 || !/^\d+$/.test(ports[0]) || Number(ports[0]) < 1024 || Number(ports[0]) > 65535) throw Object.assign(new Error("Linux runtime needs one explicit unprivileged port."), { code: "INSTANCE_PROCESS_IDENTITY_BLOCKED" });
    runtimePort = Number(ports[0]);
  }
  runtimeState={...runtimeState,status:"STARTING",runId:crypto.randomUUID(),platform:serverPlatform,target:normalized,resolvedTarget:target,runtimeRoot:resolved.root,workingDirectory:coreWorkingDirectory,baseGamePath:filesystemBasePath,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,pid:null,exitCode:null,exitSignal:null,lastError:"",outputPolicy,consoleOutputPrivate:runtimeState.consoleOutputPrivate === true || outputPolicy === 'private',output:{stdout:"",stderr:"",stdoutTruncated:false,stderrTruncated:false}};
  runtimeState.credentialActivation = { state: 'NOT_APPLIED', runId: runtimeState.runId };
  if (serverPlatform === "linux") runtimeState.runtimePort = runtimePort;
  let child;
  try { await persistRuntimeState(); }
  catch (err) {
    runtimeState.status="FAILED";
    runtimeState.lastError=err.message;
    throw err;
  }
  try { child=await spawnRuntimeProcess(exe,launchArgs,filesystemHomePath,serverPlatform); }
  catch(err){
    runtimeState={...runtimeState,status:"FAILED",platform:serverPlatform,target:normalized,resolvedTarget:target,runtimeRoot:resolved.root,workingDirectory:coreWorkingDirectory,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,executable:serverCoreDefinition(serverPlatform).executable,pid:null,stoppedAt:new Date().toISOString(),exitCode:null,lastError:err.message};
    runtimeEvent("runtime.spawn.failed",{target:normalized,resolvedTarget:target,workingDirectory:coreWorkingDirectory,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,platform:serverPlatform,error:err.message,code:err.code||"RUNTIME_SPAWN_FAILED",spawnCode:err.spawnCode||null});
    throw err;
  }
  if(!child.pid){
    const err=new Error("Windows did not return a process ID."); err.code="RUNTIME_SPAWN_FAILED";
    runtimeState={...runtimeState,status:"FAILED",platform:serverPlatform,target:normalized,resolvedTarget:target,runtimeRoot:resolved.root,workingDirectory:coreWorkingDirectory,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,executable:serverCoreDefinition(serverPlatform).executable,pid:null,stoppedAt:new Date().toISOString(),exitCode:null,lastError:err.message};
    runtimeEvent("runtime.spawn.failed",{target:normalized,resolvedTarget:target,workingDirectory:coreWorkingDirectory,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,platform:serverPlatform,error:err.message,code:err.code});
    throw err;
  }
  const record=runtimeChildRecords.get(child);
  const assertChildStarted=()=>{
    if(record?.error)throw record.error;
    if(record?.exited){const err=new Error(runtimeState.lastError||`Runtime exited with code ${record.code} during start.`);err.code="RUNTIME_EARLY_EXIT";throw err;}
  };
  assertChildStarted();
  const processCheck=await waitForRuntimeProcess(child.pid,{expectedExecutable:serverCoreDefinition(serverPlatform).executable,expectedPath:exe});
  assertChildStarted();
  if(!processCheck.ok){
    const err=new Error(`Spawned PID ${child.pid} could not be verified as ${serverCoreDefinition(serverPlatform).executable} at the expected path.`); err.code="RUNTIME_PID_VERIFICATION_FAILED";
    runtimeState={...runtimeState,status:"FAILED",platform:serverPlatform,target:normalized,resolvedTarget:target,runtimeRoot:resolved.root,workingDirectory:coreWorkingDirectory,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,executable:serverCoreDefinition(serverPlatform).executable,pid:null,stoppedAt:new Date().toISOString(),exitCode:null,lastError:err.message};
    runtimeEvent("runtime.pid.verification.failed",{pid:child.pid,executablePath:exe,process:processCheck.info,code:err.code});
    // A failed identity check never authorizes killing that PID.
    // Retain the child reference so a later verified stop can recover it.
    throw err;
  }
  try {
    if (serverPlatform === "linux") dependencies.assertLinuxInstanceOwnership(processCheck.info, { ...(ownership || linuxOwnership()), uid: process.getuid(), gid: process.getgid() });
    else if(ownership)dependencies.assertWindowsInstanceOwnership(processCheck.info,ownership);
  }
  catch(error) {
    runtimeState.status="FAILED";runtimeState.lastError=error.message;
    runtimeEvent("runtime.instance.verification.failed",{pid:child.pid,code:error.code});
    throw error;
  }
  runtimeState.processCreatedAt=processCheck.info.createdAt||null;
  if (serverPlatform === "linux") runtimeState.output = await runtimeAdapter().readOutput(filesystemHomePath, runtimeState.runId, RUNTIME_OUTPUT_MAX_BYTES);
  runtimeState={...runtimeState,status:"RUNNING",platform:serverPlatform,target:normalized,resolvedTarget:target,runtimeRoot:resolved.root,workingDirectory:coreWorkingDirectory,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,executable:serverCoreDefinition(serverPlatform).executable,pid:child.pid,startedAt:new Date().toISOString(),stoppedAt:null,exitCode:null,lastError:""};
  runtimeEvent("runtime.started",{pid:child.pid,target:normalized,resolvedTarget:target,workingDirectory:coreWorkingDirectory,filesystemBasePath,filesystemHomePath,executablePath:exe,cod4x:expectedCod4x,platform:serverPlatform,args:launchArgs});
  child.unref();
  return runtimeState;
}

async function stopRuntime(reason = "manual") {
  return withRuntimeOperation("stop", () => stopRuntimeUnlocked(reason));
}

async function stopRuntimeUnlocked(reason = "manual") {
  await reconcileRuntimeState();
  const pid=Number(runtimeState.pid||runtimeChild?.pid||0);
  if(!pid){runtimeState.status=runtimeState.status==="FAILED"?"FAILED":"STOPPED";runtimeState.pid=null;runtimeState.updatedAt=new Date().toISOString();await persistRuntimeState();return runtimeState;}
  const adapter = runtimeAdapter();
  adapter.assertHost();
  const info=await adapter.inspectProcess(pid);
  const expected=serverCoreDefinition(runtimeState.platform).executable;
  if(info.alive===false){runtimeState.status="STOPPED";runtimeState.pid=null;runtimeState.stoppedAt=new Date().toISOString();runtimeEvent("runtime.stopped",{pid,reason:"already-exited",executable:expected});return runtimeState;}
  assertRuntimeProcessIdentity(info,runtimeState.executablePath);
  const record=runtimeChild ? runtimeChildRecords.get(runtimeChild) : null;
  if(record)record.stopRequested=true;
  try {
  let gracefulStopError=null;
  try { await adapter.terminate(pid, false); }
  catch(err) { gracefulStopError=err; }
  let stopped=await waitForRuntimeProcess(pid,{requireGone:true,timeoutMs:RUNTIME_STOP_GRACE_MS});
  let forced=false;
  if(!stopped.ok){
    const currentInfo=await adapter.inspectProcess(pid);
    if(currentInfo.alive===false){stopped={ok:true,info:currentInfo};}
    else {
    assertRuntimeProcessIdentity(currentInfo,runtimeState.executablePath);
    forced=true;
    await adapter.terminate(pid, true);
    stopped=await waitForRuntimeProcess(pid,{requireGone:true,timeoutMs:3_000});
    }
  }
  if(!stopped.ok){const err=new Error(`Runtime PID ${pid} is still active after stop${gracefulStopError?`: ${gracefulStopError.message}`:""}.`);err.code="RUNTIME_STOP_VERIFICATION_FAILED";throw err;}
  runtimeState.status="STOPPED";runtimeState.pid=null;runtimeState.stoppedAt=new Date().toISOString();runtimeState.exitCode=null;runtimeState.lastError="";runtimeEvent("runtime.stopped",{pid,reason,executable:expected,forced});if(runtimeChild)runtimeChild=null;return runtimeState;
  } catch(err) {
    if(record&&!record.exited)record.stopRequested=false;
    throw err;
  }
}

async function restartRuntime(options) {
  validateOutputPolicy(options);
  return withRuntimeOperation("restart", async () => {
    await stopRuntimeUnlocked("restart");
    await persistRuntimeState();
    return startRuntimeUnlocked(options);
  });
}


// Runtime manager API
return {
  get state() { return runtimeState; },
  get busy() { return Boolean(runtimeState.recoveryBlocked || runtimeOperation || runtimeChild || ["STARTING","RUNNING","STOPPING"].includes(runtimeState.status) || runtimeState.pid); },
  loadRuntimeState, persistRuntimeState, runtimeEvent, withRuntimeConfiguration,
  inspectProcess: pid => runtimeAdapter().inspectProcess(pid),
  reconcileRuntimeState, startRuntime, stopRuntime, restartRuntime,
};
}

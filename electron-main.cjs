const {app,BrowserWindow,dialog,ipcMain,safeStorage,shell,utilityProcess} = require('electron');
const path=require('path');
const crypto=require('crypto');
let server=null;
const PORT=8787;
const HOST='127.0.0.1';
// Security audit 4.18.26 (A5-1): the renderer is a file:// page, so its requests carry
// Origin "null" like a sandboxed foreign page. A secret per launch, known only to this
// process and the backend it starts, marks the requests that really come from our window.
const DESKTOP_CLIENT_TOKEN=crypto.randomBytes(32).toString('hex');
// Security audit 4.18.26 (A6-1): windows show only the app page, links open in the system
// browser, the desktop header and the IPC handlers serve only the main window's app page.
const {isAppPage,externalUrlAllowed,desktopHeaderAllowed,permissionAllowed,rememberedLoginBackendAllowed}=require('./lib/electron-navigation-policy.cjs');
const {openCappedLog}=require('./lib/capped-log.cjs');
const {createReadyWatcher}=require('./lib/backend-ready.cjs');
const APP_INDEX=path.join(__dirname,'dist','index.html');
// Debug phase (4.18.31): one CONTROL per user session. A second launch started a second backend that
// failed on the busy port (dialog "exited with code 1") while its window talked to the first
// backend with the wrong per-launch secret and was refused. Now the second launch focuses the first window.
// Issue #67 (A6-8): --cod4x-backend-only runs only the packaged backend, with no window, its output on
// this process's stdout and the environment as given (PORT, COD4X_DATA_ROOT, ...). The release
// installer gate uses it, since the RunAsNode fuse is off and the binary no longer runs as plain Node.
// It runs nothing but installer-server.mjs from the (integrity-checked) app.asar.
const BACKEND_ONLY=process.argv.includes('--cod4x-backend-only');
const SINGLE_INSTANCE=BACKEND_ONLY||app.requestSingleInstanceLock();
if(!SINGLE_INSTANCE) app.quit();
app.on('second-instance',()=>{const win=BrowserWindow.getAllWindows()[0]; if(win){ if(win.isMinimized()) win.restore(); win.focus(); }});
let mainWebContentsId=null;
function handle(channel, listener){
  ipcMain.handle(channel, (event, ...args) => {
    if(event.sender.id!==mainWebContentsId||!event.senderFrame||event.senderFrame.parent||!isAppPage(event.senderFrame.url,APP_INDEX)) throw new Error('IPC_SENDER_REFUSED');
    return listener(event, ...args);
  });
}
app.on('web-contents-created',(_event,contents)=>{
  contents.setWindowOpenHandler(({url}) => { if(externalUrlAllowed(url)) shell.openExternal(url).catch(()=>{}); return {action:'deny'}; });
  const stay=(event,url)=>{ if(!isAppPage(url,APP_INDEX)) event.preventDefault(); };
  contents.on('will-navigate',stay);
  contents.on('will-redirect',stay);
  contents.on('will-attach-webview',event=>event.preventDefault());
});
handle('select-runtime-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select the CoD4x runtime directory',
    properties: ['openDirectory'],
    buttonLabel: 'Select',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});
handle('select-runtime-executable', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select the CoD4x dedicated server core',
    properties: ['openFile'],
    // Linux cores (cod4x18_dedrun) have no extension; Windows cores are .exe.
    ...(process.platform === 'win32' ? { filters: [{ name: 'CoD4x dedicated server', extensions: ['exe'] }] } : {}),
    buttonLabel: 'Select',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// 4.17.6 — Optional remembered login credential.
// The password is never written as plaintext. Electron safeStorage uses the
// operating-system credential protection (Windows DPAPI on supported Windows
// configurations) and the encrypted value is stored only below app.getPath('userData').
const REMEMBERED_LOGIN_FILE = () => path.join(app.getPath('userData'), 'remembered-login.json');

// 4.18.17: asynchronous safeStorage API (the synchronous one is deprecated in
// Electron 45). Values written by the old API decrypt unchanged.
// Security audit 4.18.26 (A6-4): not with the fixed-key fallback on Linux.
async function rememberedLoginAvailable(){
  try {
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : undefined;
    if (!rememberedLoginBackendAllowed(process.platform, backend)) return false;
    return Boolean(await safeStorage.isAsyncEncryptionAvailable());
  } catch { return false; }
}

async function writeRememberedLogin(username, password){
  const fs = require('fs/promises');
  const file = REMEMBERED_LOGIN_FILE();
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(file), {recursive:true, mode:0o700});
  const encrypted = (await safeStorage.encryptStringAsync(password)).toString('base64');
  await fs.writeFile(tmp, JSON.stringify({version:1, username, password:encrypted}) + '\n', {encoding:'utf8', mode:0o600});
  await fs.rename(tmp, file);
}

async function readRememberedLogin(){
  if (!(await rememberedLoginAvailable())) {
    // A login stored under weak protection by an older version is removed (A6-4).
    await require('fs/promises').rm(REMEMBERED_LOGIN_FILE(), {force:true}).catch(() => {});
    return {available:false, credentials:null};
  }
  try {
    const fs = require('fs/promises');
    if (process.platform !== 'win32') await fs.chmod(REMEMBERED_LOGIN_FILE(), 0o600).catch(() => {});
    const raw = JSON.parse(await fs.readFile(REMEMBERED_LOGIN_FILE(), 'utf8'));
    if (!raw || raw.version !== 1 || typeof raw.username !== 'string' || typeof raw.password !== 'string') {
      return {available:true, credentials:null};
    }
    const {result: password, shouldReEncrypt} = await safeStorage.decryptStringAsync(Buffer.from(raw.password, 'base64'));
    if (!password) return {available:true, credentials:null};
    // The OS key was rotated: store the value again under the current key.
    if (shouldReEncrypt) await writeRememberedLogin(raw.username, password).catch(() => {});
    return {available:true, credentials:{username:raw.username, password}};
  } catch {
    return {available:true, credentials:null};
  }
}

handle('get-remembered-login', async () => readRememberedLogin());

handle('save-remembered-login', async (_event, payload) => {
  if (!(await rememberedLoginAvailable())) return {ok:false, available:false};
  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '');
  if (!username || !password) return {ok:false, available:true};
  await writeRememberedLogin(username, password);
  return {ok:true, available:true};
});

handle('clear-remembered-login', async () => {
  try {
    const fs = require('fs/promises');
    await fs.rm(REMEMBERED_LOGIN_FILE(), {force:true});
  } catch {}
  return {ok:true};
});

// Debug phase (4.18.31): the backend's own output (start errors such as a busy port, crashes) goes to
// <userData>/logs/backend.log instead of nowhere. The output runs through a pipe into a capped log, so
// the file stays below 2 MB (plus one rotation, backend.log.1) also while a long session keeps logging.
let backendReady=false; // until then a failed start is reported once, by createWindow
// Audit 4.18.31 (S-1): set only by the ready line on the stdout pipe of the backend we started.
let backendListening=false;
const BACKEND_LOG=()=>path.join(app.getPath('userData'),'logs','backend.log');
// Issue #67 (A6-8): the backend runs in an Electron utility process (Node without a window) instead of
// "electron.exe + ELECTRON_RUN_AS_NODE". So the RunAsNode fuse can be off, and the signed binary cannot
// be made to run any script by setting one environment variable.
let serverExited=false;
function startBackend(){
  const serverPath=path.join(__dirname,'installer-server.mjs');
  const log=BACKEND_ONLY?{write:chunk=>process.stdout.write(chunk),close(){}}:openCappedLog(BACKEND_LOG(),{maxBytes:2*1024*1024});
  const env=BACKEND_ONLY?{...process.env}:{...process.env,PORT:String(PORT),HOST,COD4X_DATA_ROOT:app.getPath('userData'),COD4X_RUNTIME_MODE:'interactive',COD4X_DESKTOP_CLIENT_TOKEN:DESKTOP_CLIENT_TOKEN};
  delete env.ELECTRON_RUN_AS_NODE;
  server=utilityProcess.fork(serverPath,[],{env,cwd:BACKEND_ONLY?process.cwd():app.getPath('userData'),stdio:['ignore','pipe','pipe'],serviceName:'COD4X CONTROL backend'});
  const readyWatcher=createReadyWatcher();
  server.stdout.on('data',chunk=>{log.write(chunk);if(!backendListening&&readyWatcher(chunk))backendListening=true;});
  server.stderr.on('data',chunk=>BACKEND_ONLY?process.stderr.write(chunk):log.write(chunk));
  // Audit 4.18.31 (S-1): any end of the backend (also exit code 0) closes the app, so the window
  // never keeps talking to the port after our backend is gone.
  server.on('exit',code=>{serverExited=true;backendListening=false;log.close();
    if(BACKEND_ONLY){app.exit(code||0);return;}
    if(!app.isQuitting && backendReady){dialog.showErrorBox('COD4X CONTROL','The local backend stopped (exit code '+code+'). Details: '+BACKEND_LOG());app.quit();}});
}
// Audit 4.18.31 (S-1): ready means our own child printed the ready line after it bound the port.
// An HTTP answer on the port proves nothing: another program may have taken it first.
function waitForBackend(retries=200){
  return new Promise(resolve=>{
    const attempt=()=>{
      // Our backend ended (e.g. the port is taken by another program): never talk to whatever answers there.
      if(server&&serverExited) return resolve(false);
      if(backendListening) return resolve(true);
      if(--retries<=0) return resolve(false);
      setTimeout(attempt,100);
    };
    attempt();
  });
}

async function createWindow(){
  const win=new BrowserWindow({width:1440,height:960,minWidth:1100,minHeight:720,backgroundColor:'#09090f',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(__dirname,'electron-preload.cjs')}});
  mainWebContentsId=win.webContents.id;
  win.webContents.session.webRequest.onBeforeSendHeaders({urls:[`http://${HOST}:${PORT}/*`]},(details,callback)=>{
    if(desktopHeaderAllowed(details,mainWebContentsId,APP_INDEX)) details.requestHeaders['X-COD4X-Desktop']=DESKTOP_CLIENT_TOKEN;
    else delete details.requestHeaders['X-COD4X-Desktop'];
    callback({requestHeaders:details.requestHeaders});
  });
  const ok=await waitForBackend();
  if(!ok){ dialog.showErrorBox('COD4X CONTROL','The local backend could not be started. Is port 8787 used by another program? Details: '+BACKEND_LOG()); app.quit(); return; }
  backendReady=true;
  win.loadFile(APP_INDEX);
}
// Security audit 4.18.26 (A6-3): refuse every web permission except what permissionAllowed grants.
function restrictPermissions(session){
  session.setPermissionRequestHandler((contents,permission,callback)=>callback(permissionAllowed({permission,webContentsId:contents?.id,url:contents?.getURL?.()},mainWebContentsId,APP_INDEX)));
  session.setPermissionCheckHandler((contents,permission)=>permissionAllowed({permission,webContentsId:contents?.id,url:contents?.getURL?.()},mainWebContentsId,APP_INDEX));
}
app.whenReady().then(async()=>{if(!SINGLE_INSTANCE)return;if(BACKEND_ONLY){startBackend();return;}restrictPermissions(require('electron').session.defaultSession);startBackend();await createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('before-quit',()=>{app.isQuitting=true;if(server)server.kill();});
app.on('window-all-closed',()=>{if(!BACKEND_ONLY&&process.platform!=='darwin')app.quit();});
if(BACKEND_ONLY) for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{app.isQuitting=true;if(server&&!serverExited)server.kill();else app.exit(0);});

const {app,BrowserWindow,dialog,ipcMain,safeStorage} = require('electron');
const http = require('http');
const {spawn} = require('child_process');
const path=require('path');
let server=null;
const PORT=8787;
const HOST='127.0.0.1';
ipcMain.handle('select-runtime-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'CoD4x Runtime-Verzeichnis auswählen',
    properties: ['openDirectory'],
    buttonLabel: 'Übernehmen',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});
ipcMain.handle('select-runtime-executable', async () => {
  const result = await dialog.showOpenDialog({
    title: 'COD4-Spiel-EXE auswählen',
    properties: ['openFile'],
    filters: [{ name: 'Call of Duty 4', extensions: ['exe'] }],
    buttonLabel: 'Übernehmen',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// 4.17.6 — Optional remembered login credential.
// The password is never written as plaintext. Electron safeStorage uses the
// operating-system credential protection (Windows DPAPI on supported Windows
// configurations) and the encrypted value is stored only below app.getPath('userData').
const REMEMBERED_LOGIN_FILE = () => path.join(app.getPath('userData'), 'remembered-login.json');

function rememberedLoginAvailable(){
  try { return Boolean(safeStorage.isEncryptionAvailable()); } catch { return false; }
}

async function readRememberedLogin(){
  if (!rememberedLoginAvailable()) return {available:false, credentials:null};
  try {
    const fs = require('fs/promises');
    const raw = JSON.parse(await fs.readFile(REMEMBERED_LOGIN_FILE(), 'utf8'));
    if (!raw || raw.version !== 1 || typeof raw.username !== 'string' || typeof raw.password !== 'string') {
      return {available:true, credentials:null};
    }
    const password = safeStorage.decryptString(Buffer.from(raw.password, 'base64'));
    if (!password) return {available:true, credentials:null};
    return {available:true, credentials:{username:raw.username, password}};
  } catch {
    return {available:true, credentials:null};
  }
}

ipcMain.handle('get-remembered-login', async () => readRememberedLogin());

ipcMain.handle('save-remembered-login', async (_event, payload) => {
  if (!rememberedLoginAvailable()) return {ok:false, available:false};
  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '');
  if (!username || !password) return {ok:false, available:true};
  const fs = require('fs/promises');
  const file = REMEMBERED_LOGIN_FILE();
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(file), {recursive:true});
  const encrypted = safeStorage.encryptString(password).toString('base64');
  await fs.writeFile(tmp, JSON.stringify({version:1, username, password:encrypted}) + '\n', {encoding:'utf8'});
  await fs.rename(tmp, file);
  return {ok:true, available:true};
});

ipcMain.handle('clear-remembered-login', async () => {
  try {
    const fs = require('fs/promises');
    await fs.rm(REMEMBERED_LOGIN_FILE(), {force:true});
  } catch {}
  return {ok:true};
});

function startBackend(){
  const serverPath=path.join(__dirname,'installer-server.mjs');
  server=spawn(process.execPath,[serverPath],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(PORT),HOST,COD4X_DATA_ROOT:app.getPath('userData'),COD4X_RUNTIME_MODE:'interactive'},cwd:app.getPath('userData'),stdio:'ignore'});
  server.on('exit',code=>{if(code && !app.isQuitting){dialog.showErrorBox('COD4X CONTROL','Installer backend exited with code '+code);}});
}
function waitForBackend(retries=40){
  return new Promise(resolve=>{
    const attempt=()=>{
      const req=http.get({host:HOST,port:PORT,path:'/api/installer/health',timeout:500},res=>{
        res.resume();
        if(res.statusCode===200) return resolve(true);
        retry();
      });
      req.on('error',retry); req.on('timeout',()=>{req.destroy(); retry();});
    };
    const retry=()=>{ if(--retries<=0) return resolve(false); setTimeout(attempt,150); };
    attempt();
  });
}

async function createWindow(){
  const win=new BrowserWindow({width:1440,height:960,minWidth:1100,minHeight:720,backgroundColor:'#09090f',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(__dirname,'electron-preload.cjs')}});
  const ok=await waitForBackend();
  if(!ok){ dialog.showErrorBox('COD4X CONTROL','Das lokale Installer-Backend konnte nicht gestartet werden.'); app.quit(); return; }
  win.loadFile(path.join(__dirname,'dist','index.html'));
}
app.whenReady().then(async()=>{startBackend();await createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('before-quit',()=>{app.isQuitting=true;if(server)server.kill();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});

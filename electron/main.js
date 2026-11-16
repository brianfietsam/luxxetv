'use strict';
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const { start } = require('../server');

let win, tray, srv, quitting = false;
const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function showWindow() { if (!win) return; win.show(); win.focus(); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: '#0e1116', title: 'LuxxeTV', icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${srv.port}/?desktop=${srv.desktopToken}`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Closing hides to tray so scheduled recordings keep running.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('LuxxeTV DVR');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open LuxxeTV', click: showWindow },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }); } },
    { type: 'separator' },
    { label: 'Quit (stops recordings)', click: () => app.quit() },
  ]));
  rebuild();
  tray.on('click', showWindow);
}

app.whenReady().then(async () => {
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose recording folder' });
    return r.canceled ? null : r.filePaths[0];
  });
  try {
    srv = await start({ dataDir: app.getPath('userData') });
  } catch (e) {
    dialog.showErrorBox('LuxxeTV could not start', `${e.message}\n\nIs another copy running or is the port in use? Change the port in config.json.`);
    return app.exit(1);
  }
  createWindow();
  createTray();
  if (process.argv.includes('--hidden')) win.hide();
});

app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  if (srv) { e.preventDefault(); await srv.shutdown().catch(() => {}); srv = null; app.quit(); }
});
app.on('window-all-closed', () => { /* keep running in tray */ });

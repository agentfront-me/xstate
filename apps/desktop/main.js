// xstate desktop: an Electron shell around the dashboard in apps/www/public/app.
//
// The dashboard files are served from app://xstate/ (bundled into the app as resources/web), so the app opens
// offline and needs no web server. Sign-in pages (/login, /signup) come along too. Pass --dev (or set XSTATE_DEV_URL) to load a
// dev server instead, by default http://localhost:8787/app/ (`pnpm --filter @xstate/desktop dev`).

import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, shell, Tray } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'
const DEV_URL = process.env.XSTATE_DEV_URL || (process.argv.includes('--dev') ? 'http://localhost:8787/app/' : null)
const START_URL = DEV_URL ?? 'app://xstate/app/'
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(here, '../www/public')
const API_URL = process.env.XSTATE_API_URL || null
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')
const DEFAULTS = { notifications: true, menuBar: false, autoUpdate: true }
const COLORS = { light: { bg: '#ffffff', fg: '#3f3f46' }, dark: { bg: '#0a0a0a', fg: '#d4d4d8' } }

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

/** @type {BrowserWindow | null} */
let win = null
/** @type {Tray | null} */
let tray = null
let unread = 0
let quitting = false

// ---------------------------------------------------------------------------------------------------------------
// Settings, kept in userData/settings.json. Launch at login lives with the OS, not in the file.

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2))
}

function allSettings() {
  return { ...readSettings(), launchAtLogin: app.getLoginItemSettings().openAtLogin }
}

function applySetting(key, value) {
  if (key === 'launchAtLogin') {
    app.setLoginItemSettings({ openAtLogin: value, openAsHidden: true })
    return
  }
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`)
  writeSettings({ ...readSettings(), [key]: value })
  if (key === 'menuBar') syncTray()
  if (key === 'autoUpdate') updater().then((u) => u && (u.autoDownload = value))
}

// ---------------------------------------------------------------------------------------------------------------
// Serving app://xstate/ from the web folder

function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath)
  if (rel.endsWith('/')) rel += 'index.html'
  const file = path.normalize(path.join(WEB_ROOT, rel))
  if (!file.startsWith(WEB_ROOT + path.sep)) return null
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  // Pretty URLs, like the site's "auto-trailing-slash": /login → /login/index.html, /about → /about.html.
  for (const candidate of [path.join(file, 'index.html'), `${file}.html`]) if (fs.existsSync(candidate)) return candidate
  return null
}

function serveApp() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url)
    const file = resolveFile(pathname)
    if (!file) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    return net.fetch(pathToFileURL(file).toString())
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Window

function isOurs(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'app:' || (DEV_URL && u.origin === new URL(DEV_URL).origin)
  } catch {
    return false
  }
}

function themeColors() {
  return nativeTheme.shouldUseDarkColors ? COLORS.dark : COLORS.light
}

function createWindow() {
  const colors = themeColors()
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'xstate',
    backgroundColor: colors.bg,
    // The dashboard draws its own top bar; on macOS the traffic lights sit over the rail, elsewhere the window
    // controls overlay the top right corner.
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 18, y: 17 } } : { titleBarOverlay: { color: colors.bg, symbolColor: colors.fg, height: 49 } }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden') && !app.getLoginItemSettings().wasOpenedAsHidden) win.show()
  })
  win.loadURL(START_URL)

  // The dev server may still be starting: try again rather than leave an error page up.
  win.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (isMainFrame && DEV_URL && code !== -3) setTimeout(() => win?.loadURL(url || START_URL), 1000)
  })

  // Links to other sites (docs, Claude connectors, mailto:) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOurs(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })

  // With the menu bar icon on, closing the window keeps xstate running there. macOS keeps apps running anyway.
  win.on('close', (event) => {
    if (!quitting && (isMac || readSettings().menuBar)) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => (win = null))
}

function showWindow() {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function send(command) {
  showWindow()
  win.webContents.send('xstate:command', command)
}

// ---------------------------------------------------------------------------------------------------------------
// Menu bar (tray) icon with the unread count

function syncTray() {
  const want = readSettings().menuBar
  if (!want) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    const image = nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate.png'))
    image.setTemplateImage(true)
    tray = new Tray(image)
    tray.setToolTip('xstate')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open xstate', click: showWindow },
        { label: 'New mail', click: () => send('new-mail') },
        { label: 'Settings…', click: () => send('settings') },
        { type: 'separator' },
        { label: 'Quit xstate', click: () => app.quit() },
      ]),
    )
    if (!isMac) tray.on('click', showWindow)
  }
  if (isMac) tray.setTitle(unread ? String(unread) : '')
  tray.setToolTip(unread ? `xstate · ${unread} unread` : 'xstate')
}

// ---------------------------------------------------------------------------------------------------------------
// Updates. electron-updater reads the feed from the `publish` setting in package.json; it only works in a
// packaged build.

let updaterPromise = null
function updater() {
  if (!app.isPackaged) return Promise.resolve(null)
  updaterPromise ??= import('electron-updater')
    .then(({ default: pkg }) => {
      const { autoUpdater } = pkg
      autoUpdater.autoDownload = readSettings().autoUpdate
      autoUpdater.autoInstallOnAppQuit = true
      return autoUpdater
    })
    .catch(() => null)
  return updaterPromise
}

async function checkForUpdates() {
  const u = await updater()
  if (!u) return 'Updates are checked in the installed app.'
  const result = await u.checkForUpdates()
  if (!result?.isUpdateAvailable) return `You're on the latest version (${app.getVersion()}).`
  return u.autoDownload
    ? `Version ${result.updateInfo.version} is downloading. It installs when you restart xstate.`
    : `Version ${result.updateInfo.version} is available. Turn on automatic updates to install it.`
}

// ---------------------------------------------------------------------------------------------------------------
// App menu

function buildMenu() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New mail', accelerator: 'CmdOrCtrl+N', click: () => send('new-mail') },
        ...(isMac ? [] : [{ label: 'Settings', accelerator: 'Ctrl+,', click: () => send('settings') }]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------------------------------------------
// IPC from preload.cjs

ipcMain.on('xstate:info', (event) => {
  event.returnValue = { version: app.getVersion(), apiUrl: API_URL }
})
ipcMain.handle('xstate:get-settings', () => allSettings())
ipcMain.handle('xstate:set-setting', (_event, key, value) => {
  applySetting(String(key), Boolean(value))
  return allSettings()
})
ipcMain.handle('xstate:check-updates', () => checkForUpdates())
ipcMain.on('xstate:theme', (_event, choice) => {
  nativeTheme.themeSource = ['light', 'dark'].includes(choice) ? choice : 'system'
  const colors = themeColors()
  win?.setBackgroundColor(colors.bg)
  if (!isMac) win?.setTitleBarOverlay?.({ color: colors.bg, symbolColor: colors.fg })
})
ipcMain.on('xstate:unread', (_event, count) => {
  unread = Math.max(0, Number(count) || 0)
  if (isMac) app.dock?.setBadge(unread ? String(unread) : '')
  else app.setBadgeCount(unread)
  if (tray) syncTray()
})

// ---------------------------------------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('before-quit', () => (quitting = true))
  app.on('activate', showWindow)
  app.on('window-all-closed', () => {
    if (!isMac && !readSettings().menuBar) app.quit()
  })

  app.whenReady().then(() => {
    serveApp()
    buildMenu()
    createWindow()
    syncTray()
    if (readSettings().autoUpdate) updater().then((u) => u?.checkForUpdates().catch(() => null))
  })
}

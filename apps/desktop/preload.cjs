// Exposes `window.xstateDesktop` to the dashboard (see apps/www/src/lib/core.ts). Only these calls cross into
// the main process; the page gets no Node access.

const { contextBridge, ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('xstate:info')
const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

contextBridge.exposeInMainWorld('xstateDesktop', {
  platform: process.platform,
  platformName: PLATFORM_NAMES[process.platform] ?? process.platform,
  version: info.version,
  /** Overrides the API the dashboard calls, from XSTATE_API_URL. Null means the default for the page's origin. */
  apiUrl: info.apiUrl ?? undefined,
  getSettings: () => ipcRenderer.invoke('xstate:get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('xstate:set-setting', key, value),
  checkForUpdates: () => ipcRenderer.invoke('xstate:check-updates'),
  setTheme: (choice) => ipcRenderer.send('xstate:theme', choice),
  setUnread: (count) => ipcRenderer.send('xstate:unread', count),
  /** Menu and menu bar commands: 'settings', 'new-mail'. */
  onCommand: (fn) => ipcRenderer.on('xstate:command', (_event, command) => fn(command)),
})

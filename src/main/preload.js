/**
 * Preload — VK Video Engagement Tool
 * Exposes API to renderer via contextBridge
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Proxy
  proxy: {
    getAll: () => ipcRenderer.invoke('proxy:getAll'),
    add: (proxy) => ipcRenderer.invoke('proxy:add', proxy),
    remove: (id) => ipcRenderer.invoke('proxy:remove', id),
    bulkRemove: (ids) => ipcRenderer.invoke('proxy:bulkRemove', ids),
    test: (id) => ipcRenderer.invoke('proxy:test', id),
    import: () => ipcRenderer.invoke('proxy:import'),
    // Best-Proxies.ru API
    fetchBestProxies: (opts) => ipcRenderer.invoke('proxy:fetchBestProxies', opts),
    getBestProxiesStats: (key) => ipcRenderer.invoke('proxy:getBestProxiesStats', key),
    getBestProxiesKeyInfo: (key, format) => ipcRenderer.invoke('proxy:getBestProxiesKeyInfo', key, format),
    clearBestProxies: () => ipcRenderer.invoke('proxy:clearBestProxies'),
  },

  // Accounts
  account: {
    getAll: () => ipcRenderer.invoke('account:getAll'),
    add: (acc) => ipcRenderer.invoke('account:add', acc),
    remove: (id) => ipcRenderer.invoke('account:remove', id),
    bulkRemove: (ids) => ipcRenderer.invoke('account:bulkRemove', ids),
    removeInvalid: () => ipcRenderer.invoke('account:removeInvalid'),
    importLogpass: (text) => ipcRenderer.invoke('account:importLogpass', text),
    importFromText: (text, opts) => ipcRenderer.invoke('account:importFromText', text, opts),
    importFromFiles: (opts) => ipcRenderer.invoke('account:importFromFiles', opts),
    importCookies: (id) => ipcRenderer.invoke('account:importCookies', id),
    verify: (id) => ipcRenderer.invoke('account:verify', id),
    bulkVerify: (ids) => ipcRenderer.invoke('account:bulkVerify', ids),
    onVerifyProgress: (cb) => ipcRenderer.on('account:verifyProgress', (_, d) => cb(d)),
  },

  // Comments
  comments: {
    getAll: () => ipcRenderer.invoke('comments:getAll'),
    add: (c) => ipcRenderer.invoke('comments:add', c),
    remove: (id) => ipcRenderer.invoke('comments:remove', id),
    bulkRemove: (ids) => ipcRenderer.invoke('comments:bulkRemove', ids),
    quickImport: (text) => ipcRenderer.invoke('comments:quickImport', text),
    importFile: () => ipcRenderer.invoke('comments:importFile'),
  },

  // Comment Folders
  commentFolders: {
    getAll: () => ipcRenderer.invoke('commentFolders:getAll'),
    create: (folder) => ipcRenderer.invoke('commentFolders:create', folder),
    rename: (id, name) => ipcRenderer.invoke('commentFolders:rename', id, name),
    delete: (id) => ipcRenderer.invoke('commentFolders:delete', id),
    addComment: (folderId, text) => ipcRenderer.invoke('commentFolders:addComment', folderId, text),
    removeComment: (folderId, commentId) => ipcRenderer.invoke('commentFolders:removeComment', folderId, commentId),
    quickImport: (folderId, text) => ipcRenderer.invoke('commentFolders:quickImport', folderId, text),
    importFile: (folderId) => ipcRenderer.invoke('commentFolders:importFile', folderId),
  },

  // Tasks
  task: {
    getAll: () => ipcRenderer.invoke('task:getAll'),
    create: (t) => ipcRenderer.invoke('task:create', t),
    remove: (id) => ipcRenderer.invoke('task:remove', id),
    start: (id) => ipcRenderer.invoke('task:start', id),
    stop: (id) => ipcRenderer.invoke('task:stop', id),
    startAll: () => ipcRenderer.invoke('task:startAll'),
    stopAll: () => ipcRenderer.invoke('task:stopAll'),
    onProgress: (cb) => ipcRenderer.on('task:progress', (_, d) => cb(d)),
  },

  // Settings
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (s) => ipcRenderer.invoke('settings:save', s),
  },

  // Logs
  logs: {
    clear: () => ipcRenderer.invoke('logs:clear'),
    onEntry: (cb) => ipcRenderer.on('log:entry', (_, d) => cb(d)),
    onClear: (cb) => ipcRenderer.on('log:clear', () => cb()),
  },
});

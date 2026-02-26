/**
 * VK Video Engagement Tool v1.0 — Main Process
 *
 * Electron main process with:
 * - VK account management (login/pass + cookies)
 * - Best-Proxies.ru API integration
 * - Task queue for video engagement
 * - Comment folders system
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { TaskQueue } = require('./taskQueue');
const { PlaywrightEngine } = require('./playwrightEngine');
const { ProxyManager } = require('./proxyManager');
const { AccountManager } = require('./accountManager');
const { CookieParser } = require('./cookieParser');

const store = new Store({
  name: 'vk-video-engagement-config',
  defaults: {
    proxies: [],
    accounts: [],
    comments: [],
    commentFolders: [],
    tasks: [],
    settings: {
      typingDelay: { min: 50, max: 150 },
      scrollDelay: { min: 1000, max: 3000 },
      watchDuration: { min: 30, max: 120 },
      headless: false,
      stealth: true,
      maxConcurrency: 3,
      warmUp: {
        homePageMin: 3,
        homePageMax: 8,
        scrollPauseMin: 1.5,
        scrollPauseMax: 5,
        videoWatchMin: 5,
        videoWatchMax: 25,
        scenarioWeight: { chill: 30, curious: 25, explorer: 20, searcher: 15, impatient: 10 },
      },
      bestProxiesKey: '',
      ruCaptchaKey: '',
    },
  },
});

let mainWindow;
let taskQueue;
let playwrightEngine;
let proxyManager;
let accountManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 880, minWidth: 1024, minHeight: 700,
    title: 'VK Video Engagement Tool v1.0',
    icon: path.join(__dirname, '../renderer/assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: true,
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function initModules() {
  proxyManager = new ProxyManager(store);
  accountManager = new AccountManager(store);
  playwrightEngine = new PlaywrightEngine(store, proxyManager, accountManager);
  taskQueue = new TaskQueue(store, playwrightEngine);
  playwrightEngine.setLogger((msg) => sendLog('info', msg));

}

function sendLog(level, message) {
  console.log(`[LOG:${level}] ${message}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log:entry', { timestamp: new Date().toISOString(), level, message });
  }
}

function setupIPC() {
  // ===== PROXY =====
  ipcMain.handle('proxy:getAll', () => proxyManager.getAll());
  ipcMain.handle('proxy:add', (_, proxy) => {
    const r = proxyManager.add(proxy);
    sendLog('info', `Proxy added: ${proxy.host}:${proxy.port}`);
    return r;
  });
  ipcMain.handle('proxy:remove', (_, id) => proxyManager.remove(id));
  ipcMain.handle('proxy:bulkRemove', (_, ids) => proxyManager.bulkRemove(ids));
  ipcMain.handle('proxy:test', async (_, id) => {
    sendLog('info', 'Testing proxy...');
    const r = await proxyManager.test(id);
    sendLog(r.success ? 'success' : 'error',
      r.success ? `Proxy OK (${r.ip}, ${r.latency}ms)` : `Proxy dead: ${r.error}`);
    return r;
  });
  ipcMain.handle('proxy:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Text', extensions: ['txt'] }], properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { count: 0 };
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    let count = 0;
    for (const line of lines) {
      try {
        const parsed = proxyManager.parseLine(line.trim());
        if (parsed) { proxyManager.add(parsed); count++; }
      } catch (_) {}
    }
    sendLog('info', `Imported ${count} proxies from ${lines.length} lines`);
    return { count };
  });

  // ===== BEST-PROXIES.RU API =====
  ipcMain.handle('proxy:fetchBestProxies', async (_, opts) => {
    sendLog('info', `Fetching proxies from Best-Proxies.ru (key: ${opts.key?.substring(0, 6)}..., type: ${opts.type || 'all'}, country: ${opts.country || 'ru (default)'}, limit: ${opts.limit || 20})`);
    try {
      const result = await proxyManager.importFromBestProxies(opts);
      sendLog('success', `Best-Proxies.ru: ${result.total} fetched, ${result.added} new, ${result.skipped} skipped (country filter: ${opts.country || 'ru'})`);
      return result;
    } catch (e) {
      sendLog('error', `Best-Proxies.ru error: ${e.message}`);
      throw e;
    }
  });
  ipcMain.handle('proxy:getBestProxiesStats', async (_, key) => {
    try { return await proxyManager.getBestProxiesStats(key); }
    catch (e) { sendLog('error', `Stats error: ${e.message}`); throw e; }
  });
  ipcMain.handle('proxy:getBestProxiesKeyInfo', async (_, key, format) => {
    try { return await proxyManager.getBestProxiesKeyInfo(key, format); }
    catch (e) { sendLog('error', `Key info error: ${e.message}`); throw e; }
  });
  ipcMain.handle('proxy:clearBestProxies', () => {
    const all = proxyManager.getAll();
    const bpIds = all.filter(p => p.source === 'best-proxies').map(p => p.id);
    proxyManager.bulkRemove(bpIds);
    sendLog('info', `Cleared ${bpIds.length} Best-Proxies.ru proxies`);
    return { removed: bpIds.length };
  });
  ipcMain.handle('proxy:testAll', async () => {
    const total = proxyManager.getAll().length;
    if (total === 0) {
      sendLog('warn', 'No proxies to test');
      return { tested: 0, alive: 0, dead: 0, removed: 0 };
    }
    sendLog('info', `⚡ Testing all ${total} proxies (real Chrome + vk.com)...`);
    const r = await proxyManager.testAll((progress) => {
      const status = progress.success
        ? `✅ ${progress.proxy} → ${progress.ip} (${progress.latency}ms)`
        : `❌ ${progress.proxy} → ${progress.error?.substring(0, 60)}`;
      sendLog(progress.success ? 'info' : 'warn', `[Proxy ${progress.current}/${progress.total}] ${status}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proxy:testAllProgress', progress);
      }
    });
    sendLog(r.dead > 0 ? 'warn' : 'success',
      `⚡ Proxy test complete: ${r.alive} alive, ${r.dead} dead${r.removed > 0 ? ` (${r.removed} removed)` : ''}`);
    return r;
  });

  // ===== ACCOUNTS =====
  ipcMain.handle('account:getAll', () => accountManager.getAll());
  ipcMain.handle('account:add', (_, account) => {
    const r = accountManager.add(account);
    sendLog('info', `Account added: ${account.name}`);
    return r;
  });
  ipcMain.handle('account:remove', (_, id) => {
    const acc = accountManager.getById(id);
    accountManager.remove(id);
    sendLog('info', `Account removed: ${acc?.name || id}`);
    return true;
  });
  ipcMain.handle('account:bulkRemove', (_, ids) => {
    const r = accountManager.bulkRemove(ids);
    sendLog('info', `Removed ${r.removed} accounts`);
    return r;
  });
  ipcMain.handle('account:removeInvalid', () => {
    const r = accountManager.removeInvalid();
    sendLog('info', `Removed ${r.removed} invalid/blocked accounts`);
    return r;
  });
  ipcMain.handle('account:importLogpass', (_, rawText) => {
    sendLog('info', 'Importing VK login:password accounts...');
    const r = accountManager.bulkImportLogpass(rawText);
    sendLog('success', `Imported ${r.created} accounts from ${r.total} lines${r.skipped ? ` (${r.skipped} duplicates skipped)` : ''}`);
    return r;
  });
  ipcMain.handle('account:importFromText', (_, rawText, options) => {
    sendLog('info', `Importing cookies from text (${rawText.length} chars)...`);
    const parseResult = CookieParser.parse(rawText, '.vk.com');
    if (parseResult.log) {
      for (const entry of parseResult.log) sendLog(entry.level === 'debug' ? 'info' : entry.level, `[CookieParser] ${entry.msg}`);
    }
    if (!parseResult.cookies.length) {
      sendLog('error', `Cookie parsing FAILED: ${parseResult.error}`);
      return { created: 0, failed: 1, error: parseResult.error, accounts: [] };
    }
    sendLog('info', `Cookie parsing OK: ${parseResult.count} cookies (format: ${parseResult.format})`);
    const r = accountManager.bulkImportFromText(rawText, options);
    if (r.created) sendLog('success', `Account created: "${r.accounts?.[0]?.name || '?'}" (${parseResult.count} cookies)`);
    else sendLog('error', `Import failed: ${r.error}`);
    return r;
  });
  ipcMain.handle('account:importFromFiles', async (_, options) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Cookies', extensions: ['txt', 'json', 'cookie', 'cookies'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled || !filePaths.length) return { created: 0 };
    sendLog('info', `Importing from ${filePaths.length} file(s)...`);
    const filesData = filePaths.map(fp => ({ name: path.basename(fp), content: fs.readFileSync(fp, 'utf-8') }));
    const r = accountManager.bulkImportFromFiles(filesData, options);
    sendLog('success', `Import done: ${r.created} accounts created, ${r.failed} failed`);
    return r;
  });
  ipcMain.handle('account:importCookies', async (_, accountId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Cookies', extensions: ['txt', 'json', 'cookie'] }], properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return false;
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const parsed = CookieParser.parse(content, '.vk.com');
    if (parsed.cookies.length) {
      accountManager.setCookiesRaw(accountId, parsed.cookies, parsed.format);
      sendLog('success', `Cookies loaded: ${parsed.count} (${parsed.format})`);
      return true;
    }
    sendLog('error', `Failed to parse cookies: ${parsed.error}`);
    return false;
  });
  ipcMain.handle('account:verify', async (_, accountId) => {
    const acc = accountManager.getById(accountId);
    sendLog('info', `Verifying VK account "${acc?.name || accountId}"...`);
    const r = await playwrightEngine.verifyCookies(accountId);
    sendLog(r.valid ? 'success' : 'error',
      r.valid ? `"${acc?.name}" — VALID${r.details ? ' — ' + r.details : ''}`
              : `"${acc?.name}" — INVALID: ${r.error || r.details || 'unknown'}`);
    return r;
  });
  ipcMain.handle('account:bulkVerify', async (_, accountIds) => {
    sendLog('info', `Bulk verifying ${accountIds.length} accounts...`);
    const results = await playwrightEngine.bulkVerifyCookies(accountIds, null, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:verifyProgress', progress);
    });
    const valid = results.filter(r => r.valid).length;
    sendLog('info', `Verification complete: ${valid} valid, ${results.length - valid} invalid`);
    return results;
  });

  // ===== COMMENTS =====
  ipcMain.handle('comments:getAll', () => store.get('comments', []));
  ipcMain.handle('comments:add', (_, comment) => {
    const { v4: uuidv4 } = require('uuid');
    const comments = store.get('comments', []);
    const item = { id: uuidv4(), text: comment.text, tags: comment.tags || [], createdAt: new Date().toISOString() };
    comments.push(item);
    store.set('comments', comments);
    return item;
  });
  ipcMain.handle('comments:remove', (_, id) => {
    store.set('comments', store.get('comments', []).filter(c => c.id !== id));
    return true;
  });
  ipcMain.handle('comments:bulkRemove', (_, ids) => {
    const idSet = new Set(ids);
    store.set('comments', store.get('comments', []).filter(c => !idSet.has(c.id)));
    return { removed: ids.length };
  });
  ipcMain.handle('comments:quickImport', (_, rawText) => {
    const { v4: uuidv4 } = require('uuid');
    const comments = store.get('comments', []);
    const lines = rawText.trim().includes('\n') ? rawText.trim().split('\n') : rawText.trim().includes(',') ? rawText.trim().split(',') : [rawText.trim()];
    let count = 0;
    for (const line of lines) {
      const text = line.trim();
      if (text) { comments.push({ id: uuidv4(), text, tags: [], createdAt: new Date().toISOString() }); count++; }
    }
    store.set('comments', comments);
    sendLog('info', `Imported ${count} comment templates`);
    return { count };
  });
  ipcMain.handle('comments:importFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Text', extensions: ['txt', 'csv'] }], properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { count: 0 };
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const { v4: uuidv4 } = require('uuid');
    const comments = store.get('comments', []);
    const lines = content.split('\n').filter(l => l.trim());
    let count = 0;
    for (const line of lines) {
      const text = line.trim().replace(/^["']|["']$/g, '');
      if (text) { comments.push({ id: uuidv4(), text, tags: [], createdAt: new Date().toISOString() }); count++; }
    }
    store.set('comments', comments);
    sendLog('info', `Imported ${count} comments from file`);
    return { count };
  });

  // ===== COMMENT FOLDERS =====
  ipcMain.handle('commentFolders:getAll', () => store.get('commentFolders', []));
  ipcMain.handle('commentFolders:create', (_, folder) => {
    const { v4: uuidv4 } = require('uuid');
    const folders = store.get('commentFolders', []);
    const nf = { id: uuidv4(), name: folder.name || 'Untitled', color: folder.color || '#6366f1', comments: [], createdAt: new Date().toISOString() };
    folders.push(nf);
    store.set('commentFolders', folders);
    sendLog('info', `Comment folder created: "${nf.name}"`);
    return nf;
  });
  ipcMain.handle('commentFolders:rename', (_, folderId, newName) => {
    store.set('commentFolders', store.get('commentFolders', []).map(f => f.id === folderId ? { ...f, name: newName } : f));
    return true;
  });
  ipcMain.handle('commentFolders:delete', (_, folderId) => {
    store.set('commentFolders', store.get('commentFolders', []).filter(f => f.id !== folderId));
    return true;
  });
  ipcMain.handle('commentFolders:addComment', (_, folderId, text) => {
    const { v4: uuidv4 } = require('uuid');
    const folders = store.get('commentFolders', []);
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return null;
    const comment = { id: uuidv4(), text, createdAt: new Date().toISOString() };
    folder.comments.push(comment);
    store.set('commentFolders', folders);
    return comment;
  });
  ipcMain.handle('commentFolders:removeComment', (_, folderId, commentId) => {
    const folders = store.get('commentFolders', []);
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return false;
    folder.comments = folder.comments.filter(c => c.id !== commentId);
    store.set('commentFolders', folders);
    return true;
  });
  ipcMain.handle('commentFolders:quickImport', (_, folderId, rawText) => {
    const { v4: uuidv4 } = require('uuid');
    const folders = store.get('commentFolders', []);
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return { count: 0 };
    const lines = rawText.trim().includes('\n') ? rawText.trim().split('\n') : [rawText.trim()];
    let count = 0;
    for (const line of lines) {
      const text = line.trim();
      if (text) { folder.comments.push({ id: uuidv4(), text, createdAt: new Date().toISOString() }); count++; }
    }
    store.set('commentFolders', folders);
    return { count };
  });
  ipcMain.handle('commentFolders:importFile', async (_, folderId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Text', extensions: ['txt', 'csv'] }], properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { count: 0 };
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const { v4: uuidv4 } = require('uuid');
    const folders = store.get('commentFolders', []);
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return { count: 0 };
    const lines = content.split('\n').filter(l => l.trim());
    let count = 0;
    for (const line of lines) {
      const text = line.trim().replace(/^["']|["']$/g, '');
      if (text) { folder.comments.push({ id: uuidv4(), text, createdAt: new Date().toISOString() }); count++; }
    }
    store.set('commentFolders', folders);
    return { count };
  });

  // ===== TASKS =====
  ipcMain.handle('task:getAll', () => taskQueue.getAll());
  ipcMain.handle('task:create', async (_, task) => {
    const enrichedTask = { ...task };
    const r = taskQueue.create(enrichedTask);
    sendLog('info', `Task created: Views=${task.viewCount}, Likes=${task.likeCount}, Comments=${task.commentCount}, Accounts=${task.accountIds?.length || 0}, Proxies=${task.proxyIds?.length || 0}, Speed=${task.slowSpeed ? '0.25x' : 'normal'}, Ghost=${task.ghostWatchers ? 'ON' : 'off'}`);
    return r;
  });
  ipcMain.handle('task:remove', (_, id) => taskQueue.remove(id));
  ipcMain.handle('task:start', async (_, id) => {
    sendLog('info', `Starting task ${id.substring(0, 8)}...`);
    taskQueue.removeAllListeners('taskProgress');
    taskQueue.removeAllListeners('taskLog');
    taskQueue.on('taskProgress', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:progress', data);
    });
    taskQueue.on('taskLog', (data) => sendLog(data.level, data.message));
    return taskQueue.start(id);
  });
  ipcMain.handle('task:stop', (_, id) => {
    sendLog('warn', `Stopping task ${id.substring(0, 8)}...`);
    return taskQueue.stop(id);
  });
  ipcMain.handle('task:startAll', () => { sendLog('info', 'Starting all tasks...'); return taskQueue.startAll(); });
  ipcMain.handle('task:stopAll', () => { sendLog('warn', 'Stopping all tasks...'); return taskQueue.stopAll(); });

  // ===== SETTINGS =====
  ipcMain.handle('settings:get', () => store.get('settings'));
  ipcMain.handle('settings:save', (_, settings) => {
    store.set('settings', settings);
    sendLog('info', 'Settings saved');
    return true;
  });

  // ===== LOGS =====
  ipcMain.handle('logs:clear', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log:clear');
    return true;
  });
}

app.whenReady().then(() => { initModules(); createWindow(); setupIPC(); });
app.on('window-all-closed', async () => {
  if (taskQueue) taskQueue.stopAll();
  if (playwrightEngine) await playwrightEngine.cleanup();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

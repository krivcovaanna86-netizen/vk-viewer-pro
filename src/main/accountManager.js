/**
 * AccountManager — VK accounts (login/pass + cookies)
 *
 * Supports:
 * - VK login/password pairs (logpass.txt format)
 * - Cookie-based accounts (Netscape, JSON, header)
 * - Account status tracking
 * - Profile directory management
 */

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { CookieParser } = require('./cookieParser');

class AccountManager {
  constructor(store) {
    this.store = store;
    this.dataDir = path.join(app.getPath('userData'), 'accounts');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  getAll() { return this.store.get('accounts', []); }

  add(account) {
    const accounts = this.getAll();
    const newAccount = {
      id: uuidv4(),
      name: account.name,
      platform: 'vk',
      authType: account.authType || 'cookies', // cookies | logpass
      login: account.login || '',
      password: account.password || '',
      hasCookies: false,
      hasStorageState: false,
      cookieCount: 0,
      cookieFormat: null,
      proxyId: account.proxyId || null,
      proxyType: account.proxyType || null,
      notes: account.notes || '',
      status: 'unchecked',
      lastCheck: null,
      vkId: null,
      addedAt: new Date().toISOString(),
    };
    accounts.push(newAccount);
    this.store.set('accounts', accounts);
    return newAccount;
  }

  /**
   * Import from logpass text: login:password per line
   */
  bulkImportLogpass(rawText) {
    const lines = rawText.split(/[\r\n]+/).filter(l => l.trim());
    let created = 0;
    let skipped = 0;
    const importedAccounts = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Support formats: login:password, login;password, login password (tab)
      let login, password;
      
      // Try colon separator first
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        login = trimmed.substring(0, colonIdx).trim();
        password = trimmed.substring(colonIdx + 1).trim();
      } else {
        // Try semicolon
        const semiIdx = trimmed.indexOf(';');
        if (semiIdx > 0) {
          login = trimmed.substring(0, semiIdx).trim();
          password = trimmed.substring(semiIdx + 1).trim();
        } else {
          // Try tab
          const tabIdx = trimmed.indexOf('\t');
          if (tabIdx > 0) {
            login = trimmed.substring(0, tabIdx).trim();
            password = trimmed.substring(tabIdx + 1).trim();
          } else {
            continue;
          }
        }
      }

      if (!login || !password) continue;

      // Check duplicate (read fresh from store each time since add() modifies it)
      const existing = this.getAll().find(a => a.login === login && a.authType === 'logpass');
      if (existing) {
        // Update password if it changed
        if (existing.password !== password) {
          this.updateAccount(existing.id, { password, status: 'unchecked', lastCheck: null });
        }
        skipped++;
        continue;
      }

      const account = this.add({
        name: login,
        authType: 'logpass',
        login,
        password,
        notes: 'Imported from logpass',
      });
      importedAccounts.push(account);
      created++;
    }

    return { created, total: lines.length, skipped, accounts: importedAccounts };
  }

  /**
   * Import from cookies text
   */
  bulkImportFromText(rawText, options = {}) {
    const result = CookieParser.parse(rawText, '.vk.com');
    if (!result.cookies.length) {
      return { created: 0, failed: 1, error: result.error, accounts: [], log: result.log };
    }

    const hint = CookieParser.extractAccountHint(result.cookies);
    const name = hint || `VK-${Date.now().toString(36)}`;

    const account = this.add({
      name,
      authType: 'cookies',
      proxyId: options.proxyId || null,
      proxyType: options.proxyType || null,
      notes: `Import: ${result.format}, ${result.count} cookies`,
    });

    this.setCookiesRaw(account.id, result.cookies, result.format);
    return { created: 1, failed: 0, accounts: [account], log: result.log };
  }

  bulkImportFromFiles(filesData, options = {}) {
    const results = { created: 0, failed: 0, accounts: [] };
    for (const fileData of filesData) {
      const parsed = CookieParser.parse(fileData.content, '.vk.com');
      if (!parsed.cookies.length) { results.failed++; continue; }

      const hint = CookieParser.extractAccountHint(parsed.cookies);
      const baseName = fileData.name.replace(/\.(txt|json|cookies?)$/i, '');
      const name = hint || baseName || `VK-${Date.now().toString(36)}`;

      const account = this.add({
        name,
        authType: 'cookies',
        proxyId: options.proxyId || null,
        proxyType: options.proxyType || null,
        notes: `File: ${fileData.name}, ${parsed.format}, ${parsed.count} cookies`,
      });

      this.setCookiesRaw(account.id, parsed.cookies, parsed.format);
      results.created++;
      results.accounts.push(account);
    }
    return results;
  }

  remove(id) {
    this.store.set('accounts', this.getAll().filter(a => a.id !== id));
    const cookiePath = path.join(this.dataDir, `${id}_cookies.json`);
    const statePath = path.join(this.dataDir, `${id}_state.json`);
    if (fs.existsSync(cookiePath)) fs.unlinkSync(cookiePath);
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    return true;
  }

  bulkRemove(ids) {
    let removed = 0;
    for (const id of ids) { this.remove(id); removed++; }
    return { removed };
  }

  removeInvalid() {
    const invalid = this.getAll().filter(a => a.status === 'invalid' || a.status === 'blocked');
    return this.bulkRemove(invalid.map(a => a.id));
  }

  getById(id) { return this.getAll().find(a => a.id === id); }

  getNextValid(excludeIds = []) {
    const valid = this.getAll().filter(a =>
      a.status === 'valid' && (a.hasCookies || a.authType === 'logpass') && !excludeIds.includes(a.id)
    );
    return valid.length ? valid[Math.floor(Math.random() * valid.length)] : null;
  }

  setCookiesRaw(id, cookies, format) {
    const playwrightCookies = CookieParser.toPlaywrightFormat(cookies);
    const filePath = path.join(this.dataDir, `${id}_cookies.json`);
    fs.writeFileSync(filePath, JSON.stringify(playwrightCookies, null, 2));
    this.updateAccount(id, { hasCookies: true, cookieCount: playwrightCookies.length, cookieFormat: format });
  }

  getCookies(id) {
    const filePath = path.join(this.dataDir, `${id}_cookies.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  setStorageState(id, state) {
    const filePath = path.join(this.dataDir, `${id}_state.json`);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    this.updateAccount(id, { hasStorageState: true });
  }

  getStorageState(id) {
    const filePath = path.join(this.dataDir, `${id}_state.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  updateAccount(id, updates) {
    this.store.set('accounts', this.getAll().map(a => a.id === id ? { ...a, ...updates } : a));
  }

  bulkUpdateStatus(results) {
    const accounts = this.getAll();
    for (const r of results) {
      const idx = accounts.findIndex(a => a.id === r.id);
      if (idx >= 0) {
        accounts[idx].status = r.status;
        accounts[idx].lastCheck = new Date().toISOString();
        if (r.vkId) accounts[idx].vkId = r.vkId;
      }
    }
    this.store.set('accounts', accounts);
  }
}

module.exports = { AccountManager };

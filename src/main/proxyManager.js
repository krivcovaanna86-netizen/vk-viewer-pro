/**
 * ProxyManager — with Best-Proxies.ru API integration
 *
 * API docs: https://best-proxies.ru/api/
 * - TXT/CSV/JSON list endpoints
 * - Stats & key info
 * - Rate limit: 15 req/min per key/IP
 * - Test key: "developer" (max 10 proxies)
 */

const { v4: uuidv4 } = require('uuid');
const https = require('https');

const BP_BASE = 'https://api.best-proxies.ru';
const BP_RATE_LIMIT_MS = 4200; // ~15 req/min = 1 per 4s, add margin

class ProxyManager {
  constructor(store) {
    this.store = store;
    this._lastBpRequest = 0;
  }

  getAll() { return this.store.get('proxies', []); }

  add(proxy) {
    const proxies = this.getAll();
    const newProxy = {
      id: uuidv4(),
      type: proxy.type || 'http',
      host: proxy.host,
      port: parseInt(proxy.port),
      username: proxy.username || '',
      password: proxy.password || '',
      country: proxy.country || '',
      countryCode: proxy.countryCode || '',
      level: proxy.level || 0,
      response: proxy.response || null,
      source: proxy.source || 'manual', // manual | best-proxies | import
      status: proxy.status || 'unknown',
      lastCheck: null,
      latency: null,
      addedAt: new Date().toISOString(),
    };
    proxies.push(newProxy);
    this.store.set('proxies', proxies);
    return newProxy;
  }

  remove(id) {
    this.store.set('proxies', this.getAll().filter(p => p.id !== id));
    return true;
  }

  bulkRemove(ids) {
    const idSet = new Set(ids);
    this.store.set('proxies', this.getAll().filter(p => !idSet.has(p.id)));
    return { removed: ids.length };
  }

  getById(id) { return this.getAll().find(p => p.id === id); }

  getRandom(excludeDead = true) {
    const pool = this.getAll().filter(p => !excludeDead || p.status !== 'dead');
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  updateProxy(id, updates) {
    this.store.set('proxies', this.getAll().map(p => p.id === id ? { ...p, ...updates } : p));
  }

  // ───────── Best-Proxies.ru API ─────────

  /**
   * Rate-limit helper — wait if needed
   */
  async _bpRateLimit() {
    const now = Date.now();
    const elapsed = now - this._lastBpRequest;
    if (elapsed < BP_RATE_LIMIT_MS) {
      await new Promise(r => setTimeout(r, BP_RATE_LIMIT_MS - elapsed));
    }
    this._lastBpRequest = Date.now();
  }

  /**
   * Make HTTPS GET request to Best-Proxies.ru API
   */
  _bpRequest(urlPath) {
    return new Promise((resolve, reject) => {
      const url = `${BP_BASE}${urlPath}`;
      const req = https.get(url, { timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ status: 200, data });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', e => reject(e));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  /**
   * Build query string from params
   */
  _buildQuery(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        if (k === 'includeType' && v === true) {
          parts.push('includeType');
        } else {
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        }
      }
    }
    return parts.join('&');
  }

  /**
   * Fetch proxy list from Best-Proxies.ru
   * Supports JSON, TXT, CSV formats
   *
   * @param {object} options
   * @param {string} options.key - Premium key (required)
   * @param {string} [options.format] - json|txt|csv (default: json)
   * @param {string} [options.type] - http,https,socks4,socks5
   * @param {string} [options.level] - 1,2,3
   * @param {number} [options.bl] - DNSBL rating 0-10
   * @param {string} [options.ports] - Comma-separated ports
   * @param {number} [options.pex] - 1 to exclude listed ports
   * @param {string} [options.country] - ISO 3166-1 alpha-2 codes
   * @param {number} [options.cex] - 1 to exclude listed countries
   * @param {number} [options.response] - max response ms
   * @param {string} [options.uptime] - hours or "30m"
   * @param {string} [options.speed] - 1,2,3
   * @param {number} [options.limit] - max proxies (0=15000, default 20)
   * @param {number} [options.google] - 1 for Google-working proxies
   * @param {number} [options.mail] - 1 for mail-working proxies
   * @param {number} [options.mailru] - 1 for Mail.ru-working proxies
   * @param {number} [options.telegram] - 1 for Telegram-working proxies
   * @param {number} [options.avito] - 1 for Avito-working proxies
   * @param {boolean} [options.includeType] - add type:// prefix in TXT
   * @param {number} [options.nocascade] - 1 for exact type match
   * @param {string} [options.filename] - custom response filename
   * @returns {Promise<Array>} parsed proxy list
   */
  async fetchFromBestProxies(options = {}) {
    if (!options.key) throw new Error('Best-Proxies API key is required');

    await this._bpRateLimit();

    const format = options.format || 'json';
    const queryParams = { ...options };
    delete queryParams.format; // format goes in the URL path, not query

    const query = this._buildQuery(queryParams);
    const ext = format === 'csv' ? 'csv' : format === 'txt' ? 'txt' : 'json';
    const { data } = await this._bpRequest(`/proxylist.${ext}?${query}`);

    if (format === 'json') {
      const list = JSON.parse(data);
      if (!Array.isArray(list)) throw new Error('Unexpected JSON response format');
      return list;
    }

    if (format === 'txt') {
      return this._parseTxtProxyList(data, options.includeType);
    }

    if (format === 'csv') {
      return this._parseCsvProxyList(data);
    }

    throw new Error(`Unsupported format: ${format}`);
  }

  /**
   * Parse TXT proxy list (ip:port or type://ip:port per line)
   */
  _parseTxtProxyList(data, hasTypePrefix = false) {
    const lines = data.split('\n').filter(l => l.trim());
    const result = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let type = 'http';
      let hostPort = trimmed;

      // Check for type:// prefix
      const protoMatch = trimmed.match(/^(https?|socks[45]):\/\/(.+)$/i);
      if (protoMatch) {
        type = protoMatch[1].toLowerCase();
        hostPort = protoMatch[2];
      }

      const parts = hostPort.split(':');
      if (parts.length < 2) continue;

      const ip = parts[0].trim();
      const port = parseInt(parts[1].trim());
      if (!ip || isNaN(port) || port <= 0 || port > 65535) continue;

      result.push({ ip, port, _type: type });
    }
    return result;
  }

  /**
   * Parse CSV proxy list (Windows-1251, semicolon-delimited)
   * Header: ip;port;type;level;country;country_code;city;response;good;bad
   */
  _parseCsvProxyList(data) {
    const lines = data.split('\n').filter(l => l.trim());
    if (lines.length < 2) return []; // need header + at least 1 row

    const header = lines[0].split(';').map(h => h.trim().toLowerCase());
    const result = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].split(';');
      if (fields.length < 2) continue;

      const row = {};
      for (let j = 0; j < header.length && j < fields.length; j++) {
        row[header[j]] = fields[j].trim();
      }

      if (!row.ip || !row.port) continue;

      result.push({
        ip: row.ip,
        port: parseInt(row.port),
        level: parseInt(row.level) || 0,
        country_code: row.country_code || row.country || '',
        city: row.city || '',
        response: parseInt(row.response) || null,
        _type: row.type || 'http',
        http: row.type === 'http' || row.type === 'HTTP' ? 1 : 0,
        https: row.type === 'https' || row.type === 'HTTPS' ? 1 : 0,
        socks4: row.type === 'socks4' || row.type === 'SOCKS4' ? 1 : 0,
        socks5: row.type === 'socks5' || row.type === 'SOCKS5' ? 1 : 0,
      });
    }
    return result;
  }

  /**
   * Fetch proxies from Best-Proxies.ru and add to local store
   */
  async importFromBestProxies(options = {}) {
    // Default to Russian proxies for VK engagement
    if (!options.country) {
      options.country = 'ru';
    }
    
    const list = await this.fetchFromBestProxies(options);
    let added = 0;
    const existingHosts = new Set(this.getAll().map(p => `${p.host}:${p.port}`));
    const format = options.format || 'json';

    for (const item of list) {
      const hostPort = `${item.ip}:${item.port}`;
      if (existingHosts.has(hostPort)) continue;

      // Determine proxy type
      let type = 'http';
      if (format === 'json') {
        if (item.socks5) type = 'socks5';
        else if (item.socks4) type = 'socks4';
        else if (item.https) type = 'https';
      } else {
        // TXT/CSV — use _type parsed from the data
        type = (item._type || 'http').toLowerCase();
      }

      this.add({
        type,
        host: item.ip,
        port: item.port,
        country: item.city ? `${item.country_code} ${item.city}` : item.country_code || '',
        countryCode: item.country_code || '',
        level: item.level || 0,
        response: item.response || null,
        source: 'best-proxies',
        status: 'active',
      });
      added++;
      existingHosts.add(hostPort);
    }

    return { total: list.length, added, skipped: list.length - added };
  }

  /**
   * Get Best-Proxies.ru proxy list stats
   */
  async getBestProxiesStats(key) {
    if (!key) throw new Error('API key required');
    await this._bpRateLimit();
    const { data } = await this._bpRequest(`/stats.json?key=${encodeURIComponent(key)}`);
    return JSON.parse(data);
  }

  /**
   * Get remaining subscription time
   * @param {string} key
   * @param {string} format - hours|minutes|seconds
   */
  async getBestProxiesKeyInfo(key, format = 'hours') {
    if (!key) throw new Error('API key required');
    await this._bpRateLimit();
    const { data } = await this._bpRequest(`/key.txt?key=${encodeURIComponent(key)}&format=${format}`);
    return { remaining: parseInt(data.trim()), format };
  }

  // ───────── Proxy line parser ─────────

  parseLine(line) {
    let type = 'http';
    let cleanLine = line.trim();
    if (!cleanLine) return null;

    if (cleanLine.startsWith('socks5://')) { type = 'socks5'; cleanLine = cleanLine.slice(9); }
    else if (cleanLine.startsWith('socks4://')) { type = 'socks4'; cleanLine = cleanLine.slice(9); }
    else if (cleanLine.startsWith('http://')) { type = 'http'; cleanLine = cleanLine.slice(7); }
    else if (cleanLine.startsWith('https://')) { type = 'https'; cleanLine = cleanLine.slice(8); }

    let username = '', password = '', host, port;

    if (cleanLine.includes('@')) {
      const atIdx = cleanLine.lastIndexOf('@');
      const authPart = cleanLine.substring(0, atIdx);
      const serverPart = cleanLine.substring(atIdx + 1);
      const serverParts = serverPart.split(':');
      const serverPortNum = serverParts.length >= 2 ? parseInt(serverParts[1]) : NaN;

      if (serverParts.length >= 2 && serverPortNum > 0 && serverPortNum <= 65535) {
        host = serverParts[0];
        port = serverParts[1];
        const colonIdx = authPart.indexOf(':');
        if (colonIdx > -1) {
          username = authPart.substring(0, colonIdx);
          password = authPart.substring(colonIdx + 1);
        } else {
          username = authPart;
        }
      } else {
        const parts = cleanLine.split(':');
        if (parts.length >= 4) { host = parts[0]; port = parts[1]; username = parts[2]; password = parts.slice(3).join(':'); }
        else if (parts.length === 2) { [host, port] = parts; }
        else return null;
      }
    } else {
      const parts = cleanLine.split(':');
      if (parts.length === 2) { [host, port] = parts; }
      else if (parts.length === 4) {
        const maybePort = parseInt(parts[1]);
        if (maybePort > 0 && maybePort <= 65535) { [host, port, username, password] = parts; }
        else { [username, password, host, port] = parts; }
      } else if (parts.length > 4) {
        host = parts[0]; port = parts[1]; username = parts[2]; password = parts.slice(3).join(':');
      } else return null;
    }

    host = (host || '').trim();
    port = (port || '').trim();
    if (!host || !port || isNaN(parseInt(port))) return null;
    return { type, host, port: parseInt(port), username: (username || '').trim(), password: (password || '').trim() };
  }

  // ───────── Proxy testing ─────────

  async test(id) {
    const proxy = this.getById(id);
    if (!proxy) return { success: false, error: 'Proxy not found' };
    const start = Date.now();
    let browser = null;
    try {
      const { chromium } = require('playwright');
      const protocol = proxy.type === 'socks5' ? 'socks5' : proxy.type === 'socks4' ? 'socks5' : 'http';
      const proxyConfig = { server: `${protocol}://${proxy.host}:${proxy.port}` };
      if (proxy.username && proxy.password) {
        proxyConfig.username = proxy.username;
        proxyConfig.password = proxy.password;
      }
      browser = await chromium.launch({ proxy: proxyConfig, headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext();
      const page = await context.newPage();
      const response = await page.goto('http://api.ipify.org?format=json', { timeout: 15000, waitUntil: 'domcontentloaded' });
      const body = await response.text();
      const data = JSON.parse(body);
      await browser.close();
      browser = null;
      const latency = Date.now() - start;
      this.updateProxy(id, { status: 'active', lastCheck: new Date().toISOString(), latency, ip: data.ip });
      return { success: true, ip: data.ip, latency };
    } catch (e) {
      this.updateProxy(id, { status: 'dead', lastCheck: new Date().toISOString() });
      return { success: false, error: e.message };
    } finally {
      if (browser) try { await browser.close(); } catch (_) {}
    }
  }

  buildProxyUrl(proxy) {
    const protocol = proxy.type === 'socks5' ? 'socks5' : 'http';
    if (proxy.username && proxy.password) {
      return `${protocol}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
    }
    return `${protocol}://${proxy.host}:${proxy.port}`;
  }
}

module.exports = { ProxyManager };

/**
 * CookieParser — VK cookie format support
 *
 * Formats:
 * 1. Netscape/cURL (TAB-separated .txt)
 * 2. JSON Array (Playwright/Puppeteer format)
 * 3. JSON Object (EditThisCookie export)
 * 4. Header string (Cookie: name=value; name2=value2)
 * 5. JSON key-value ({name: value})
 */

class CookieParser {
  static _log = [];

  static _addLog(level, msg) {
    const entry = { level, msg, ts: Date.now() };
    this._log.push(entry);
    const prefix = { info: 'i', warn: '!', error: 'X', debug: '~' }[level] || '';
    console.log(`[CookieParser] ${prefix} ${msg}`);
  }

  static getLog() { return [...this._log]; }
  static clearLog() { this._log = []; }

  static parse(raw, defaultDomain = '.vk.com') {
    this.clearLog();
    const trimmed = raw.trim();
    if (!trimmed) {
      this._addLog('error', 'Empty input');
      return { cookies: [], format: 'empty', count: 0, error: 'Empty input', log: this.getLog() };
    }
    this._addLog('info', `Parsing ${trimmed.length} chars`);

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        if (Array.isArray(json)) {
          this._addLog('info', `Format: JSON Array (${json.length} items)`);
          const result = this.parseJSONArray(json, defaultDomain);
          result.log = this.getLog();
          return result;
        } else if (typeof json === 'object') {
          this._addLog('info', 'Format: JSON Object');
          const result = this.parseJSONObject(json, defaultDomain);
          result.log = this.getLog();
          return result;
        }
      } catch (e) {
        this._addLog('warn', `Invalid JSON: ${e.message}, trying other formats`);
      }
    }

    if (trimmed.startsWith('Cookie:') || (!trimmed.includes('\t') && !trimmed.includes('\n') && trimmed.includes('=') && trimmed.includes(';'))) {
      this._addLog('info', 'Format: Cookie Header String');
      const result = this.parseHeaderString(trimmed, defaultDomain);
      result.log = this.getLog();
      return result;
    }

    if (trimmed.includes('\t')) {
      this._addLog('info', 'Format: Netscape TAB-separated');
      const result = this.parseNetscape(trimmed);
      result.log = this.getLog();
      return result;
    }

    if (trimmed.includes('=')) {
      this._addLog('info', 'Fallback: key=value pairs');
      const result = this.parseHeaderString(trimmed, defaultDomain);
      result.log = this.getLog();
      return result;
    }

    this._addLog('error', 'Could not determine cookie format');
    return { cookies: [], format: 'unknown', count: 0, error: 'Unknown format', log: this.getLog() };
  }

  static parseNetscape(raw) {
    const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('# '));
    this._addLog('info', `Netscape: ${lines.length} lines`);
    const cookies = [];
    let errors = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 7) {
        if (line.trim().startsWith('#')) continue;
        errors++;
        continue;
      }

      let domain = parts[0].trim();
      let isHttpOnly = false;
      if (domain.startsWith('#HttpOnly_')) {
        domain = domain.substring('#HttpOnly_'.length);
        isHttpOnly = true;
      }

      const path = parts[2].trim() || '/';
      const secure = parts[3].trim().toUpperCase() === 'TRUE';
      const expires = parseInt(parts[4].trim());
      const name = parts[5].trim();
      const value = parts.slice(6).join('\t').trim();

      if (!name || !domain) { errors++; continue; }

      let sameSite = 'Lax';
      if (name.startsWith('__Secure-') || name.startsWith('__Host-')) sameSite = 'None';

      cookies.push({
        name, value, domain, path,
        expires: (isNaN(expires) || expires <= 0) ? -1 : expires,
        httpOnly: isHttpOnly, secure, sameSite,
      });
    }

    const deduped = this._deduplicateCookies(cookies);
    this._addLog('info', `Netscape: ${deduped.length} cookies, ${errors} errors`);
    return {
      cookies: deduped, format: 'netscape', count: deduped.length, errors,
      error: deduped.length === 0 ? 'No cookies parsed from Netscape format' : null,
    };
  }

  static _deduplicateCookies(cookies) {
    const map = new Map();
    for (const c of cookies) map.set(`${c.name}|${c.domain}|${c.path}`, c);
    return Array.from(map.values());
  }

  static parseJSONArray(arr, defaultDomain) {
    const cookies = [];
    let skipped = 0;
    for (const item of arr) {
      if (!item || typeof item !== 'object') { skipped++; continue; }
      if (item.name && 'value' in item) {
        cookies.push({
          name: String(item.name),
          value: String(item.value ?? ''),
          domain: item.domain || defaultDomain,
          path: item.path || '/',
          expires: item.expires || item.expirationDate || -1,
          httpOnly: !!item.httpOnly,
          secure: !!item.secure,
          sameSite: this.normalizeSameSite(item.sameSite),
        });
      } else { skipped++; }
    }
    this._addLog('info', `JSON Array: ${cookies.length} cookies, ${skipped} skipped`);
    return { cookies, format: 'json_array', count: cookies.length, error: cookies.length === 0 ? 'No valid cookies in JSON array' : null };
  }

  static parseJSONObject(obj, defaultDomain) {
    if (obj.name && 'value' in obj) return this.parseJSONArray([obj], defaultDomain);
    const cookies = [];
    for (const [name, value] of Object.entries(obj)) {
      if (typeof value === 'string' || typeof value === 'number') {
        cookies.push({ name, value: String(value), domain: defaultDomain, path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' });
      }
    }
    this._addLog('info', `JSON Object: ${cookies.length} cookies`);
    return { cookies, format: 'json_object', count: cookies.length, error: cookies.length === 0 ? 'No valid cookies' : null };
  }

  static parseHeaderString(raw, defaultDomain) {
    let str = raw.trim();
    if (str.toLowerCase().startsWith('cookie:')) str = str.substring(7).trim();
    const cookies = [];
    for (const pair of str.split(';')) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.substring(0, idx).trim();
        const value = pair.substring(idx + 1).trim();
        if (name) cookies.push({ name, value, domain: defaultDomain, path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' });
      }
    }
    this._addLog('info', `Header String: ${cookies.length} cookies`);
    return { cookies, format: 'header_string', count: cookies.length, error: cookies.length === 0 ? 'No cookies parsed' : null };
  }

  static toPlaywrightFormat(cookies) {
    const result = [];
    for (const c of cookies) {
      if (!c.name?.trim() || !c.domain?.trim()) continue;
      let sameSite = this.normalizeSameSite(c.sameSite);
      const secure = c.name.startsWith('__Secure-') || c.name.startsWith('__Host-') ? true : !!c.secure;
      if (!secure && sameSite === 'None') sameSite = 'Lax';
      result.push({
        name: c.name.trim(), value: c.value ?? '', domain: c.domain.trim(),
        path: c.path || '/', expires: (typeof c.expires === 'number' && c.expires > 0) ? c.expires : -1,
        httpOnly: !!c.httpOnly, secure, sameSite,
      });
    }
    return result;
  }

  static normalizeSameSite(val) {
    if (!val) return 'Lax';
    const lower = String(val).toLowerCase();
    if (lower === 'strict') return 'Strict';
    if (lower === 'none') return 'None';
    return 'Lax';
  }

  static detectPlatform(cookies) {
    const domains = cookies.map(c => c.domain).join(' ');
    if (domains.includes('vk.com') || domains.includes('vk.ru')) return 'vk';
    if (domains.includes('youtube') || domains.includes('google')) return 'youtube';
    if (domains.includes('rutube')) return 'rutube';
    return 'other';
  }

  static extractAccountHint(cookies) {
    for (const c of cookies) {
      if (c.name === 'remixsid' || c.name === 'remixlang') return null;
      if (c.name === 'login' || c.name === 'username' || c.name === 'l') return c.value;
    }
    return null;
  }

  static filterForVK(cookies) {
    return cookies.filter(c => {
      const d = c.domain.toLowerCase();
      return d.includes('vk.com') || d.includes('vk.ru') || d.includes('vkontakte');
    });
  }
}

module.exports = { CookieParser };

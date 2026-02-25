/**
 * PlaywrightEngine v1.0 — VK Video Engagement
 *
 * VK-specific:
 * - Login via VK credentials (login/pass)
 * - Cookie-based auth
 * - Video search on vk.com/video
 * - Video watching, liking, commenting
 * - Warm-up browsing on VK feed
 * - Captcha detection & reporting
 * - 4-tier browser launch (fingerprint-injector > stealth > plain)
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { chromium } = require('playwright-core');

// ── fingerprint-injector (LOCAL, instant, cross-platform) ──
let FingerprintInjector = null;
let FingerprintGenerator = null;
let hasLocalFingerprints = false;
try {
  const fpInj = require('fingerprint-injector');
  FingerprintInjector = fpInj.FingerprintInjector || fpInj.newInjectedContext;
  if (!FingerprintInjector) FingerprintInjector = fpInj;
  const fpGen = require('fingerprint-generator');
  FingerprintGenerator = fpGen.FingerprintGenerator || fpGen;
  hasLocalFingerprints = true;
  console.log('[PW] fingerprint-injector loaded');
} catch (_) {
  console.log('[PW] fingerprint-injector not available');
}

// ── playwright-extra + stealth ──
let stealthPlugin = null;
let PlaywrightExtra = null;
try {
  const { chromium: pwExtra } = require('playwright-extra');
  PlaywrightExtra = pwExtra;
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  stealthPlugin = StealthPlugin();
  PlaywrightExtra.use(stealthPlugin);
  console.log('[PW] playwright-extra + stealth loaded');
} catch (_) {
  console.log('[PW] playwright-extra/stealth not available');
}

class PlaywrightEngine {
  constructor(store, proxyManager, accountManager) {
    this.store = store;
    this.proxyManager = proxyManager;
    this.accountManager = accountManager;
    this.activeContexts = new Map();
    this._logCallback = null;

    this.fpSeedDir = path.join(app.getPath('userData'), 'fp-seeds');
    if (!fs.existsSync(this.fpSeedDir)) fs.mkdirSync(this.fpSeedDir, { recursive: true });
  }

  setLogCallback(cb) { this._logCallback = cb; }

  _log(level, msg) {
    console.log(`[PW] ${msg}`);
    if (this._logCallback) this._logCallback(level, `[PW] ${msg}`);
  }

  // ──────── Fingerprint ────────

  _getLocalFpSeed(accountId) {
    const seedPath = path.join(this.fpSeedDir, `${accountId}.json`);
    if (fs.existsSync(seedPath)) {
      try { return JSON.parse(fs.readFileSync(seedPath, 'utf-8')); } catch (_) {}
    }
    const seed = {
      screenWidth: [1366, 1440, 1536, 1600, 1920][Math.floor(Math.random() * 5)],
      screenHeight: [768, 900, 864, 900, 1080][Math.floor(Math.random() * 5)],
      locale: ['ru-RU', 'en-US', 'ru-RU', 'ru-RU', 'uk-UA'][Math.floor(Math.random() * 5)],
      createdAt: new Date().toISOString(),
    };
    try { fs.writeFileSync(seedPath, JSON.stringify(seed)); } catch (_) {}
    return seed;
  }

  deleteFingerprint(accountId) {
    const seedPath = path.join(this.fpSeedDir, `${accountId}.json`);
    if (fs.existsSync(seedPath)) { fs.unlinkSync(seedPath); return true; }
    return false;
  }

  hasFingerprint(accountId) {
    return fs.existsSync(path.join(this.fpSeedDir, `${accountId}.json`));
  }

  // ──────── Browser Launch ────────

  async launchContext(options = {}) {
    const settings = this.store.get('settings');
    const isHeadless = options.headless !== undefined ? options.headless : settings.headless;

    const launchArgs = [
      '--no-sandbox',
      '--disable-infobars',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--lang=ru-RU',
    ];

    let context = null;
    let browser = null;
    let launchMethod = 'unknown';

    // METHOD 1: fingerprint-injector (local, instant)
    if (!context && hasLocalFingerprints) {
      try {
        const proxyConfig = options.proxyUrl ? this._parseProxyUrl(options.proxyUrl) : undefined;
        const launchOpts = { headless: isHeadless, args: launchArgs };
        if (proxyConfig) launchOpts.proxy = proxyConfig;

        browser = await chromium.launch(launchOpts);
        const seed = options.accountId ? this._getLocalFpSeed(options.accountId) : {};
        const fpOptions = {
          devices: ['desktop'],
          operatingSystems: ['windows'],
          browsers: [{ name: 'chrome', minVersion: 120, maxVersion: 130 }],
        };
        if (seed.locale) fpOptions.locales = [seed.locale];

        const { newInjectedContext } = require('fingerprint-injector');
        context = await newInjectedContext(browser, {
          fingerprintOptions: fpOptions,
          newContextOptions: {
            ignoreHTTPSErrors: true,
            viewport: { width: seed.screenWidth || 1366, height: seed.screenHeight || 768 },
          },
        });
        context._fpBrowser = browser;
        launchMethod = 'fingerprint-injector';
        this._log('success', 'Local fingerprint injected');
      } catch (e) {
        this._log('warn', `fingerprint-injector failed: ${e.message.substring(0, 80)}`);
        if (browser) try { await browser.close(); } catch (_) {}
        context = null;
        browser = null;
      }
    }

    // METHOD 2: playwright-extra + stealth
    if (!context && PlaywrightExtra) {
      try {
        const launchOpts = { headless: isHeadless, args: launchArgs };
        const proxyConfig = options.proxyUrl ? this._parseProxyUrl(options.proxyUrl) : undefined;
        if (proxyConfig) launchOpts.proxy = proxyConfig;
        browser = await PlaywrightExtra.launch(launchOpts);
        context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 1366, height: 768 },
          userAgent: this._randomUserAgent(),
          locale: 'ru-RU',
        });
        context._stealthBrowser = browser;
        launchMethod = 'stealth';
      } catch (e) {
        this._log('warn', `Stealth launch failed: ${e.message.substring(0, 60)}`);
        if (browser) try { await browser.close(); } catch (_) {}
        context = null;
        browser = null;
      }
    }

    // METHOD 3: plain playwright-core
    if (!context) {
      const launchOpts = { headless: isHeadless, args: launchArgs };
      const proxyConfig = options.proxyUrl ? this._parseProxyUrl(options.proxyUrl) : undefined;
      if (proxyConfig) launchOpts.proxy = proxyConfig;
      browser = await chromium.launch(launchOpts);
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1366, height: 768 },
        userAgent: this._randomUserAgent(),
        locale: 'ru-RU',
      });
      context._plainBrowser = browser;
      launchMethod = 'plain';
    }

    const cid = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    context._engineId = cid;
    context._alive = true;
    context._launchMethod = launchMethod;

    const underlyingBrowser = context._fpBrowser || context._stealthBrowser || context._plainBrowser || context.browser?.() || null;
    if (underlyingBrowser && typeof underlyingBrowser.on === 'function') {
      underlyingBrowser.on('disconnected', () => {
        context._alive = false;
        this.activeContexts.delete(cid);
      });
    }
    context.on('close', () => {
      context._alive = false;
      this.activeContexts.delete(cid);
    });

    this.activeContexts.set(cid, context);
    this._log('success', `Browser launched [${launchMethod}] (headless: ${isHeadless})`);
    return { context, browser: underlyingBrowser };
  }

  _parseProxyUrl(proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      const result = { server: `${u.protocol}//${u.hostname}:${u.port}` };
      if (u.username) result.username = decodeURIComponent(u.username);
      if (u.password) result.password = decodeURIComponent(u.password);
      return result;
    } catch (_) { return null; }
  }

  _randomUserAgent() {
    const versions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0'];
    const v = versions[Math.floor(Math.random() * versions.length)];
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
  }

  _buildProxyUrl(proxy) {
    if (!proxy) return null;
    const protocol = proxy.type === 'socks5' ? 'socks5' : 'http';
    if (proxy.username && proxy.password) {
      return `${protocol}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
    }
    return `${protocol}://${proxy.host}:${proxy.port}`;
  }

  _isContextAlive(context) {
    if (!context || context._alive === false) return false;
    try {
      const browser = context._fpBrowser || context._stealthBrowser || context._plainBrowser || context.browser?.();
      if (browser && typeof browser.isConnected === 'function') return browser.isConnected();
      return context._alive !== false;
    } catch (_) { return false; }
  }

  _isPageAlive(page) {
    try { return page && !page.isClosed(); } catch (_) { return false; }
  }

  // ──────── Cookie Loading ────────

  async loadCookies(context, accountId) {
    if (!accountId) return;
    const cookies = this.accountManager.getCookies(accountId);
    if (!cookies || !cookies.length) {
      this._log('warn', `Account ${accountId.substring(0, 8)} has no cookies`);
      return;
    }
    this._log('info', `Loading ${cookies.length} cookies for ${accountId.substring(0, 8)}...`);
    const fixed = this._fixCookies(cookies);
    try {
      await context.addCookies(fixed);
      this._log('success', `${fixed.length} cookies loaded`);
    } catch (e) {
      this._log('warn', `Batch cookie load failed: ${e.message}, loading individually...`);
      let ok = 0, fail = 0;
      for (const c of fixed) {
        try { await context.addCookies([c]); ok++; } catch (_) { fail++; }
      }
      this._log('info', `Cookies: ${ok} loaded, ${fail} failed`);
    }
  }

  _fixCookies(cookies) {
    return cookies.map(c => {
      const f = { ...c };
      if (f.sameSite) {
        const s = f.sameSite.toLowerCase();
        f.sameSite = s === 'none' ? 'None' : s === 'strict' ? 'Strict' : 'Lax';
      }
      if (f.sameSite === 'None') f.secure = true;
      if (f.expires !== undefined && f.expires !== null) {
        f.expires = Number(f.expires);
        if (isNaN(f.expires) || f.expires < 0) delete f.expires;
      }
      return f;
    });
  }

  // ──────── VK Login (login/pass) ────────

  /**
   * Detect whether login string is a phone number.
   * Accepts: +79..., 89..., 79..., 9... (10 digits), etc.
   */
  _isPhoneNumber(login) {
    const cleaned = login.replace(/[\s\-\(\)]/g, '');
    // Starts with + and has digits
    if (/^\+\d{10,15}$/.test(cleaned)) return true;
    // Russian phone: 8 or 7 followed by 10 digits
    if (/^[78]\d{10}$/.test(cleaned)) return true;
    // Just 10 digits starting with 9 (Russian mobile without prefix)
    if (/^9\d{9}$/.test(cleaned)) return true;
    return false;
  }

  /**
   * Normalize phone to just the 10 digits (without country code).
   * E.g. "+79808673324" -> "9808673324", "89808673324" -> "9808673324"
   */
  _normalizePhone(login) {
    const cleaned = login.replace(/[\s\-\(\)]/g, '');
    // +7XXXXXXXXXX -> XXXXXXXXXX
    if (cleaned.startsWith('+7') && cleaned.length === 12) return cleaned.slice(2);
    // 8XXXXXXXXXX -> XXXXXXXXXX  or  7XXXXXXXXXX -> XXXXXXXXXX
    if (/^[78]\d{10}$/.test(cleaned)) return cleaned.slice(1);
    // Already 10 digits
    if (/^9\d{9}$/.test(cleaned)) return cleaned;
    return cleaned;
  }

  async loginVK(page, login, password) {
    this._log('info', `VK login: ${login}...`);
    try {
      // ── Step 1: Navigate to vk.com ──
      await page.goto('https://vk.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(this.randomInt(2000, 4000));

      // ── Step 1a: Handle robot challenge "Проверяем, что вы не робот" ──
      const robotChallenge = await this._handleRobotChallenge(page);
      if (robotChallenge === 'blocked') {
        return { success: false, error: 'robot_challenge', details: 'VK robot verification required, try with proxy or later' };
      }

      // ── Step 2: Click "Войти другим способом" to switch from QR to phone/email form ──
      const altLoginBtn = page.locator('button:has-text("Войти другим способом")').first();
      if (await altLoginBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
        await altLoginBtn.click();
        this._log('info', 'Clicked "Войти другим способом"');
        await page.waitForTimeout(this.randomInt(2000, 4000));
      } else {
        this._log('warn', '"Войти другим способом" button not found, trying direct login page...');
        // Fallback: try going to id.vk.com directly
        await page.goto('https://id.vk.com/auth', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(this.randomInt(2000, 4000));
      }

      // ── Step 3: Determine login type (phone vs email) and select radio ──
      const isPhone = this._isPhoneNumber(login);
      this._log('info', `Login type: ${isPhone ? 'phone' : 'email/login'}`);

      if (isPhone) {
        // Make sure "Телефон" radio is selected (it's default, but be safe)
        const phoneRadio = page.locator('input[name="login-view"][value="phone"]');
        if (await phoneRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
          const isChecked = await phoneRadio.isChecked().catch(() => true);
          if (!isChecked) {
            await phoneRadio.click();
            await page.waitForTimeout(this.randomInt(500, 1000));
          }
        }
      } else {
        // Select "Почта" radio for email/login input
        const emailRadio = page.locator('input[name="login-view"][value="email"]');
        if (await emailRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
          await emailRadio.click();
          await page.waitForTimeout(this.randomInt(500, 1000));
          this._log('info', 'Switched to email/login mode');
        } else {
          // Try clicking the label
          const emailLabel = page.locator('label:has-text("Почта")').first();
          if (await emailLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
            await emailLabel.click();
            await page.waitForTimeout(this.randomInt(500, 1000));
          }
        }
      }

      // ── Step 4: Enter login ──
      const loginInput = page.locator('input[name="login"]').first();
      await loginInput.waitFor({ state: 'visible', timeout: 10000 });
      await loginInput.click();
      await page.waitForTimeout(this.randomInt(300, 700));

      if (isPhone) {
        // Phone input has "+7 " pre-filled. Clear it and type just the 10 digits.
        // VK auto-formats to "+7 XXX XXX XX XX"
        const phoneDigits = this._normalizePhone(login);
        // Triple-click to select all, then delete
        await loginInput.click({ clickCount: 3 });
        await page.waitForTimeout(200);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        // Now type the digits — VK will auto-add "+7 " prefix
        await this.typeHumanLike(loginInput, phoneDigits);
      } else {
        // For email/login: clear and type
        await loginInput.fill('');
        await page.waitForTimeout(200);
        await this.typeHumanLike(loginInput, login);
      }
      await page.waitForTimeout(this.randomInt(500, 1500));

      // ── Step 5: Click "Войти" to submit phone/email ──
      const submitLoginBtn = page.locator('button:has-text("Войти")').first();
      if (await submitLoginBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await submitLoginBtn.click();
        this._log('info', 'Clicked "Войти" — waiting for next step...');
      } else {
        // Fallback: press Enter
        await page.keyboard.press('Enter');
        this._log('info', 'Pressed Enter to submit login');
      }
      await page.waitForTimeout(this.randomInt(4000, 7000));

      // ── Step 6: Check what happened — OTP page, password page, error, or captcha ──
      const currentUrl = page.url();
      this._log('info', `After login submit: ${currentUrl.substring(0, 80)}...`);

      // Check for captcha
      const hasCaptcha = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        return bodyText.includes('captcha') || bodyText.includes('каптча') ||
               !!document.querySelector('[class*="captcha"], [class*="Captcha"], img[src*="captcha"]');
      });
      if (hasCaptcha) {
        this._log('warn', 'CAPTCHA detected during VK login');
        return { success: false, error: 'captcha', details: 'Captcha appeared during login' };
      }

      // Check for error messages (e.g. "Пользователь не найден")
      const loginError = await page.evaluate(() => {
        const errorEls = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"]');
        for (const el of errorEls) {
          if (el.offsetWidth > 0 && el.textContent.trim()) return el.textContent.trim();
        }
        return null;
      });
      if (loginError) {
        this._log('error', `VK login error: ${loginError}`);
        return { success: false, error: 'login_error', details: loginError };
      }

      // ── Step 6a: Handle OTP (SMS code) page ──
      // VK now shows OTP by default. We need to click "Подтвердить другим способом" to get password field.
      const otpInput = page.locator('input[name="otp-cell"]').first();
      const hasOtp = await otpInput.isVisible({ timeout: 3000 }).catch(() => false);

      if (hasOtp) {
        this._log('info', 'OTP page detected — clicking "Подтвердить другим способом" for password...');
        const altConfirmBtn = page.locator('button:has-text("Подтвердить другим способом")').first();
        if (await altConfirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await altConfirmBtn.click();
          await page.waitForTimeout(this.randomInt(2000, 4000));
        } else {
          this._log('warn', 'Cannot find "Подтвердить другим способом" — only SMS/OTP available');
          return { success: false, error: 'otp_only', details: 'Account requires SMS code, password option not available' };
        }
      }

      // ── Step 6b: Handle "Выберите способ подтверждения" popup ──
      // This popup offers: QR-код, Код на телефон, Восстановить доступ, and may also show password
      await this._dismissConfirmationPopup(page);

      // ── Step 7: Enter password ──
      const passInput = page.locator('input[name="password"], input[type="password"]').first();
      const hasPassword = await passInput.isVisible({ timeout: 8000 }).catch(() => false);

      if (hasPassword) {
        this._log('info', 'Password field found — entering password...');
        await passInput.click();
        await page.waitForTimeout(this.randomInt(300, 700));
        await this.typeHumanLike(passInput, password);
        await page.waitForTimeout(this.randomInt(500, 1500));

        // Click "Продолжить" (Continue)
        const continueBtn = page.locator('button:has-text("Продолжить"), button:has-text("Войти"), button[type="submit"]').first();
        if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await continueBtn.click();
          this._log('info', 'Clicked "Продолжить" — waiting for result...');
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForTimeout(this.randomInt(5000, 8000));
      } else {
        this._log('warn', 'No password field found');
        // Maybe we're already on a 2FA challenge or some other state
        const pageText = await page.evaluate(() => document.body.innerText.substring(0, 300));
        return { success: false, error: 'no_password_field', details: `Page state: ${pageText.substring(0, 150)}` };
      }

      // ── Step 8: After password — check for 2FA, additional challenges, or success ──

      // Check for "Выберите способ подтверждения" again (may appear after password)
      await this._dismissConfirmationPopup(page);

      // Check for 2FA code input
      const has2fa = await page.locator('input[name="otp-cell"], input[name="code"]').first()
        .isVisible({ timeout: 3000 }).catch(() => false);
      if (has2fa) {
        this._log('warn', '2FA code requested after password');
        return { success: false, error: 'challenge', details: '2FA verification code required after password' };
      }

      // Check for another captcha after password
      const hasCaptcha2 = await page.evaluate(() => {
        return !!document.querySelector('[class*="captcha"], [class*="Captcha"], img[src*="captcha"]');
      });
      if (hasCaptcha2) {
        this._log('warn', 'CAPTCHA detected after password');
        return { success: false, error: 'captcha', details: 'Captcha appeared after password entry' };
      }

      // Check for error after password
      const passError = await page.evaluate(() => {
        const errorEls = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"]');
        for (const el of errorEls) {
          const text = el.textContent.trim();
          if (el.offsetWidth > 0 && text && text.length > 3) return text;
        }
        // Also check for "Неверный пароль"
        const bodyText = document.body.innerText || '';
        if (bodyText.includes('Неверный пароль') || bodyText.includes('Incorrect password')) {
          return 'Неверный пароль';
        }
        return null;
      });
      if (passError) {
        this._log('error', `Password error: ${passError}`);
        return { success: false, error: 'wrong_password', details: passError };
      }

      // ── Step 9: Check if we're logged in ──
      const isLoggedIn = await this._checkVKLogin(page);
      if (isLoggedIn) {
        this._log('success', `VK login successful: ${login}`);
        const cookies = await page.context().cookies();
        return { success: true, cookies };
      }

      // Final unknown state
      const finalUrl = page.url();
      const finalText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      this._log('error', `VK login failed — unknown state at: ${finalUrl.substring(0, 80)}`);
      return { success: false, error: 'unknown', details: `URL: ${finalUrl.substring(0, 100)}, Text: ${finalText.substring(0, 100)}` };
    } catch (e) {
      this._log('error', `VK login error: ${e.message}`);
      return { success: false, error: 'exception', details: e.message };
    }
  }

  /**
   * Dismiss the "Выберите способ подтверждения" popup that may appear.
   * This popup offers QR-код, Код на телефон, etc.
   * We try to close it so the password form remains accessible.
   */
  async _dismissConfirmationPopup(page) {
    try {
      // Look for the popup with "Выберите способ подтверждения" or "Закрыть"
      const closeBtn = page.locator('button:has-text("Закрыть")').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
        this._log('info', 'Dismissed "Выберите способ подтверждения" popup');
        await page.waitForTimeout(this.randomInt(500, 1000));
        return true;
      }
      return false;
    } catch (_) { return false; }
  }

  /**
   * Handle VK "Проверяем, что вы не робот" (robot challenge) page.
   * This page appears when VK suspects automated access.
   * It typically has a "Продолжить" button that when clicked may solve the challenge
   * or redirect to a CAPTCHA.
   * Returns: 'passed' if challenge handled, 'blocked' if cannot proceed, 'none' if no challenge.
   */
  async _handleRobotChallenge(page) {
    try {
      const url = page.url();
      const isChallenge = url.includes('challenge.html') || url.includes('/challenge');
      if (!isChallenge) {
        // Also check by page text
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
        if (!bodyText.includes('не робот') && !bodyText.includes('not a robot')) return 'none';
      }

      this._log('warn', 'VK robot challenge detected — attempting to pass...');

      // Try clicking "Продолжить" (Continue) button on the challenge page
      const continueBtn = page.locator('button:has-text("Продолжить")').first();
      if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await continueBtn.click();
        await page.waitForTimeout(this.randomInt(5000, 8000));

        // Check if we got through
        const newUrl = page.url();
        if (!newUrl.includes('challenge')) {
          this._log('success', 'Robot challenge passed');
          return 'passed';
        }
      }

      // If still on challenge page, check for CAPTCHA
      const hasCaptcha = await page.evaluate(() => {
        return !!document.querySelector('iframe[src*="captcha"], [class*="captcha"], [class*="Captcha"]');
      });
      if (hasCaptcha) {
        this._log('warn', 'Robot challenge requires CAPTCHA');
        return 'blocked';
      }

      this._log('warn', 'Robot challenge could not be resolved');
      return 'blocked';
    } catch (e) {
      this._log('warn', `Robot challenge handler error: ${e.message}`);
      return 'none';
    }
  }

  async _checkVKLogin(page) {
    try {
      const url = page.url();
      // After successful login, VK redirects to feed or profile
      if (url.includes('/feed') || url.match(/\/id\d/) || url.includes('/im')) return true;
      // vk.com main page when logged in (no /auth in URL)
      if (url === 'https://vk.com/' || url === 'https://vk.com') {
        // Need to verify we're actually logged in, not just on the landing page
      }

      const loggedIn = await page.evaluate(() => {
        const selectors = [
          // Modern VK UI (2024-2026) selectors
          'a[href*="/im"]',          // Messages link in navbar
          '[class*="TopNavBtn"]',    // Top nav buttons (logged in)
          '#l_msg',                  // Left menu: messages
          '#l_pr',                   // Left menu: profile
          'a[href*="/feed"]',        // Feed link
          '[class*="ProfileLink"]',  // Profile link in header
          '[class*="TopSearch"]',    // Top search (only when logged in on main page)
          'a[href*="/settings"]',    // Settings link
          '.page_block',             // Page content block
          // Sidebar navigation elements
          'a[href*="/friends"]',     // Friends link
          'a[href*="/groups"]',      // Groups link
          // VK ID callback: check if the page has user data
          '[data-task-click="ProfileAction/toggle"]',
          '.TopHomeLink',
        ];
        return selectors.some(s => document.querySelector(s));
      });
      return loggedIn;
    } catch (_) { return false; }
  }

  // ──────── Cookie Verification ────────

  async verifyCookies(accountId, proxyId = null) {
    const account = this.accountManager.getById(accountId);
    if (!account) return { valid: false, error: 'Account not found' };

    // Use headless setting from user settings (same as tasks)
    const settings = this.store.get('settings');
    const isHeadless = settings.headless;

    // For logpass accounts — attempt actual VK login to verify
    if (account.authType === 'logpass') {
      if (!account.login || !account.password) {
        return { valid: false, error: 'No login/password set' };
      }

      this._log('info', `Verifying VK logpass account "${account.name}" via login (headless: ${isHeadless})...`);
      let contextObj = null;
      try {
        const proxy = proxyId ? this.proxyManager.getById(proxyId) :
          (account.proxyId ? this.proxyManager.getById(account.proxyId) : null);
        const proxyUrl = proxy ? this._buildProxyUrl(proxy) : null;

        contextObj = await this.launchContext({ proxyUrl, headless: isHeadless, accountId });
        const { context } = contextObj;

        // If this account already has saved cookies from a previous successful login, load them first
        const existingCookies = this.accountManager.getCookies(accountId);
        if (existingCookies && existingCookies.length) {
          await this.loadCookies(context, accountId);
          const page = await context.newPage();
          await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(5000);
          const isLoggedIn = await this._checkVKLogin(page);
          if (isLoggedIn) {
            this._log('success', `"${account.name}" — cookies still valid`);
            this.accountManager.updateAccount(accountId, { status: 'valid', lastCheck: new Date().toISOString() });
            await this._safeContextClose(context);
            return { valid: true, details: 'Logged in via saved cookies' };
          }
          // Cookies expired — close and try fresh login
          await page.close().catch(() => {});
        }

        // Attempt login with credentials
        const page = await context.newPage();
        const loginResult = await this.loginVK(page, account.login, account.password);

        if (loginResult.success) {
          // Save cookies from successful login for future use
          if (loginResult.cookies) {
            this.accountManager.setCookiesRaw(accountId, loginResult.cookies, 'playwright');
          }
          this.accountManager.updateAccount(accountId, {
            status: 'valid',
            hasCookies: true,
            lastCheck: new Date().toISOString(),
          });
          await this._safeContextClose(context);
          return { valid: true, details: 'Login successful' };
        }

        // Login failed
        const errorMsg = loginResult.error === 'captcha' ? 'Captcha required during login'
          : loginResult.error === 'challenge' ? '2FA / security check required'
          : loginResult.details || loginResult.error || 'Login failed';

        this.accountManager.updateAccount(accountId, {
          status: loginResult.error === 'captcha' || loginResult.error === 'challenge' ? 'unchecked' : 'invalid',
          lastCheck: new Date().toISOString(),
        });
        await this._safeContextClose(context);
        return { valid: false, error: errorMsg };

      } catch (e) {
        this._log('error', `Logpass verify error: ${e.message}`);
        if (contextObj) await this._safeContextClose(contextObj.context);
        this.accountManager.updateAccount(accountId, { status: 'invalid', lastCheck: new Date().toISOString() });
        return { valid: false, error: e.message };
      }
    }

    // For cookie-based accounts — verify cookies directly
    const cookies = this.accountManager.getCookies(accountId);
    if (!cookies || !cookies.length) return { valid: false, error: 'No cookies' };

    this._log('info', `Verifying VK account "${account.name}" cookies (headless: ${isHeadless})...`);
    let contextObj = null;
    try {
      const proxy = proxyId ? this.proxyManager.getById(proxyId) :
        (account.proxyId ? this.proxyManager.getById(account.proxyId) : null);
      const proxyUrl = proxy ? this._buildProxyUrl(proxy) : null;

      contextObj = await this.launchContext({ proxyUrl, headless: isHeadless, accountId });
      const { context } = contextObj;
      await this.loadCookies(context, accountId);

      const page = await context.newPage();
      await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);

      const isLoggedIn = await this._checkVKLogin(page);
      const valid = isLoggedIn;

      this.accountManager.updateAccount(accountId, {
        status: valid ? 'valid' : 'invalid',
        lastCheck: new Date().toISOString(),
      });

      await this._safeContextClose(context);
      return { valid, details: valid ? 'Logged in' : 'Not logged in' };
    } catch (e) {
      this._log('error', `Verify error: ${e.message}`);
      if (contextObj) await this._safeContextClose(contextObj.context);
      this.accountManager.updateAccount(accountId, { status: 'invalid', lastCheck: new Date().toISOString() });
      return { valid: false, error: e.message };
    }
  }

  async bulkVerifyCookies(accountIds, proxyId = null, onProgress) {
    const results = [];
    for (let i = 0; i < accountIds.length; i++) {
      const r = await this.verifyCookies(accountIds[i], proxyId);
      results.push({ id: accountIds[i], ...r });
      onProgress?.({ current: i + 1, total: accountIds.length });
    }
    return results;
  }

  // ──────── VK Warm-up Browsing ────────

  async warmUpBrowsing(page, signal) {
    if (signal?.aborted) return;
    const settings = this.store.get('settings');
    const wu = settings.warmUp || {};

    const homeMinMs = (wu.homePageMin || 3) * 1000;
    const homeMaxMs = (wu.homePageMax || 8) * 1000;
    const scrollMinMs = (wu.scrollPauseMin || 1.5) * 1000;
    const scrollMaxMs = (wu.scrollPauseMax || 5) * 1000;
    const vidWatchMinMs = (wu.videoWatchMin || 5) * 1000;
    const vidWatchMaxMs = (wu.videoWatchMax || 25) * 1000;

    const w = wu.scenarioWeight || { chill: 30, curious: 25, explorer: 20, searcher: 15, impatient: 10 };
    const totalW = (w.chill || 0) + (w.curious || 0) + (w.explorer || 0) + (w.searcher || 0) + (w.impatient || 0);
    const roll = Math.random() * totalW;
    let scenario;
    if (roll < w.chill) scenario = 'chill';
    else if (roll < w.chill + w.curious) scenario = 'curious';
    else if (roll < w.chill + w.curious + w.explorer) scenario = 'explorer';
    else if (roll < w.chill + w.curious + w.explorer + w.searcher) scenario = 'searcher';
    else scenario = 'impatient';

    this._log('info', `Warm-up [${scenario}]: browsing VK feed...`);

    try {
      await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(this.randomInt(homeMinMs, homeMaxMs));

      if (signal?.aborted || !this._isPageAlive(page)) return;

      if (scenario === 'chill') {
        const scrolls = this.randomInt(3, 6);
        for (let i = 0; i < scrolls; i++) {
          if (signal?.aborted || !this._isPageAlive(page)) return;
          await page.mouse.wheel(0, this.randomInt(200, 600));
          await page.waitForTimeout(this.randomInt(scrollMinMs, scrollMaxMs));
          if (Math.random() < 0.4) {
            await page.mouse.move(this.randomInt(150, 1100), this.randomInt(200, 550));
            await page.waitForTimeout(this.randomInt(800, 2500));
          }
        }
      } else if (scenario === 'curious') {
        // Browse some friend profiles or groups
        await page.mouse.wheel(0, this.randomInt(300, 600));
        await page.waitForTimeout(this.randomInt(scrollMinMs, scrollMaxMs));
        try {
          const links = page.locator('a[href*="/video"], a[href*="/clip"]').first();
          if (await links.isVisible({ timeout: 3000 }).catch(() => false)) {
            await links.click();
            await page.waitForTimeout(this.randomInt(vidWatchMinMs, vidWatchMaxMs));
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(this.randomInt(2000, 4000));
          }
        } catch (_) {}
      } else if (scenario === 'explorer') {
        const destinations = [
          'https://vk.com/video', 'https://vk.com/clips', 'https://vk.com/discover',
        ];
        const dest = destinations[Math.floor(Math.random() * destinations.length)];
        try {
          await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(this.randomInt(homeMinMs, homeMaxMs));
          const scrolls = this.randomInt(2, 5);
          for (let i = 0; i < scrolls; i++) {
            if (signal?.aborted || !this._isPageAlive(page)) return;
            await page.mouse.wheel(0, this.randomInt(300, 700));
            await page.waitForTimeout(this.randomInt(scrollMinMs, scrollMaxMs));
          }
        } catch (_) {}
      } else if (scenario === 'searcher') {
        const randomQueries = [
          'музыка 2025', 'смешные видео', 'новости', 'приколы', 'рецепты',
          'обзор', 'gaming', 'travel', 'дтп', 'лайфхаки', 'клипы',
        ];
        const query = randomQueries[Math.floor(Math.random() * randomQueries.length)];
        try {
          await page.goto('https://vk.com/video', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(this.randomInt(1500, 3000));
          const searchInput = page.locator('input[type="search"], input[placeholder*="Поиск"], input[placeholder*="Search"], .ui_search_field input').first();
          if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await searchInput.click();
            await page.waitForTimeout(this.randomInt(500, 1500));
            await this.typeHumanLike(searchInput, query);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(this.randomInt(3000, 6000));
            const scrolls = this.randomInt(1, 3);
            for (let i = 0; i < scrolls; i++) {
              await page.mouse.wheel(0, this.randomInt(300, 600));
              await page.waitForTimeout(this.randomInt(scrollMinMs, scrollMaxMs));
            }
          }
        } catch (_) {}
      } else if (scenario === 'impatient') {
        await page.mouse.wheel(0, this.randomInt(100, 300));
        await page.waitForTimeout(this.randomInt(Math.round(homeMinMs * 0.3), Math.round(homeMinMs * 0.6)));
      }

      this._log('success', `Warm-up [${scenario}] complete`);
    } catch (e) {
      this._log('debug', `Warm-up error: ${e.message.substring(0, 60)}`);
    }
  }

  // ──────── VK Video Search ────────

  async searchAndFindVideo(page, keywords, targetVideoUrl, signal) {
    this._log('info', `VK video search: "${keywords}" — target: ${targetVideoUrl}`);
    try {
      await page.goto('https://vk.com/video', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(this.randomInt(2000, 4000));

      const searchInput = page.locator('input[type="search"], input[placeholder*="Поиск"], input[placeholder*="Search"], .ui_search_field input, #video_search_input').first();
      if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await searchInput.click();
        await page.waitForTimeout(this.randomInt(500, 1000));
        await searchInput.fill('');
        await this.typeHumanLike(searchInput, keywords, { min: 40, max: 120 });
        await page.waitForTimeout(this.randomInt(500, 1500));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(this.randomInt(3000, 5000));
      } else {
        await page.goto(`https://vk.com/video?q=${encodeURIComponent(keywords)}`, {
          waitUntil: 'domcontentloaded', timeout: 60000,
        });
        await page.waitForTimeout(this.randomInt(3000, 5000));
      }
    } catch (e) {
      this._log('error', `Search failed: ${e.message.substring(0, 80)}`);
      return false;
    }

    // Try to find the target video
    const targetId = this._extractVKVideoId(targetVideoUrl);
    const MAX_SCROLLS = 15;

    for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
      if (signal?.aborted || !this._isPageAlive(page)) return false;

      const found = await page.evaluate((targetUrl) => {
        const links = document.querySelectorAll('a[href*="/video"], a[href*="video-"]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (targetUrl && href.includes(targetUrl)) {
            link.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return { found: true, href };
          }
        }
        return { found: false };
      }, targetId || targetVideoUrl);

      if (found.found) {
        this._log('success', `Found video (scroll #${scroll})`);
        await page.waitForTimeout(this.randomInt(1000, 3000));
        try {
          const link = page.locator(`a[href*="${targetId || targetVideoUrl}"]`).first();
          await link.click();
          await page.waitForTimeout(this.randomInt(3000, 6000));
          return true;
        } catch (_) {}
      }

      this._log('info', `Scroll #${scroll + 1}/${MAX_SCROLLS} — not found yet`);
      await page.mouse.wheel(0, this.randomInt(800, 1500));
      await page.waitForTimeout(this.randomInt(2000, 4000));
    }

    this._log('warn', `Video not found after ${MAX_SCROLLS} scrolls`);
    return false;
  }

  _extractVKVideoId(url) {
    if (!url) return null;
    // VK video URLs: /video-12345_67890 or /video12345_67890
    const m = url.match(/video-?\d+_\d+/);
    return m ? m[0] : null;
  }

  // ──────── Watch Video ────────

  async watchVideo(page, durationSec, signal) {
    if (!this._isPageAlive(page)) return false;
    this._log('info', `Watching video for ${durationSec}s...`);

    try {
      // Try to click play button
      await this.ensurePlayback(page);

      const checkInterval = 3000;
      let watched = 0;
      const targetMs = durationSec * 1000;

      while (watched < targetMs) {
        if (signal?.aborted || !this._isPageAlive(page)) return false;
        await page.waitForTimeout(checkInterval);
        watched += checkInterval;

        // Random mouse movement while watching
        if (Math.random() < 0.2) {
          await page.mouse.move(this.randomInt(200, 1000), this.randomInt(200, 500));
        }
        // Occasional scroll
        if (Math.random() < 0.05) {
          await page.mouse.wheel(0, this.randomInt(50, 200));
        }
      }

      this._log('success', `Watched ${durationSec}s`);
      return true;
    } catch (e) {
      this._log('warn', `Watch error: ${e.message}`);
      return false;
    }
  }

  async ensurePlayback(page) {
    try {
      // Try VK video player play button
      const playBtn = page.locator('.videoplayer_btn_play, .VideoLayerInfo__playBtn, [class*="play_btn"], video').first();
      if (await playBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click().catch(() => {});
        await page.waitForTimeout(this.randomInt(1000, 2000));
      }
      // Try clicking the video element directly
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video && video.paused) video.play().catch(() => {});
      }).catch(() => {});
    } catch (_) {}
  }

  // ──────── Like ────────

  async pressLike(page) {
    if (!this._isPageAlive(page)) return false;
    this._log('info', 'Pressing Like on VK video...');
    try {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await page.waitForTimeout(this.randomInt(1000, 2000));

      const result = await page.evaluate(() => {
        // VK like button selectors
        const selectors = [
          '.VideoActionLike button', '.like_btn', '.PostBottomAction--like button',
          'button[class*="like"]', '.VideoLayerInfo__like', '[data-like-id] .like_btn',
          '.video_like_wrap .like_btn', 'button[aria-label*="like"]', 'button[aria-label*="нравится"]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            const isActive = btn.classList.contains('active') ||
                             btn.classList.contains('like_btn_active') ||
                             btn.getAttribute('aria-pressed') === 'true';
            if (isActive) return { found: true, alreadyLiked: true };
            btn.click();
            return { found: true, alreadyLiked: false, clicked: true };
          }
        }
        return { found: false };
      });

      if (result.found) {
        if (result.alreadyLiked) { this._log('info', 'Already liked'); return true; }
        if (result.clicked) {
          await page.waitForTimeout(this.randomInt(1000, 2000));
          this._log('success', 'Like pressed!');
          return true;
        }
      }
      this._log('warn', 'Like button not found');
      return false;
    } catch (e) {
      this._log('warn', `Like failed: ${e.message}`);
      return false;
    }
  }

  // ──────── Comment ────────

  async postComment(page, text, settings) {
    if (!this._isPageAlive(page)) return false;
    this._log('info', `Posting comment: "${text.substring(0, 40)}..."`);
    try {
      // Scroll to comments area
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, this.randomInt(250, 500));
        await this.randomDelay(500, 1000);
      }
      await this.randomDelay(1500, 3000);

      // Find and click comment input
      const commentBox = page.locator(
        '.reply_fakebox, .reply_field, [contenteditable="true"][data-placeholder*="Комментарий"], ' +
        '[contenteditable="true"][data-placeholder*="Comment"], .wall_module .reply_field, ' +
        'div[class*="CommentTextarea"], textarea[placeholder*="Comment"], textarea[placeholder*="Комментарий"]'
      ).first();

      await commentBox.click();
      await this.randomDelay(500, 1000);

      // Type the comment
      const inputField = page.locator('[contenteditable="true"]:focus, textarea:focus, .reply_field[contenteditable="true"]').first();
      if (await inputField.isVisible({ timeout: 5000 }).catch(() => false)) {
        await this.typeHumanLike(inputField, text, settings?.typingDelay);
      } else {
        // Fallback: type via keyboard
        await page.keyboard.type(text, { delay: this.randomInt(50, 150) });
      }

      await this.randomDelay(1000, 2000);

      // Submit comment
      const submitBtn = page.locator(
        'button.reply_send_btn, button[class*="submit"], ' +
        'button:has-text("Отправить"), button:has-text("Send"), .reply_send'
      ).first();

      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        // VK often uses Ctrl+Enter to submit
        await page.keyboard.press('Control+Enter');
      }

      await this.randomDelay(2000, 4000);
      this._log('success', 'Comment posted');
      return true;
    } catch (e) {
      this._log('warn', `Comment failed: ${e.message}`);
      return false;
    }
  }

  // ──────── Engagement Task Execution ────────

  async executeEngagementTask(task, onProgress, signal) {
    const settings = this.store.get('settings');
    const { videoUrl, viewCount, likeCount, commentCount, searchKeywords, useSearch, accountIds } = task;

    if (!videoUrl) {
      this._log('error', 'No video URL');
      return [{ status: 'error', error: 'No video URL' }];
    }

    const maxConcurrency = settings.maxConcurrency || 3;
    const ops = this._buildOperationPlan(task);

    // Get comments
    let selComments = [];
    if (task.commentFolderId) {
      const folders = this.store.get('commentFolders', []);
      const folder = folders.find(f => f.id === task.commentFolderId);
      if (folder && folder.comments.length) {
        selComments = folder.comments;
        this._log('info', `Using comment folder: "${folder.name}" (${folder.comments.length} comments)`);
      }
    } else {
      selComments = this.store.get('comments', []);
    }

    const launchInfo = hasLocalFingerprints ? 'fingerprint-injector' : PlaywrightExtra ? 'stealth' : 'plain';
    this._log('info', '═══════════════════════════════════════');
    this._log('info', `TASK STARTED — VK Video v1.0 (${launchInfo})`);
    this._log('info', `Video: ${videoUrl}`);
    this._log('info', `Views: ${viewCount}, Likes: ${likeCount}, Comments: ${commentCount}`);
    this._log('info', `Mode: ${useSearch ? `SEARCH "${searchKeywords}"` : 'DIRECT URL'}`);
    this._log('info', `Accounts: ${accountIds.length}, Operations: ${ops.length}, Concurrency: ${maxConcurrency}`);
    this._log('info', '═══════════════════════════════════════');

    const results = [];
    let completedCount = 0;

    for (let batchStart = 0; batchStart < ops.length; batchStart += maxConcurrency) {
      if (signal?.aborted) break;

      const batchEnd = Math.min(batchStart + maxConcurrency, ops.length);
      const batch = ops.slice(batchStart, batchEnd);
      const batchNum = Math.floor(batchStart / maxConcurrency) + 1;
      this._log('info', `── Batch ${batchNum}: ops ${batchStart + 1}-${batchEnd} ──`);

      const batchPromises = batch.map((op, idx) => {
        const globalIdx = batchStart + idx;
        const staggerDelay = idx * this.randomInt(5000, 15000);
        return new Promise(resolve => {
          setTimeout(async () => {
            if (signal?.aborted) { resolve({ op: globalIdx + 1, status: 'skipped' }); return; }
            const result = await this._executeSingleOp(op, globalIdx, ops.length, task, settings, selComments, signal);
            completedCount++;
            onProgress?.({
              current: completedCount, total: ops.length,
              status: result.status === 'success' ? 'done' : 'error',
              message: `${result.account}: ${result.status}`,
              progress: Math.round((completedCount / ops.length) * 100),
            });
            resolve(result);
          }, staggerDelay);
        });
      });

      const batchResults = await Promise.allSettled(batchPromises);
      for (const r of batchResults) {
        results.push(r.status === 'fulfilled' ? r.value : { status: 'error', error: 'Promise rejected' });
      }

      if (batchEnd < ops.length && !signal?.aborted) {
        const delay = this.randomInt(3, 8);
        this._log('info', `Waiting ${delay}s before next batch...`);
        await new Promise(r => setTimeout(r, delay * 1000));
      }
    }

    const ok = results.filter(r => r.status === 'success').length;
    const fail = results.filter(r => r.status === 'error').length;
    this._log('info', '═══════════════════════════════════════');
    this._log('info', `TASK COMPLETE: ${ok}/${ops.length} success, ${fail} errors`);
    this._log('info', '═══════════════════════════════════════');
    return results;
  }

  _buildOperationPlan(task) {
    const ops = [];
    const { viewCount, likeCount, commentCount, accountIds, proxyIds, allowDirect } = task;
    const pool = [...(proxyIds || [])];
    if (allowDirect) pool.push(null);

    for (let i = 0; i < Math.max(viewCount, 1); i++) {
      const accId = accountIds[i % accountIds.length];
      const proxyId = pool.length ? pool[i % pool.length] : null;
      ops.push({
        accountId: accId,
        proxyId,
        shouldLike: i < likeCount,
        shouldComment: i < commentCount,
      });
    }
    return ops;
  }

  async _executeSingleOp(op, opIdx, totalOps, task, settings, selComments, signal) {
    const account = this.accountManager.getById(op.accountId);
    const accName = account?.name || '?';
    const proxyObj = op.proxyId ? this.proxyManager.getById(op.proxyId) : null;
    const proxyInfo = proxyObj ? `${proxyObj.host}:${proxyObj.port}` : 'direct';
    const proxyUrl = proxyObj ? this._buildProxyUrl(proxyObj) : null;

    this._log('info', `Op ${opIdx + 1}/${totalOps}: ${accName} via ${proxyInfo} [watch${op.shouldLike ? '+like' : ''}${op.shouldComment ? '+comment' : ''}]`);

    let context = null;
    try {
      const launched = await this.launchContext({
        proxyUrl, headless: settings.headless, accountId: op.accountId,
      });
      context = launched.context;
      if (signal?.aborted) throw new Error('Aborted');

      // Load cookies if cookie-based account or logpass with saved cookies
      if (account.authType === 'cookies' || account.hasCookies) {
        await this.loadCookies(context, op.accountId);
      }

      const page = await context.newPage();

      // Login if logpass account without saved cookies
      if (account.authType === 'logpass' && account.login && account.password && !account.hasCookies) {
        const loginResult = await this.loginVK(page, account.login, account.password);
        if (!loginResult.success) {
          this._log('error', `Login failed for ${accName}: ${loginResult.error}`);
          await this._safeContextClose(context);
          return { op: opIdx + 1, account: accName, status: 'error', error: `Login failed: ${loginResult.error}` };
        }
        // Save cookies from successful login
        if (loginResult.cookies) {
          this.accountManager.setCookiesRaw(op.accountId, loginResult.cookies, 'playwright');
          this.accountManager.updateAccount(op.accountId, { status: 'valid', hasCookies: true });
        }
      } else if (account.authType === 'logpass' && account.hasCookies) {
        // Logpass account with saved cookies — verify they still work
        await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        const cookiesValid = await this._checkVKLogin(page);
        if (!cookiesValid) {
          this._log('info', `Saved cookies expired for ${accName}, re-logging in...`);
          const loginResult = await this.loginVK(page, account.login, account.password);
          if (!loginResult.success) {
            this._log('error', `Re-login failed for ${accName}: ${loginResult.error}`);
            await this._safeContextClose(context);
            return { op: opIdx + 1, account: accName, status: 'error', error: `Re-login failed: ${loginResult.error}` };
          }
          if (loginResult.cookies) {
            this.accountManager.setCookiesRaw(op.accountId, loginResult.cookies, 'playwright');
            this.accountManager.updateAccount(op.accountId, { status: 'valid', hasCookies: true });
          }
        }
      }

      if (signal?.aborted) throw new Error('Aborted');

      // Warm-up
      if (settings.warmUp?.homePageMin > 0) {
        await this.warmUpBrowsing(page, signal);
      }

      if (signal?.aborted) throw new Error('Aborted');

      // Navigate to video
      let videoOpened = false;
      if (task.useSearch && task.searchKeywords) {
        videoOpened = await this.searchAndFindVideo(page, task.searchKeywords, task.videoUrl, signal);
      }
      if (!videoOpened) {
        await page.goto(task.videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(this.randomInt(3000, 6000));
        videoOpened = true;
      }

      if (signal?.aborted) throw new Error('Aborted');

      // Watch video
      const watchMin = settings.watchDuration?.min || 30;
      const watchMax = settings.watchDuration?.max || 120;
      const watchDuration = this.randomInt(watchMin, watchMax);
      await this.watchVideo(page, watchDuration, signal);

      // Like
      if (op.shouldLike) {
        await this.pressLike(page);
      }

      // Comment
      if (op.shouldComment && selComments.length > 0) {
        const randomComment = selComments[Math.floor(Math.random() * selComments.length)];
        const commentText = randomComment.text || randomComment;
        await this.postComment(page, commentText, settings);
      }

      await this._safeContextClose(context);
      this._log('success', `Op ${opIdx + 1} done: ${accName}`);
      return { op: opIdx + 1, account: accName, status: 'success' };

    } catch (e) {
      if (context) await this._safeContextClose(context);
      this._log('error', `Op ${opIdx + 1} error: ${e.message}`);
      return { op: opIdx + 1, account: accName, status: 'error', error: e.message };
    }
  }

  // ──────── Helpers ────────

  randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  async randomDelay(min, max) {
    await new Promise(r => setTimeout(r, this.randomInt(min, max)));
  }

  async typeHumanLike(locator, text, delayOpts) {
    const min = delayOpts?.min || 50;
    const max = delayOpts?.max || 150;
    for (const char of text) {
      await locator.type(char, { delay: 0 });
      await new Promise(r => setTimeout(r, this.randomInt(min, max)));
      if (Math.random() < 0.05) {
        await new Promise(r => setTimeout(r, this.randomInt(300, 800)));
      }
    }
  }

  async _safeContextClose(context) {
    try {
      const browser = context._fpBrowser || context._stealthBrowser || context._plainBrowser || context.browser?.();
      if (browser) await browser.close();
      else await context.close();
    } catch (_) {}
  }

  async cleanup() {
    for (const [cid, context] of this.activeContexts) {
      await this._safeContextClose(context);
    }
    this.activeContexts.clear();
  }
}

module.exports = { PlaywrightEngine };

/**
 * PlaywrightEngine v1.0
 * VK Video Engagement Tool - Browser Automation Engine
 * 
 * Supports: fingerprint injection, playwright-extra stealth, plain launch
 * Features: VK login, cookie management, warm-up, search, watch, like, comment
 */

const { chromium } = require('playwright');
const { FingerprintGenerator } = require('fingerprint-generator');
const { FingerprintInjector } = require('fingerprint-injector');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const http = require('http');
const https = require('https');

class PlaywrightEngine {
  constructor(store, proxyManager, accountManager) {
    this.store = store;
    this.proxyManager = proxyManager || null;
    this.accountManager = accountManager || null;
    this.activeContexts = new Map();
    this.log = console.log;
  }

  setLogger(logFn) {
    this.log = logFn;
  }

  // Alias for backward compatibility with main.js
  setLogCallback(logFn) {
    this.log = logFn;
  }

  // ============================================================
  // PROXY HELPERS
  // ============================================================

  _parseProxy(proxyString) {
    if (!proxyString) return null;
    try {
      // Formats: ip:port, ip:port:user:pass, user:pass@ip:port, protocol://user:pass@ip:port
      let str = proxyString.trim();
      let protocol = 'http';
      if (str.startsWith('http://') || str.startsWith('https://') || str.startsWith('socks5://')) {
        const idx = str.indexOf('://');
        protocol = str.substring(0, idx);
        str = str.substring(idx + 3);
      }
      let username, password, server;
      if (str.includes('@')) {
        const [auth, host] = str.split('@');
        [username, password] = auth.split(':');
        server = `${protocol}://${host}`;
      } else {
        const parts = str.split(':');
        if (parts.length === 4) {
          server = `${protocol}://${parts[0]}:${parts[1]}`;
          username = parts[2];
          password = parts[3];
        } else if (parts.length === 2) {
          server = `${protocol}://${parts[0]}:${parts[1]}`;
        } else {
          server = `${protocol}://${str}`;
        }
      }
      const proxy = { server };
      if (username) proxy.username = username;
      if (password) proxy.password = password;
      return proxy;
    } catch (e) {
      this.log(`[Proxy] Parse error: ${e.message}`);
      return null;
    }
  }

  _buildProxyUrl(proxyData) {
    if (!proxyData) return null;
    try {
      const { host, port, username, password, protocol } = proxyData;
      const proto = protocol || 'http';
      if (username && password) {
        const u = encodeURIComponent(username);
        const p = encodeURIComponent(password);
        return `${proto}://${u}:${p}@${host}:${port}`;
      }
      return `${proto}://${host}:${port}`;
    } catch (e) {
      return null;
    }
  }

  // ============================================================
  // BROWSER LAUNCH
  // ============================================================

  /**
   * Finds real Chrome/Chromium executable on the system.
   * Playwright's bundled Chromium has NO proprietary codecs (H.264, AAC)
   * and NO Widevine DRM → VK Video literally cannot play.
   * We MUST use the real Chrome with `channel: 'chrome'` or `executablePath`.
   */
  _findChromeExecutable() {
    const candidates = process.platform === 'win32'
      ? [
          process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['PROGRAMFILES'] + '\\Chromium\\Application\\chrome.exe',
          // Edge as fallback (also has codecs)
          process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
          process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : [
          // Linux
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
          '/usr/bin/microsoft-edge',
          '/usr/bin/microsoft-edge-stable',
        ];

    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          this.log(`[Engine] Found Chrome: ${p}`);
          return p;
        }
      } catch (e) {}
    }
    return null;
  }

  async _launchContext(options = {}) {
    const settings = this.store.get('settings') || {};
    const headless = options.headless !== undefined ? options.headless : (settings.headless !== undefined ? settings.headless : false);
    const stealth = settings.stealth !== undefined ? settings.stealth : true;
    
    // ── Generate fingerprint ──
    let fingerprint = null;
    let fingerprintData = null;
    try {
      const generator = new FingerprintGenerator();
      fingerprint = generator.getFingerprint({
        browsers: ['chrome'],
        operatingSystems: ['windows'],
        devices: ['desktop'],
        locales: ['ru-RU', 'ru'],
      });
      fingerprintData = fingerprint.fingerprint;
      this.log(`[Engine] Generated fingerprint: ${fingerprintData.navigator?.userAgent?.substring(0, 60)}...`);
    } catch (e) {
      this.log(`[Engine] Fingerprint generation failed: ${e.message}`);
    }

    const launchOpts = {
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--window-size=1920,1080',
        '--lang=ru-RU',
        // ── Media / Video playback ──
        '--autoplay-policy=no-user-gesture-required',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
      ],
    };

    // ── Use REAL Chrome (with codecs + DRM) instead of Playwright Chromium ──
    // Playwright Chromium = no H.264, no AAC, no Widevine → VK Video won't play
    const chromeExe = this._findChromeExecutable();
    if (chromeExe) {
      launchOpts.executablePath = chromeExe;
      this.log(`[Engine] Using real Chrome: ${chromeExe}`);
    } else {
      // Fallback: try channel:'chrome' (Playwright auto-finds Chrome)
      launchOpts.channel = 'chrome';
      this.log('[Engine] Using channel:chrome (Playwright will find Chrome)');
    }

    if (options.proxy) {
      launchOpts.proxy = typeof options.proxy === 'string' 
        ? this._parseProxy(options.proxy) 
        : options.proxy;
    }

    let browser;
    let usedFallbackChromium = false;

    try {
      // Try playwright-extra with stealth if available and enabled
      if (stealth) {
        try {
          const { chromium: stealthChromium } = require('playwright-extra');
          const StealthPlugin = require('puppeteer-extra-plugin-stealth');
          stealthChromium.use(StealthPlugin());
          browser = await stealthChromium.launch(launchOpts);
          this.log('[Engine] Launched real Chrome + stealth plugin');
        } catch (e) {
          this.log(`[Engine] Stealth launch failed: ${e.message}`);
          try {
            browser = await chromium.launch(launchOpts);
            this.log('[Engine] Launched real Chrome (plain)');
          } catch (e2) {
            // If real Chrome fails, fall back to Playwright Chromium
            this.log(`[Engine] Real Chrome failed: ${e2.message}`);
            delete launchOpts.executablePath;
            delete launchOpts.channel;
            browser = await chromium.launch(launchOpts);
            usedFallbackChromium = true;
            this.log('[Engine] ⚠️ Fell back to Playwright Chromium (NO video codecs!)');
          }
        }
      } else {
        try {
          browser = await chromium.launch(launchOpts);
          this.log('[Engine] Launched real Chrome (plain)');
        } catch (e) {
          delete launchOpts.executablePath;
          delete launchOpts.channel;
          browser = await chromium.launch(launchOpts);
          usedFallbackChromium = true;
          this.log('[Engine] ⚠️ Fell back to Playwright Chromium (NO video codecs!)');
        }
      }
    } catch (e) {
      delete launchOpts.executablePath;
      delete launchOpts.channel;
      browser = await chromium.launch(launchOpts);
      usedFallbackChromium = true;
      this.log('[Engine] ⚠️ Last resort: Playwright Chromium (NO video codecs!)');
    }

    if (usedFallbackChromium) {
      this.log('[Engine] ⚠️ WARNING: Videos will NOT play without real Chrome!');
      this.log('[Engine] ⚠️ Install Google Chrome: https://www.google.com/chrome/');
    }

    // ── Build context options ──
    const contextOpts = {
      viewport: { width: 1920, height: 1080 },
      locale: 'ru-RU',
      // Use fingerprint UA or a current realistic one
      userAgent: fingerprintData?.navigator?.userAgent 
        || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      bypassCSP: true,
    };

    // Load storage state natively — this restores cookies + localStorage in one step
    if (options.storageStatePath) {
      try {
        if (fs.existsSync(options.storageStatePath)) {
          contextOpts.storageState = options.storageStatePath;
          this.log(`[Engine] Loading storage state from ${path.basename(options.storageStatePath)}`);
        }
      } catch (e) {
        this.log(`[Engine] Failed to set storage state: ${e.message}`);
      }
    }

    const context = await browser.newContext(contextOpts);

    // ── Inject fingerprint into context ──
    if (fingerprint) {
      try {
        const injector = new FingerprintInjector();
        await injector.attachFingerprintToPlaywright(context, fingerprint);
        this.log('[Engine] Fingerprint injected into context');
      } catch (e) {
        this.log(`[Engine] Fingerprint injection failed: ${e.message}`);
      }
    }

    // ── Block known tracking/error endpoints that cause console noise ──
    // These are VK analytics/monitoring — they fail with CORS but don't affect functionality
    try {
      await context.route('**/stats.vk-portal.net/**', route => route.abort());
      await context.route('**/sentry.mvk.com/**', route => route.abort());
      await context.route('**/top-fwz1.mail.ru/**', route => route.abort());
      await context.route('**/akashi.vk-portal.net/**', route => route.abort());
    } catch (e) {
      this.log(`[Engine] Route blocking failed: ${e.message}`);
    }

    const contextId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    this.activeContexts.set(contextId, { browser, context });

    return { browser, context, contextId };
  }

  async _safeClose(contextId) {
    try {
      const entry = this.activeContexts.get(contextId);
      if (entry) {
        try { await entry.context.close(); } catch (e) {}
        try { await entry.browser.close(); } catch (e) {}
        this.activeContexts.delete(contextId);
      }
    } catch (e) {
      this.log(`[Engine] Safe close error: ${e.message}`);
    }
  }

  // ============================================================
  // RANDOM HELPERS
  // ============================================================

  _randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async _humanDelay(minMs = 500, maxMs = 2000) {
    const delay = this._randomDelay(minMs, maxMs);
    await new Promise(r => setTimeout(r, delay));
  }

  /**
   * Safe page navigation that NEVER throws on timeout.
   * VK SPA pages often never fire 'load' because analytics/tracking resources
   * hang forever (stats.vk-portal.net, top-fwz1.mail.ru, etc.).
   * 
   * Uses 'domcontentloaded' instead of 'load', catches timeout gracefully,
   * and checks if the page actually navigated.
   */
  async _safeGoto(page, url, opts = {}) {
    const timeout = opts.timeout || 30000;
    const label = opts.label || url;
    const startMs = Date.now();
    this.log(`[Nav] Navigating to ${label}...`);

    try {
      // domcontentloaded fires when HTML is parsed — don't wait for all resources
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      // If page actually navigated (URL changed), treat as partial success
      const currentUrl = page.url();
      if (currentUrl.includes(new URL(url).hostname) || currentUrl !== 'about:blank') {
        this.log(`[Nav] Partial load for ${label} (${elapsed}s) — page URL: ${currentUrl.substring(0, 80)}`);
      } else {
        this.log(`[Nav] Failed to navigate to ${label} after ${elapsed}s: ${e.message.substring(0, 100)}`);
        return false;
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    this.log(`[Nav] Loaded ${label} in ${elapsed}s`);
    return true;
  }

  /**
   * Waits for VK SPA to actually render (not just DOM loaded).
   * Without this, vk.com loads an empty shell and the bot starts clicking nothing.
   */
  async _waitForPageReady(page, timeout = 10000) {
    try {
      // Wait for any meaningful VK element to appear
      await page.waitForSelector(
        'button, a[href], input, [class*="vkc__"], [class*="TopNav"], #content, #page_body, form',
        { timeout, state: 'visible' }
      ).catch(() => {});
      
      // Extra wait for JS to hydrate
      await page.waitForFunction(() => {
        // Page is ready when there's at least some interactive content
        const buttons = document.querySelectorAll('button, a, input');
        const visible = Array.from(buttons).filter(el => el.offsetParent !== null);
        return visible.length > 2;
      }, { timeout: timeout }).catch(() => {});
      
      // Small extra breathing room
      await this._humanDelay(500, 1000);
    } catch (e) {
      // If waiting fails, just continue — page might be slow
      this.log(`[Engine] Page ready wait: ${e.message}`);
    }
  }

  async _humanType(page, selector, text) {
    const settings = this.store.get('settings') || {};
    const { min: typeMin, max: typeMax } = settings.typingDelay || { min: 50, max: 150 };
    
    const el = typeof selector === 'string' ? await page.$(selector) : selector;
    if (!el) return;
    
    await el.click();
    await this._humanDelay(100, 300);
    
    for (const char of text) {
      await el.type(char, { delay: this._randomDelay(typeMin, typeMax) });
    }
  }

  // ============================================================
  // PHONE NUMBER HELPERS
  // ============================================================

  _isPhoneNumber(login) {
    if (!login) return false;
    const digits = login.replace(/[\s\-\(\)\+]/g, '');
    // Russian phone: starts with 7, 8, or 9, length 10-11 digits
    if (/^\d{10,11}$/.test(digits)) return true;
    if (/^\+?\d{10,15}$/.test(login.replace(/[\s\-\(\)]/g, ''))) return true;
    return false;
  }

  _normalizePhone(login) {
    // Remove all non-digit chars
    let digits = login.replace(/\D/g, '');
    // Remove leading country code: +7, 7, 8
    if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
      digits = digits.substring(1);
    }
    // Return 10-digit phone
    return digits;
  }

  // ============================================================
  // VK LOGIN - MAIN FLOW
  // ============================================================

  /**
   * Performs VK login following the modern id.vk.com auth flow:
   * 
   * 1. Open vk.com → click "Войти другим способом" / "Log in another way"
   * 2. Select phone/email radio → enter login
   * 3. Click "Продолжить" / "Continue" → redirects to id.vk.com/auth
   * 4. OTP/SMS page → click "Подтвердить другим способом" / "Confirm using other method"
   * 5. Popup "Выберите способ подтверждения" → click "Пароль" / "Password" option
   * 6. Password field appears → enter password → click "Продолжить"
   * 7. Handle captcha/2FA if needed
   * 8. Verify logged in
   * 
   * Based on Python reference (vk_login_captcha.py) patterns.
   */
  async loginVK(page, login, password) {
    this.log(`[VK Login] Starting login for ${login.substring(0, 4)}***`);

    try {
      // ── Step 1: Navigate to vk.com ──
      this.log('[VK Login] Step 1: Navigating to vk.com...');
      await this._safeGoto(page, 'https://vk.com/', { label: 'vk.com main', timeout: 25000 });
      // Wait for VK SPA to render — without this the page "drifts" and bot clicks on nothing
      await this._waitForPageReady(page);
      await this._humanDelay(2000, 3000);

      // ── Step 1a: Handle robot challenge on initial load ──
      await this._handleRobotChallenge(page);

      // ── Step 2: Click "Войти другим способом" / "Log in another way" ──
      // From Python ref: buttons with text variants for both Russian and English
      this.log('[VK Login] Step 2: Looking for "Войти другим способом"...');
      let foundAltLogin = false;

      // Approach 1: evaluate (matches Python reference pattern)
      try {
        foundAltLogin = await page.evaluate(() => {
          const variants = [
            'войти другим способом', 'другие способы входа',
            'log in another way', 'sign in another way',
          ];
          const elements = document.querySelectorAll('button, a, span, div[role="button"]');
          for (const el of elements) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.length > 60 || text.length === 0) continue;
            if (el.offsetParent === null) continue;
            if (!['a', 'button', 'span', 'div'].includes(el.tagName.toLowerCase())) continue;
            if (variants.some(v => text.includes(v))) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.click();
              return true;
            }
          }
          return false;
        });
        if (foundAltLogin) {
          this.log('[VK Login] Clicked "Войти другим способом"');
          // Wait for page to settle after click — this prevents "drifting"
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          await this._humanDelay(2000, 3000);
        }
      } catch (e) {}

      // Approach 2: Playwright locators
      if (!foundAltLogin) {
        const altLoginSelectors = [
          'button:has-text("Войти другим способом")',
          'a:has-text("Войти другим способом")',
          'span:has-text("Войти другим способом")',
          '[data-testid="loginByPassword"]',
          'button:has-text("Other login methods")',
          'a:has-text("Log in another way")',
        ];
        for (const sel of altLoginSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 })) {
              await btn.click();
              foundAltLogin = true;
              this.log(`[VK Login] Clicked alt login via locator: ${sel}`);
              await this._humanDelay(2000, 3000);
              break;
            }
          } catch (e) {}
        }
      }

      // If still not found, go directly to id.vk.com
      if (!foundAltLogin) {
        this.log('[VK Login] Alt login not found, navigating to id.vk.com/auth...');
        await this._safeGoto(page, 'https://id.vk.com/auth', { label: 'id.vk.com/auth fallback', timeout: 25000 });
        await this._waitForPageReady(page);
        await this._humanDelay(2000, 3000);
      }

      // ── Step 2a: Robot challenge again ──
      await this._handleRobotChallenge(page);

      // ── Step 2b: "I'm not a robot" checkbox (may appear BEFORE login form — Python ref) ──
      await this._clickNotRobotCheckbox(page);

      // ── Step 3: Select phone or email radio button ──
      const isPhone = this._isPhoneNumber(login);
      this.log(`[VK Login] Step 3: Login type = ${isPhone ? 'phone' : 'email'}`);

      if (isPhone) {
        try {
          const phoneRadio = page.locator('input[type="radio"][value="phone"], label:has-text("Телефон"), label:has-text("Phone")').first();
          if (await phoneRadio.isVisible({ timeout: 2000 })) {
            await phoneRadio.click();
            this.log('[VK Login] Selected phone radio');
            await this._humanDelay(500, 1000);
          }
        } catch (e) {}
      } else {
        try {
          const emailLabels = [
            'label:has-text("Почта")',
            'label:has-text("Email")',
            'input[type="radio"][value="email"]',
            'label:has-text("E-mail")',
          ];
          for (const sel of emailLabels) {
            try {
              const radio = page.locator(sel).first();
              if (await radio.isVisible({ timeout: 1500 })) {
                await radio.click();
                this.log('[VK Login] Selected email radio');
                await this._humanDelay(500, 1000);
                break;
              }
            } catch (e) {}
          }
        } catch (e) {}
      }

      // ── Step 4: Enter login into the input field ──
      // Python ref: email_selectors with VK-specific class names
      this.log('[VK Login] Step 4: Entering login...');
      
      const loginInputSelectors = [
        'input[name="login"]',
        'input[type="tel"]',
        'input[type="email"]',
        'input[name="username"]',
        'input#index_email',
        'input.vkc__TextField__input',
        'input[placeholder*="Телефон"]',
        'input[placeholder*="логин"]',
        'input[placeholder*="телефон"]',
        'input[placeholder*="email"]',
        'input[autocomplete="username"]',
      ];

      let loginInput = null;
      for (const sel of loginInputSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 })) {
            loginInput = el;
            this.log(`[VK Login] Found login input: ${sel}`);
            break;
          }
        } catch (e) {}
      }

      if (!loginInput) {
        this.log('[VK Login] ERROR: Login input not found');
        return { success: false, error: 'no_login_field' };
      }

      // Clear the field (it may have +7 pre-filled for phone)
      await loginInput.click();
      await this._humanDelay(200, 400);
      await loginInput.click({ clickCount: 3 });
      await this._humanDelay(100, 200);
      await page.keyboard.press('Backspace');
      await this._humanDelay(200, 400);
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await this._humanDelay(200, 400);

      // Type the login value
      let loginValue;
      if (isPhone) {
        loginValue = this._normalizePhone(login);
        this.log(`[VK Login] Normalized phone: ${loginValue.substring(0, 3)}***`);
      } else {
        loginValue = login;
      }

      await this._humanType(page, loginInput, loginValue);
      await this._humanDelay(500, 1000);

      // ── Step 5: Click "Продолжить" / "Continue" / submit ──
      // Python ref: checks if password is already visible (1-step form vs 2-step)
      this.log('[VK Login] Step 5: Clicking submit...');

      let passwordAlreadyVisible = false;
      try {
        passwordAlreadyVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 500 });
      } catch (e) {}

      if (!passwordAlreadyVisible) {
        let submitted = false;

        // Python ref: VK-specific button container selectors
        const submitSelectors = [
          'div.vkc__AuthRoot__wrapper div.vkc__DefaultSkin__buttonContainer button',
          'div.vkc__DefaultSkin__buttonContainer button',
          'button[type="submit"]',
          'button.vkc__Button',
          'a.vkc__Button',
          'div.vkc__DefaultSkin__button button',
          '#root button[type="button"]',
          'div.vkc__AuthRoot__wrapper button',
        ];

        // Try with evaluate (Python ref pattern: check text + type)
        try {
          submitted = await page.evaluate((sels) => {
            const textVariants = ['продолжить', 'continue', 'далее', 'next', 'войти', 'sign in'];
            for (const sel of sels) {
              try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                  if (!el.offsetParent || el.disabled) continue;
                  const txt = (el.textContent || '').toLowerCase();
                  const txtInner = (el.innerText || '').toLowerCase();
                  const atype = el.getAttribute('type') || '';
                  const isVkc = sel.includes('vkc');
                  const match = textVariants.some(v => txt.includes(v) || txtInner.includes(v)) || atype === 'submit';
                  if (match || (isVkc && el.tagName === 'BUTTON')) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.click();
                    return true;
                  }
                }
              } catch (e) {}
            }
            return false;
          }, submitSelectors);
          if (submitted) this.log('[VK Login] Clicked submit (after login input)');
        } catch (e) {}

        if (!submitted) {
          // Locator fallback
          const locatorSels = [
            'button[type="submit"]',
            'button:has-text("Продолжить")',
            'button:has-text("Continue")',
            'button:has-text("Войти")',
            'button:has-text("Sign in")',
          ];
          for (const sel of locatorSels) {
            try {
              const btn = page.locator(sel).first();
              if (await btn.isVisible({ timeout: 1500 })) {
                const isDisabled = await btn.evaluate(el => 
                  el.disabled || el.classList.contains('vkuiButton__disabled') || el.getAttribute('aria-disabled') === 'true'
                );
                if (!isDisabled) {
                  await btn.click();
                  submitted = true;
                  this.log(`[VK Login] Clicked submit via locator: ${sel}`);
                  break;
                }
              }
            } catch (e) {}
          }
        }

        if (!submitted) {
          await page.keyboard.press('Enter');
          this.log('[VK Login] Pressed Enter as fallback submit');
        }

        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        await this._humanDelay(2500, 4000);
      }

      // ── Step 5a: Robot challenge after submit ──
      await this._handleRobotChallenge(page);

      // ── Step 5b: "I'm not a robot" checkbox (only if captcha appears after submit) ──
      await this._clickNotRobotCheckbox(page);

      // ── Step 6: Detect page state after login submit ──
      this.log('[VK Login] Step 6: Detecting page state...');

      // Check if we're already logged in
      if (await this._checkVKLogin(page)) {
        this.log('[VK Login] Already logged in after step 5!');
        const cookies = await page.context().cookies();
        return { success: true, cookies };
      }

      // Check for captcha BEFORE anything else
      const captchaSolved = await this._trySolveCaptchaOnPage(page);
      if (captchaSolved) {
        await this._humanDelay(2000, 3000);
        if (await this._checkVKLogin(page)) {
          const cookies = await page.context().cookies();
          return { success: true, cookies };
        }
      }

      // Check for blocked account (Python ref: is_account_blocked)
      const isBlocked = await page.evaluate(() => {
        const url = (window.location.href || '').toLowerCase();
        const body = (document.body?.innerText || '').toLowerCase();
        return url.includes('blocked') || body.includes('заблокирован') || body.includes('profile was blocked');
      }).catch(() => false);

      if (isBlocked) {
        this.log('[VK Login] Account is BLOCKED');
        return { success: false, error: 'blocked' };
      }

      // Check for wrong password (Python ref: is_password_incorrect)
      const isWrongPwd = await page.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes('неверный пароль') || body.includes('incorrect password') || 
               body.includes('wrong password') || body.includes('неверный логин') ||
               (body.includes('неверн') && body.includes('парол'));
      }).catch(() => false);

      if (isWrongPwd) {
        this.log('[VK Login] Wrong password detected');
        return { success: false, error: 'wrong_password' };
      }

      // ── Step 7: Handle OTP/SMS page → Password path ──
      // Python ref: click_sms_bypass() → "Confirm using other method" → "Password"
      this.log('[VK Login] Step 7: Looking for OTP bypass / password path...');

      let passwordFieldVisible = passwordAlreadyVisible || false;

      // First check if password field is already visible (email login may show it directly)
      if (!passwordFieldVisible) {
        try {
          passwordFieldVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 2000 });
        } catch (e) {}
      }

      if (!passwordFieldVisible) {
        // Python ref: click_sms_bypass — evaluate pattern to find "Confirm using other method"
        this.log('[VK Login] Looking for "Подтвердить другим способом"...');
        
        let clickedOtherMethod = false;
        
        // Evaluate approach (matches Python ref)
        try {
          clickedOtherMethod = await page.evaluate(() => {
            const texts = [
              'confirm using other', 'other method', 
              'подтвердить другим', 'другим способом',
            ];
            const els = document.querySelectorAll('a, span, button, div[role="button"]');
            for (const el of els) {
              const t = (el.textContent || '').trim().toLowerCase();
              if (!t || t.length > 60) continue;
              if (el.offsetParent === null) continue;
              if (texts.some(v => t.includes(v))) {
                try { el.click(); } catch (e) {}
                return true;
              }
            }
            return false;
          });
          if (clickedOtherMethod) {
            this.log('[VK Login] Clicked "Подтвердить другим способом"');
            await this._humanDelay(2000, 3000);
          }
        } catch (e) {}

        // Locator fallback
        if (!clickedOtherMethod) {
          const otherMethodTexts = [
            'подтвердить другим способом',
            'confirm using other',
            'другим способом',
            'other method',
          ];
          for (const text of otherMethodTexts) {
            try {
              const btn = page.locator(`button:has-text("${text}"), a:has-text("${text}"), span:has-text("${text}")`).first();
              if (await btn.isVisible({ timeout: 1500 })) {
                await btn.click();
                clickedOtherMethod = true;
                this.log(`[VK Login] Clicked "${text}"`);
                await this._humanDelay(2000, 3000);
                break;
              }
            } catch (e) {}
          }
        }

        if (!clickedOtherMethod) {
          // No OTP bypass found — check if SMS-only account
          this.log('[VK Login] No OTP bypass found. Checking if SMS-only...');
          
          const hasOtpInputs = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"]');
            let otpCount = 0;
            for (const inp of inputs) {
              if (inp.maxLength === 1 || inp.getAttribute('autocomplete')?.includes('one-time')) otpCount++;
            }
            return otpCount >= 4;
          }).catch(() => false);

          if (hasOtpInputs) {
            this.log('[VK Login] SMS-only account detected (OTP inputs visible)');
            return { success: false, error: 'sms_only', message: 'Account requires SMS code, no password option available' };
          }
        }

        // ── Step 7a: Handle "Выберите способ подтверждения" popup ──
        // Python ref: click "Password" / "Enter your account password" in modal
        this.log('[VK Login] Step 7a: Looking for verification method popup...');
        
        // Python ref: 3 attempts to find password option in popup
        for (let popupAttempt = 0; popupAttempt < 3; popupAttempt++) {
          if (await this._selectPasswordInPopup(page)) break;
          await this._humanDelay(800, 1200);
        }
        
        await this._humanDelay(1500, 2500);

        // Check again if password field appeared
        try {
          passwordFieldVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 3000 });
        } catch (e) {}
      }

      // ── Step 8: Enter password ──
      // Python ref: pass_selectors with VK-specific classes
      if (!passwordFieldVisible) {
        const passwordSelectors = [
          'input[name="password"]',
          'input[type="password"]',
          'input#index_pass',
          'input.vkc__Password__input',
          'input[autocomplete="current-password"]',
          'input[placeholder*="Пароль"]',
          'input[placeholder*="пароль"]',
          'input[placeholder*="Password"]',
          'input[placeholder*="password"]',
        ];
        for (const sel of passwordSelectors) {
          try {
            const pwdField = page.locator(sel).first();
            if (await pwdField.isVisible({ timeout: 2000 })) {
              passwordFieldVisible = true;
              break;
            }
          } catch (e) {}
        }
      }

      if (!passwordFieldVisible) {
        this.log('[VK Login] ERROR: Password field not visible');
        const debugText = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button, a, input, h1, h2, h3, [role="button"]'))
            .filter(el => el.offsetParent !== null)
            .map(el => `${el.tagName}[${el.type || ''}]: "${(el.textContent || '').trim().substring(0, 60)}"`)
            .join('\n');
        }).catch(() => 'failed to get page elements');
        this.log(`[VK Login] Page elements:\n${debugText}`);
        return { success: false, error: 'no_password_field', url: page.url() };
      }

      this.log('[VK Login] Step 8: Entering password...');
      
      const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
      await passwordInput.click();
      await this._humanDelay(200, 400);
      await passwordInput.fill(''); // Clear field
      await this._humanType(page, passwordInput, password);
      await this._humanDelay(500, 1000);

      // ── Step 9: Click submit password ──
      // Python ref: btn_selectors + btn_text_variants for both RU and EN
      this.log('[VK Login] Step 9: Clicking submit password...');
      
      let clickedSubmit = false;
      
      // Python ref: use specific VK button selectors first
      const submitPasswordSelectors = [
        'button[type="submit"]',
        'button.vkc__Button__button--primary',
        'input[type="submit"]',
        '.vkAuthButton',
        '#install_allow',
        'button.vkc__Button',
      ];
      const btnTextVariants = ['продолжить', 'continue', 'войти', 'вход', 'login', 'sign in', 'enter'];

      // Wait up to 5 seconds for enabled button
      for (let attempt = 0; attempt < 10; attempt++) {
        // Try VK-specific selectors
        try {
          clickedSubmit = await page.evaluate(({ sels, texts }) => {
            for (const sel of sels) {
              try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                  if (el.offsetParent && !el.disabled && el.isConnected) {
                    el.click();
                    return true;
                  }
                }
              } catch (e) {}
            }
            // Fallback: search by text
            const btns = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
            for (const btn of btns) {
              const txt = (btn.textContent || btn.value || '').toLowerCase();
              const disabled = btn.disabled || btn.classList.contains('vkuiButton__disabled') || btn.classList.contains('vkuiButton--disabled');
              if (!disabled && btn.offsetParent && texts.some(v => txt.includes(v))) {
                btn.click();
                return true;
              }
            }
            return false;
          }, { sels: submitPasswordSelectors, texts: btnTextVariants });
          if (clickedSubmit) {
            this.log('[VK Login] Clicked password submit');
            break;
          }
        } catch (e) {}
        await this._humanDelay(400, 600);
      }

      if (!clickedSubmit) {
        await page.keyboard.press('Enter');
        this.log('[VK Login] Pressed Enter for password submit');
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await this._humanDelay(3000, 5000);

      // ── Step 10: Post-password checks (Python ref: captcha loop) ──
      this.log('[VK Login] Step 10: Post-password checks...');

      // Robot challenge / "Продолжить" clicks (Python ref: reduced attempts)
      for (let i = 0; i < 3; i++) {
        const hasRobot = await this._handleRobotChallenge(page);
        if (!hasRobot) break;
        await this._humanDelay(1500, 2500);
      }

      // ── Step 10a: Handle VK registration/confirmation popups ──
      // "Вы создаёте аккаунт ВКонтакте" / "Подтвердите" / extra confirmation screens
      await this._handlePostLoginPopups(page);

      // Try solve captcha if present (Python ref: max_captcha_attempts loop)
      const settings = this.store.get('settings') || {};
      const maxCaptchaAttempts = settings.maxCaptchaAttempts || 3;
      for (let captchaAttempt = 0; captchaAttempt < maxCaptchaAttempts; captchaAttempt++) {
        // Check blocked
        const blocked = await page.evaluate(() => {
          const url = (window.location.href || '').toLowerCase();
          const body = (document.body?.innerText || '').toLowerCase();
          return url.includes('blocked') || body.includes('заблокирован') || body.includes('blocked');
        }).catch(() => false);
        if (blocked) {
          this.log('[VK Login] Account blocked');
          return { success: false, error: 'blocked' };
        }

        // Check if already logged in
        if (await this._checkVKLogin(page)) break;
        
        // Check for wrong password
        const wrongPwd = await page.evaluate(() => {
          const body = (document.body?.innerText || '').toLowerCase();
          return body.includes('неверный пароль') || body.includes('incorrect password') || 
                 body.includes('wrong password') || (body.includes('неверн') && body.includes('парол'));
        }).catch(() => false);
        if (wrongPwd) {
          this.log('[VK Login] Wrong password');
          return { success: false, error: 'wrong_password' };
        }

        // Try solve captcha
        const solved = await this._trySolveCaptchaOnPage(page);
        if (solved) {
          await this._humanDelay(2000, 3000);
          continue;
        }

        // Try "Продолжить" / Turnstile
        await this._handleRobotChallenge(page);
        await this._humanDelay(1500, 2500);

        // Check login success
        const currentUrl = page.url().toLowerCase();
        if (!currentUrl.includes('login') || currentUrl.includes('feed')) break;
      }

      // Check for 2FA
      const has2FA = await page.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes('двухфакторн') || body.includes('two-factor') || body.includes('подтверждение входа') || body.includes('authenticator');
      }).catch(() => false);

      if (has2FA) {
        this.log('[VK Login] 2FA detected');
        return { success: false, error: '2fa_required' };
      }

      // ── Step 11: Verify login success (Python ref: final check) ──
      this.log('[VK Login] Step 11: Verifying login...');
      await this._humanDelay(2000, 3000);

      if (await this._checkVKLogin(page)) {
        this.log('[VK Login] ✅ Login successful!');
        const cookies = await page.context().cookies();
        return { success: true, cookies };
      }

      // Navigate to feed to double-check (Python ref: "feed" in current_url)
      try {
        await this._safeGoto(page, 'https://vk.com/feed', { label: 'VK feed (final verify)', timeout: 20000 });
        await this._humanDelay(2000, 3000);
        
        if (await this._checkVKLogin(page)) {
          this.log('[VK Login] ✅ Login successful (verified on /feed)!');
          const cookies = await page.context().cookies();
          return { success: true, cookies };
        }
      } catch (e) {}

      // Final blocked/password check
      const finalBlocked = await page.evaluate(() => {
        const url = (window.location.href || '').toLowerCase();
        const body = (document.body?.innerText || '').toLowerCase();
        return url.includes('blocked') || body.includes('заблокирован');
      }).catch(() => false);
      if (finalBlocked) return { success: false, error: 'blocked' };

      const finalWrongPwd = await page.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes('неверный пароль') || body.includes('incorrect password');
      }).catch(() => false);
      if (finalWrongPwd) return { success: false, error: 'wrong_password' };

      this.log('[VK Login] ❌ Login failed - could not verify');
      return { success: false, error: 'login_failed', url: page.url() };

    } catch (error) {
      this.log(`[VK Login] Exception: ${error.message}`);
      return { success: false, error: 'exception', message: error.message };
    }
  }

  // ============================================================
  // POPUP & CHALLENGE HANDLERS
  // ============================================================

  /**
   * Handles the "Выберите способ подтверждения" popup.
   * Clicks [data-test-id="verificationMethod_password"] or falls back to text search.
   */
  async _selectPasswordInPopup(page) {
    this.log('[VK Login] Looking for password option in popup...');

    // Primary: data-test-id (from codegen)
    try {
      const pwdMethod = page.locator('[data-test-id="verificationMethod_password"]');
      if (await pwdMethod.isVisible({ timeout: 3000 })) {
        await pwdMethod.click();
        this.log('[VK Login] Clicked [data-test-id="verificationMethod_password"]');
        await this._humanDelay(1500, 2500);
        return true;
      }
    } catch (e) {}

    // Fallback: text-based search in modal/popup
    try {
      const clicked = await page.evaluate(() => {
        const passwordTexts = ['пароль', 'password', 'по паролю', 'account password'];
        const excludeTexts = ['подтвердить', 'другим', 'confirm', 'other', 'введите пароль'];
        
        const containers = document.querySelectorAll(
          '[role="dialog"], [class*="modal"], [class*="popup"], [class*="bottomSheet"], [class*="ActionSheet"], [class*="sheet"]'
        );
        const searchIn = containers.length > 0 ? containers : [document.body];
        
        for (const container of searchIn) {
          const elements = container.querySelectorAll('div, span, a, button, li, [role="button"], [role="option"]');
          for (const el of elements) {
            if (el.offsetParent === null) continue;
            const text = (el.textContent || '').toLowerCase().trim();
            if (text.length > 60 || text.length === 0) continue;
            if (el.children.length > 10) continue;
            
            const hasPassword = passwordTexts.some(p => text.includes(p));
            if (!hasPassword) continue;
            const hasExclude = excludeTexts.some(e => text.includes(e));
            if (hasExclude) continue;
            
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
            return text.substring(0, 50);
          }
        }
        return null;
      });
      
      if (clicked) {
        this.log(`[VK Login] Clicked password option: "${clicked}"`);
        await this._humanDelay(1500, 2500);
        return true;
      }
    } catch (e) {}

    this.log('[VK Login] Could not find password option in popup');
    return false;
  }

  /**
   * Handles post-login popups: VK may show "Продолжить" multiple times
   * (account creation, welcome, cookie consent, etc.)
   * 
   * From codegen recording:
   *   await page.getByRole('button', { name: 'Продолжить' }).click();  // x3
   * 
   * Runs up to 5 passes to handle chained popups.
   */
  async _handlePostLoginPopups(page) {
    for (let pass = 0; pass < 5; pass++) {
      if (await this._checkVKLogin(page)) {
        this.log('[VK Login] Logged in, stopping popup handler');
        break;
      }

      let clicked = false;

      // Primary: "Продолжить" button by role (exactly what codegen recorded)
      try {
        const continueBtn = page.getByRole('button', { name: 'Продолжить' });
        if (await continueBtn.isVisible({ timeout: 2000 })) {
          await continueBtn.click();
          this.log(`[VK Login] Post-login popup: clicked "Продолжить" (pass ${pass + 1})`);
          clicked = true;
        }
      } catch (e) {}

      // Fallback: try other common popup buttons
      if (!clicked) {
        const popupResult = await page.evaluate(() => {
          const body = (document.body?.innerText || '').toLowerCase();
          const url = (window.location.href || '').toLowerCase();

          const isRegistration = body.includes('создаёте аккаунт') || body.includes('создаете аккаунт') ||
                                 body.includes('creating an account') || url.includes('join') || url.includes('register');

          if (isRegistration) {
            const cancelTexts = ['у меня уже есть', 'уже есть аккаунт', 'i already have', 'назад', 'back'];
            const btns = document.querySelectorAll('button, a, span, [role="button"]');
            for (const btn of btns) {
              const txt = (btn.textContent || '').toLowerCase().trim();
              if (txt.length > 60 || btn.offsetParent === null || btn.disabled) continue;
              if (cancelTexts.some(ct => txt.includes(ct))) { btn.click(); return 'cancel_registration'; }
            }
          }

          const confirmTexts = [
            'продолжить', 'continue', 'ок', 'ok', 'готово', 'done',
            'далее', 'next', 'принять', 'accept', 'разрешить', 'allow',
          ];
          const btns = document.querySelectorAll('button, a, [role="button"]');
          for (const btn of btns) {
            const txt = (btn.textContent || '').toLowerCase().trim();
            if (txt.length > 30 || btn.offsetParent === null || btn.disabled) continue;
            if (confirmTexts.some(ct => txt.includes(ct))) { btn.click(); return 'confirmed'; }
          }

          if (body.includes('cookie')) {
            for (const btn of btns) {
              const txt = (btn.textContent || '').toLowerCase().trim();
              if ((txt.includes('принять') || txt.includes('accept')) && btn.offsetParent !== null) {
                btn.click();
                return 'cookie_accepted';
              }
            }
          }

          return null;
        }).catch(() => null);

        if (popupResult) {
          this.log(`[VK Login] Post-login popup: ${popupResult} (pass ${pass + 1})`);
          clicked = true;
        }
      }

      if (!clicked) break;

      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await this._humanDelay(1500, 2500);
    }
  }

  /**
   * Handles robot challenge: "Проверяем, что вы не робот"
   * Returns true if a robot challenge was found and handled.
   */
  async _handleRobotChallenge(page) {
    const isChallenge = await page.evaluate(() => {
      const url = (window.location.href || '').toLowerCase();
      const body = (document.body?.innerText || '').toLowerCase();
      const hasChallenge = url.includes('challenge') || url.includes('captcha') || url.includes('not_robot');
      const hasRobotText = body.includes('проверяем, что вы не робот') || body.includes('checking that you are not a robot');
      return hasChallenge || hasRobotText;
    }).catch(() => false);

    if (!isChallenge) return false;

    this.log('[VK Login] Robot challenge detected');

    let clicked = false;
    try {
      clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const el of btns) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (text.length > 30) continue;
          if ((text.includes('продолжить') || text.includes('continue') || text.includes('начать') || text.includes('start'))
              && el.offsetParent !== null && !el.disabled) {
            el.click();
            return true;
          }
        }
        return false;
      });
    } catch (e) {}

    if (!clicked) {
      await this._clickNotRobotCheckbox(page);
    }

    if (!clicked) {
      try {
        for (const frame of page.frames()) {
          const frameUrl = frame.url().toLowerCase();
          if (!frameUrl.includes('turnstile') && !frameUrl.includes('challenge') && !frameUrl.includes('captcha')) continue;
          try {
            await frame.locator('button, [role="button"], input[type="submit"]').first().click({ timeout: 2000 });
            clicked = true;
            break;
          } catch (e) {}
        }
      } catch (e) {}
    }

    if (!clicked) {
      await this._trySolveCaptchaOnPage(page);
    }

    await this._humanDelay(2000, 3000);
    return true;
  }

  /**
   * Clicks "I'm not a robot" / "Я не робот" checkbox.
   * Only clicks robot-related checkboxes, never "remember me" / "save login".
   */
  async _clickNotRobotCheckbox(page) {
    try {
      const clicked = await page.evaluate(() => {
        const robotTexts = ['not a robot', 'не робот', 'i\'m not a robot', 'я не робот'];
        const excludeTexts = ['запомн', 'сохран', 'remember', 'save', 'keep', 'stay'];

        const labels = document.querySelectorAll('label, span, div, p');
        for (const el of labels) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (text.length > 80 || text.length === 0 || el.offsetParent === null) continue;
          if (!robotTexts.some(rt => text.includes(rt))) continue;
          if (excludeTexts.some(et => text.includes(et))) continue;

          const cb = el.querySelector('input[type="checkbox"], [role="checkbox"]')
            || el.closest('label')?.querySelector('input[type="checkbox"]');
          if (cb) { cb.click(); return true; }
          el.click();
          return true;
        }

        const containers = document.querySelectorAll('[class*="captcha"], [class*="challenge"], [class*="robot"]');
        for (const container of containers) {
          const cb = container.querySelector('input[type="checkbox"], [role="checkbox"]');
          if (cb && cb.offsetParent !== null) { cb.click(); return true; }
        }

        return false;
      }).catch(() => false);

      if (clicked) {
        this.log('[VK Login] Clicked not-a-robot checkbox');
        await this._humanDelay(1500, 2500);
        return true;
      }

      for (const frame of page.frames()) {
        const frameUrl = frame.url().toLowerCase();
        if (!frameUrl.includes('captcha') && !frameUrl.includes('recaptcha') &&
            !frameUrl.includes('challenge') && !frameUrl.includes('turnstile') &&
            !frameUrl.includes('hcaptcha') && !frameUrl.includes('anchor')) continue;
        try {
          const cb = frame.locator('[role="checkbox"], .rc-anchor-checkbox, .recaptcha-checkbox').first();
          if (await cb.isVisible({ timeout: 1000 })) {
            await cb.click();
            this.log('[VK Login] Clicked not-a-robot checkbox in iframe');
            await this._humanDelay(1500, 2500);
            return true;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }

  // ============================================================
  // VK LOGIN VERIFICATION
  // ============================================================

  async _checkVKLogin(page) {
    try {
      const url = page.url().toLowerCase();
      this.log(`[LoginCheck] URL: ${url.substring(0, 100)}`);
      
      // Negative: proxy error or blank page — not a VK response at all
      if (url.includes('chrome-error') || url === 'about:blank') {
        this.log('[LoginCheck] Negative: proxy/network error page');
        return false;
      }
      
      // Negative: obvious non-logged-in pages
      if ((url.includes('login') || url.includes('/auth')) && url.includes('id.vk.com')) {
        this.log('[LoginCheck] Negative: on VK login/auth page');
        return false;
      }
      
      // Positive URL checks
      const loggedInUrls = ['/feed', '/im', '/friends', '/groups', '/music', '/video', '/clips', '/market', '/discover'];
      const urlMatch = loggedInUrls.some(u => url.includes(u));
      
      // User profile page (vk.com/id12345)
      const isProfileUrl = /vk\.com\/id\d+/.test(url);
      
      // Extended DOM selectors — cover modern VK SPA, old VK, and vkvideo.ru
      const DOM_SELECTORS = [
        // Modern VK SPA (vkui-based)
        '[data-testid="header-profile-menu-button"]',
        '[data-testid="topnav_profile"]',
        // Avatar images (multiple classes used)
        'img[alt][class*="vkuiAvatar"]',
        'img[alt][class*="vkuiImageBase__img"]',
        'img.TopHomeLink__profileImg',
        // Navigation elements only visible when logged in
        'a[href*="/im"]',
        'a[href*="/friends"]',
        '[class*="TopNavBtn"]',
        '.TopNavLink',
        '#top_profile_link',
        '[class*="TopProfileLink"]',
        'header img[class*="Avatar"]',
        // Old VK selectors
        '#l_pr', '#l_msg', '#l_fr',
        // VKVideo (vkvideo.ru) specific
        '[class*="HeaderProfileButton"]',
        '[class*="header__profile"]',
        '[class*="UserBlock"]',
        // Generic logged-in indicators
        'a[href*="/settings"]',
        '[data-testid="header_left_messenger"]',
      ];

      // Check DOM for profile indicators
      let domLoggedIn = false;
      let domSelector = null;
      try {
        // First try Playwright's getByTestId which pierces shadow DOM
        for (const testId of ['header-profile-menu-button', 'topnav_profile']) {
          try {
            const el = page.getByTestId(testId);
            if (await el.isVisible({ timeout: 2000 })) {
              domLoggedIn = true;
              domSelector = `getByTestId("${testId}")`;
              break;
            }
          } catch (e) {}
        }
      } catch (e) {}

      // Then try page.evaluate for regular DOM selectors
      if (!domLoggedIn) {
        try {
          domSelector = await page.evaluate((sels) => {
            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (el) return sel;
            }
            // Also check: does the page have any cookie-dependent content?
            // If body text contains user-specific items
            const bodyText = (document.body?.innerText || '').substring(0, 2000);
            if (bodyText.includes('Моя страница') || bodyText.includes('Мои друзья') || bodyText.includes('Сообщения')) {
              return 'body-text-indicator';
            }
            return null;
          }, DOM_SELECTORS).catch(() => null);
          if (domSelector) domLoggedIn = true;
        } catch (e) {}
      }

      if (domLoggedIn) {
        this.log(`[LoginCheck] \u2705 Logged in (DOM: ${domSelector})`);
        return true;
      }
      
      if (isProfileUrl) {
        this.log('[LoginCheck] \u2705 On profile page');
        return true;
      }
      
      if (urlMatch) {
        // URL says feed/friends/etc but DOM doesn't have profile elements yet
        // Could be still loading — wait and retry with increasing timeouts
        this.log('[LoginCheck] URL matches logged-in page, DOM not ready. Waiting 4s...');
        await this._humanDelay(3000, 4000);
        
        // Retry with getByTestId first (pierces shadow DOM)
        try {
          const profileBtn = page.getByTestId('header-profile-menu-button');
          if (await profileBtn.isVisible({ timeout: 3000 })) {
            this.log(`[LoginCheck] \u2705 Logged in after retry (getByTestId)`);
            return true;
          }
        } catch (e) {}
        
        // Retry with DOM selectors
        try {
          const retry = await page.evaluate((sels) => {
            for (const sel of sels) {
              if (document.querySelector(sel)) return sel;
            }
            return null;
          }, DOM_SELECTORS).catch(() => null);
          if (retry) {
            this.log(`[LoginCheck] \u2705 Logged in after retry (DOM: ${retry})`);
            return true;
          }
        } catch (e) {}
        
        // Final fallback: trust URL if it's /feed and not a redirect to login
        if (url.includes('/feed') && !url.includes('login') && !url.includes('auth')) {
          // Check that the page actually has meaningful content (not an empty shell)
          const hasContent = await page.evaluate(() => {
            return (document.body?.innerText || '').trim().length > 100;
          }).catch(() => false);
          if (hasContent) {
            this.log('[LoginCheck] \u2705 Trusting URL-based check (/feed with content)');
            return true;
          }
        }
      }
      
      // Log extra diagnostics for debugging
      const pageTitle = await page.title().catch(() => '?');
      const bodyLen = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
      this.log(`[LoginCheck] \u274c Not logged in (URL match: ${urlMatch}, profile: ${isProfileUrl}, title: "${pageTitle.substring(0, 40)}", bodyLen: ${bodyLen})`);
      return false;
    } catch (e) {
      this.log(`[LoginCheck] Error: ${e.message}`);
      return false;
    }
  }

  // ============================================================
  // CAPTCHA SOLVING (ruCaptcha / 2captcha integration)
  // ============================================================

  /**
   * Tries to detect and solve captcha on the current page.
   * Supports: VK Procaptcha (kaleidoscope via CDPSession), standard image captcha, screenshot
   * Uses ruCaptcha API if key is configured.
   * 
   * Based on Python ref: get_captcha_input_and_solve which tries:
   * 1. VK Procaptcha (vkimage) via performance logs
   * 2. VK Captcha token (vkcaptcha) via redirect URI
   * 3. Normal text captcha (image + input)
   */
  async _trySolveCaptchaOnPage(page) {
    const settings = this.store.get('settings') || {};
    const apiKey = settings.ruCaptchaKey;
    
    if (!apiKey) {
      return false;
    }

    this.log('[Captcha] Checking for captcha on page...');

    try {
      // 1. Check for VK challenge page (Python ref: is_vk_challenge_page)
      const isChallenge = await page.evaluate(() => {
        const url = (window.location.href || '').toLowerCase();
        const body = (document.body?.innerText || '').toLowerCase();
        return url.includes('challenge') || body.includes('робот') || body.includes('robot');
      }).catch(() => false);

      // 2. Try to get VK Procaptcha from CDP performance logs (Python ref: get_vk_procaptcha_from_logs)
      // This intercepts the captchaNotRobot.getContent response for image + steps data
      let vkProcaptchaData = null;
      try {
        const cdpSession = await page.context().newCDPSession(page);
        await cdpSession.send('Network.enable');
        
        // Check existing responses for captcha data
        // Note: In Playwright we can check via page.route or existing responses
        // For now, use the screenshot approach as Playwright doesn't have direct perf log access
        await cdpSession.detach().catch(() => {});
      } catch (e) {
        // CDP may not be available in all contexts
      }

      // 3. Look for captcha image (Python ref: get_captcha_image_base64)
      const captchaInfo = await page.evaluate(() => {
        const imgSelectors = [
          'img[src*="captcha"]',
          'img[src*="captcha.php"]',
          'img[src*="api.vk.com/captcha"]',
          '.vk_captcha_img',
          '#captcha_img',
          '.captcha_img img',
          'img[alt*="капч"]',
          'img[alt*="captcha"]',
          'div.captcha_block img',
          'form img[src*="captcha"]',
        ];
        
        for (const sel of imgSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = el.naturalWidth || el.width;
              canvas.height = el.naturalHeight || el.height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(el, 0, 0);
              const dataUrl = canvas.toDataURL('image/png');
              return { type: 'image', data: dataUrl };
            } catch (e) {
              return { type: 'image', src: el.src };
            }
          }
        }
        
        // Check for slider (VK procaptcha kaleidoscope)
        const slider = document.querySelector('input[type="range"], .slider, [role="slider"]');
        if (slider) {
          return { type: 'slider' };
        }

        return null;
      }).catch(() => null);

      // 4. Check for redirect_uri for vkcaptcha (Python ref: get_vk_redirect_uri)
      let redirectUri = null;
      try {
        redirectUri = await page.evaluate(() => {
          const url = window.location.href || '';
          const urlLower = url.toLowerCase();
          if (urlLower.includes('not_robot') || urlLower.includes('not_robot_captcha')) return url;
          if (url.includes('session_token=') && (urlLower.includes('challenge') || urlLower.includes('captcha'))) return url;
          // Check iframes
          const iframes = document.querySelectorAll('iframe');
          for (const iframe of iframes) {
            const src = (iframe.getAttribute('src') || '').toLowerCase();
            if (src.includes('not_robot') || src.includes('session_token=')) return iframe.getAttribute('src');
          }
          return null;
        });
      } catch (e) {}

      if (!captchaInfo && !isChallenge && !redirectUri) {
        return false; // No captcha detected
      }

      this.log(`[Captcha] Detected: ${captchaInfo?.type || (redirectUri ? 'vkcaptcha' : 'challenge')}`);

      // 5. Solve based on type
      if (captchaInfo?.type === 'image' && captchaInfo.data) {
        return await this._solveImageCaptcha(page, captchaInfo.data, apiKey);
      }

      if (isChallenge || redirectUri) {
        return await this._solveScreenshotCaptcha(page, apiKey);
      }

      return false;
    } catch (error) {
      this.log(`[Captcha] Error: ${error.message}`);
      return false;
    }
  }

  /**
   * Solves standard image captcha via ruCaptcha API.
   * Based on Python ref: solver.normal(base64_img, lang="ru") + input field filling.
   */
  async _solveImageCaptcha(page, imageDataOrUrl, apiKey) {
    try {
      let base64Image;
      
      if (imageDataOrUrl.startsWith('data:image')) {
        base64Image = imageDataOrUrl.split('base64,')[1];
      } else if (imageDataOrUrl.startsWith('http')) {
        const buffer = await this._downloadImageAsBase64(imageDataOrUrl);
        if (!buffer) return false;
        base64Image = buffer;
      } else {
        base64Image = imageDataOrUrl;
      }

      this.log('[Captcha] Submitting image to ruCaptcha (normal)...');
      
      const taskId = await this._ruCaptchaSubmit({
        method: 'base64',
        body: base64Image,
        json: 1,
        key: apiKey,
        lang: 'ru',
      });

      if (!taskId) return false;

      const result = await this._ruCaptchaPoll(taskId, apiKey);
      if (!result) return false;

      this.log(`[Captcha] Solved: ${result.substring(0, 10)}...`);

      // Python ref: input_selectors for captcha answer field
      const entered = await page.evaluate((code) => {
        const inputSelectors = [
          'input[name="captcha_key"]',
          'input#captcha_key',
          'input[type="text"]',
          'input[placeholder*="капч"]',
          'input[placeholder*="captcha"]',
          'input#captcha',
          '.captcha_key',
          'input.vk_captcha_input',
          'form input[type="text"]',
        ];
        
        for (const sel of inputSelectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              if (el.type !== 'hidden' && el.offsetParent !== null) {
                el.value = '';
                el.value = code;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          } catch (e) {}
        }
        
        // Fallback from Python ref: captcha_key by name
        try {
          const byName = document.querySelector('input[name="captcha_key"]');
          if (byName) {
            byName.value = code;
            byName.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
        } catch (e) {}
        
        return false;
      }, result);

      if (!entered) {
        this.log('[Captcha] Could not find input field for captcha answer');
        return false;
      }

      // Python ref: click_robot_check_continue after entering captcha
      await this._humanDelay(500, 1000);
      
      const submitted = await page.evaluate(() => {
        const btns = document.querySelectorAll('button, input[type="submit"]');
        const texts = ['продолжить', 'continue', 'отправить', 'submit', 'проверить', 'verify'];
        for (const btn of btns) {
          const text = (btn.textContent || btn.value || '').toLowerCase();
          if (texts.some(t => text.includes(t)) && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }
        for (const btn of btns) {
          if (btn.type === 'submit' && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (!submitted) {
        await page.keyboard.press('Enter');
      }

      await this._humanDelay(2000, 3000);
      this.log('[Captcha] Image captcha submitted');
      return true;
    } catch (error) {
      this.log(`[Captcha] Image solve error: ${error.message}`);
      return false;
    }
  }

  /**
   * Solves captcha by taking a screenshot and sending to ruCaptcha.
   * Used for complex captchas like Turnstile, VK kaleidoscope.
   * Based on Python ref: apply_vk_captcha_token for token application.
   */
  async _solveScreenshotCaptcha(page, apiKey) {
    try {
      const screenshot = await page.screenshot({ type: 'png' });
      const base64Screenshot = screenshot.toString('base64');

      this.log('[Captcha] Submitting screenshot to ruCaptcha...');
      
      const taskId = await this._ruCaptchaSubmit({
        method: 'base64',
        body: base64Screenshot,
        json: 1,
        key: apiKey,
        lang: 'ru',
        textinstructions: 'Solve the captcha shown on the page. If there is a slider, return the position number.',
      });

      if (!taskId) return false;

      const result = await this._ruCaptchaPoll(taskId, apiKey);
      if (!result) return false;

      this.log(`[Captcha] Screenshot solved: ${result.substring(0, 20)}...`);

      // Python ref: apply_vk_captcha_token — try multiple application methods
      await page.evaluate((token) => {
        // Slider position (kaleidoscope)
        try {
          const slider = document.querySelector('input[type="range"]') || 
                         document.querySelector('.slider input') || 
                         document.querySelector('[role="slider"]');
          if (slider && !isNaN(parseInt(token))) {
            slider.value = parseInt(token);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } catch (e) {}

        // Hidden token inputs (Python ref: captcha_key, data-captcha-token)
        const tokenSelectors = [
          'input[name="captcha_key"]',
          'input#captcha_key',
          'input[data-captcha-token]',
          'input[type="hidden"][name*="captcha"]',
        ];
        for (const sel of tokenSelectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              el.value = token;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } catch (e) {}
        }

        // Window callbacks (Python ref)
        try {
          if (typeof window.onCaptchaSolved === 'function') window.onCaptchaSolved(token);
          if (typeof window.vkCaptchaCallback === 'function') window.vkCaptchaCallback(token);
        } catch (e) {}
      }, result);

      // Python ref: click_robot_check_continue after applying token
      await this._humanDelay(500, 1000);
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, *[role="button"]');
        const texts = ['продолжить', 'continue', 'начать', 'start'];
        for (const btn of btns) {
          const text = (btn.textContent || '').toLowerCase();
          if (texts.some(t => text.includes(t)) && btn.offsetParent !== null) {
            btn.scrollIntoView();
            btn.click();
            return true;
          }
        }
        return false;
      });

      await this._humanDelay(2000, 3000);
      return true;
    } catch (error) {
      this.log(`[Captcha] Screenshot solve error: ${error.message}`);
      return false;
    }
  }

  // ============================================================
  // ruCaptcha HTTP helpers
  // ============================================================

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  _httpGetBuffer(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  _httpPost(url, data) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const postData = typeof data === 'string' ? data : new URLSearchParams(data).toString();
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      };
      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async _downloadImageAsBase64(url) {
    try {
      const buffer = await this._httpGetBuffer(url);
      return buffer.toString('base64');
    } catch (e) {
      this.log(`[Captcha] Download image error: ${e.message}`);
      return null;
    }
  }

  async _ruCaptchaSubmit(params) {
    try {
      const response = await this._httpPost('https://rucaptcha.com/in.php', params);
      const json = JSON.parse(response);
      if (json.status === 1 && json.request) {
        this.log(`[Captcha] Task submitted: ${json.request}`);
        return json.request;
      }
      this.log(`[Captcha] Submit failed: ${response}`);
      return null;
    } catch (e) {
      this.log(`[Captcha] Submit error: ${e.message}`);
      return null;
    }
  }

  async _ruCaptchaPoll(taskId, apiKey, maxWaitSec = 120) {
    const pollInterval = 5000;
    const maxAttempts = Math.ceil((maxWaitSec * 1000) / pollInterval);
    
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval));
      
      try {
        const url = `https://rucaptcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
        const response = await this._httpGet(url);
        const json = JSON.parse(response);
        
        if (json.status === 1 && json.request) {
          return json.request;
        }
        
        if (json.request === 'CAPCHA_NOT_READY') {
          continue;
        }
        
        // Error
        this.log(`[Captcha] Poll error: ${json.request}`);
        return null;
      } catch (e) {
        this.log(`[Captcha] Poll error: ${e.message}`);
      }
    }
    
    this.log('[Captcha] Poll timeout');
    return null;
  }

  // ============================================================
  // COOKIE MANAGEMENT
  // ============================================================

  async _loadCookies(context, cookiesArray) {
    if (!cookiesArray || !cookiesArray.length) return false;
    try {
      // Fix cookies - ensure required fields
      const fixedCookies = cookiesArray.map(c => {
        const cookie = { ...c };
        if (!cookie.domain) cookie.domain = '.vk.com';
        if (!cookie.path) cookie.path = '/';
        // Remove problematic fields
        delete cookie.sameSite;
        delete cookie.sourceScheme;
        delete cookie.sourcePort;
        return cookie;
      }).filter(c => c.name && c.value);
      
      if (fixedCookies.length > 0) {
        await context.addCookies(fixedCookies);
        return true;
      }
    } catch (e) {
      this.log(`[Cookies] Load error: ${e.message}`);
    }
    return false;
  }

  // ============================================================
  // VERIFY COOKIES
  // ============================================================

  async verifyCookies(accountId, proxyId = null) {
    const accounts = this.store.get('accounts') || [];
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      return { valid: false, error: 'Account not found' };
    }

    const settings = this.store.get('settings') || {};
    let proxyUrl = null;
    
    if (proxyId) {
      const proxies = this.store.get('proxies') || [];
      const proxy = proxies.find(p => p.id === proxyId);
      if (proxy) proxyUrl = this._buildProxyUrl(proxy);
    }

    const cookiesDir = path.join(app.getPath('userData'), 'accounts');
    const statePath = path.join(cookiesDir, `${accountId}_state.json`);
    const cookiesPath = path.join(cookiesDir, `${accountId}_cookies.json`);

    let contextId = null;
    try {
      let isLoggedIn = false;

      if (account.authType === 'logpass') {
        this.log(`[Verify] Verifying logpass account: ${account.login?.substring(0, 4)}***`);
        
        // Step 1: Try saved session (fast path) — use native storageState
        let triedSession = false;
        
        if (account.hasCookies && fs.existsSync(statePath)) {
          // Launch context WITH storage state — Playwright restores cookies + localStorage natively
          const { context, contextId: cId } = await this._launchContext({ 
            proxy: proxyUrl,
            headless: settings.headless !== undefined ? settings.headless : false,
            storageStatePath: statePath,
          });
          contextId = cId;
          triedSession = true;

          const page = await context.newPage();
          await this._safeGoto(page, 'https://vk.com/feed', { label: 'VK feed (verify session)', timeout: 25000 });
          await this._waitForPageReady(page);
          await this._humanDelay(1000, 2000);
          isLoggedIn = await this._checkVKLogin(page);
          
          if (isLoggedIn) {
            this.log('[Verify] Session still valid');
          } else {
            this.log('[Verify] Session expired, closing context for fresh login...');
            await this._safeClose(contextId);
            contextId = null;
          }
        } else if (account.hasCookies && fs.existsSync(cookiesPath)) {
          // Fallback: load only cookies manually
          const { context, contextId: cId } = await this._launchContext({ 
            proxy: proxyUrl,
            headless: settings.headless !== undefined ? settings.headless : false,
          });
          contextId = cId;
          triedSession = true;
          
          try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            await this._loadCookies(context, cookies);
          } catch (e) {
            this.log(`[Verify] Failed to load cookies: ${e.message}`);
          }

          const page = await context.newPage();
          await this._safeGoto(page, 'https://vk.com/feed', { label: 'VK feed (verify cookies)', timeout: 25000 });
          await this._waitForPageReady(page);
          await this._humanDelay(1000, 2000);
          isLoggedIn = await this._checkVKLogin(page);
          
          if (!isLoggedIn) {
            this.log('[Verify] Cookies expired, closing for fresh login...');
            await this._safeClose(contextId);
            contextId = null;
          }
        }

        // Step 2: If session didn't work, do FULL LOGIN with credentials
        if (!isLoggedIn && account.login && account.password) {
          this.log('[Verify] Performing full login with credentials...');
          
          // Create a fresh context for login
          if (!contextId) {
            const { context: freshCtx, contextId: freshCId } = await this._launchContext({ 
              proxy: proxyUrl,
              headless: settings.headless !== undefined ? settings.headless : false,
            });
            contextId = freshCId;
          }
          
          const entry = this.activeContexts.get(contextId);
          const page = entry.context.pages()[0] || await entry.context.newPage();
          
          const loginResult = await this.loginVK(page, account.login, account.password);
          
          if (loginResult.success) {
            isLoggedIn = true;
            this.log('[Verify] Login successful, saving session...');
            await this._saveSession(entry.context, accountId);
          } else {
            this.log(`[Verify] Login failed: ${loginResult.error}`);
          }
        } else if (!isLoggedIn && (!account.login || !account.password)) {
          this.log('[Verify] No credentials available for login');
        }
      } else {
        // Cookie-based account — only check cookies, no login possible
        this.log(`[Verify] Verifying cookie account: ${accountId}`);
        
        if (!fs.existsSync(cookiesPath) && !fs.existsSync(statePath)) {
          return { valid: false, error: 'No session files found' };
        }

        // Use storageState if available, otherwise cookies
        const launchOpts = { 
          proxy: proxyUrl,
          headless: settings.headless !== undefined ? settings.headless : false,
        };
        if (fs.existsSync(statePath)) {
          launchOpts.storageStatePath = statePath;
        }

        const { context, contextId: cId } = await this._launchContext(launchOpts);
        contextId = cId;

        // If no storageState was used, load cookies manually
        if (!fs.existsSync(statePath) && fs.existsSync(cookiesPath)) {
          const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
          await this._loadCookies(context, cookies);
        }
        
        const page = await context.newPage();
        await this._safeGoto(page, 'https://vk.com/feed', { label: 'VK feed (verify cookie account)', timeout: 25000 });
        await this._waitForPageReady(page);
        await this._humanDelay(2000, 4000);
        isLoggedIn = await this._checkVKLogin(page);
      }

      // Update account status
      const latestAccounts = this.store.get('accounts') || [];
      const idx = latestAccounts.findIndex(a => a.id === accountId);
      if (idx !== -1) {
        latestAccounts[idx].status = isLoggedIn ? 'valid' : 'invalid';
        latestAccounts[idx].hasCookies = isLoggedIn ? true : latestAccounts[idx].hasCookies;
        latestAccounts[idx].lastVerified = new Date().toISOString();
        if (!isLoggedIn && account.authType === 'logpass') {
          latestAccounts[idx].statusDetail = 'Login failed or credentials invalid';
        } else if (isLoggedIn) {
          latestAccounts[idx].statusDetail = 'Account verified and session saved';
        }
        this.store.set('accounts', latestAccounts);
      }

      await this._safeClose(contextId);
      return { valid: isLoggedIn, details: isLoggedIn ? 'Account verified and session saved' : 'Login failed' };
      
    } catch (error) {
      this.log(`[Verify] Error: ${error.message}`);
      if (contextId) await this._safeClose(contextId);
      
      const latestAccounts = this.store.get('accounts') || [];
      const idx = latestAccounts.findIndex(a => a.id === accountId);
      if (idx !== -1) {
        latestAccounts[idx].status = 'invalid';
        latestAccounts[idx].lastVerified = new Date().toISOString();
        latestAccounts[idx].statusDetail = `Error: ${error.message}`;
        this.store.set('accounts', latestAccounts);
      }
      
      return { valid: false, error: error.message };
    }
  }

  // ============================================================
  // WARM-UP BROWSING
  // ============================================================

  async warmUpBrowsing(page) {
    const settings = this.store.get('settings') || {};
    const warmUp = settings.warmUp || {};
    
    const scenarios = ['chill', 'curious', 'explorer', 'searcher', 'impatient'];
    const weights = {
      chill: warmUp.scenarioWeight?.chill || 30,
      curious: warmUp.scenarioWeight?.curious || 25,
      explorer: warmUp.scenarioWeight?.explorer || 20,
      searcher: warmUp.scenarioWeight?.searcher || 15,
      impatient: warmUp.scenarioWeight?.impatient || 10,
    };

    // Weighted random selection
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    let scenario = 'chill';
    for (const [name, weight] of Object.entries(weights)) {
      random -= weight;
      if (random <= 0) {
        scenario = name;
        break;
      }
    }

    this.log(`[WarmUp] Scenario: ${scenario}`);

    try {
      const pageAlive = () => !page.isClosed();

      switch (scenario) {
        case 'chill': {
          // Just browse the feed
          if (!pageAlive()) return;
          await this._safeGoto(page, 'https://vk.com/feed', { label: 'warmup:chill', timeout: 20000 });
          const scrollCount = this._randomDelay(warmUp.homePageMin || 3, warmUp.homePageMax || 8);
          for (let i = 0; i < scrollCount; i++) {
            if (!pageAlive()) return;
            await page.mouse.wheel(0, this._randomDelay(200, 600));
            await this._humanDelay(
              (warmUp.scrollPauseMin || 1.5) * 1000,
              (warmUp.scrollPauseMax || 5) * 1000
            );
          }
          break;
        }

        case 'curious': {
          // Browse feed, click on a video/post
          if (!pageAlive()) return;
          await this._safeGoto(page, 'https://vk.com/feed', { label: 'warmup:curious', timeout: 20000 });
          await this._humanDelay(2000, 4000);
          // Scroll a bit
          for (let i = 0; i < 3; i++) {
            if (!pageAlive()) return;
            await page.mouse.wheel(0, this._randomDelay(200, 400));
            await this._humanDelay(1000, 2000);
          }
          // Try to click a video link
          try {
            const videoLink = page.locator('a[href*="/video"], a[href*="/clip"]').first();
            if (await videoLink.isVisible({ timeout: 3000 })) {
              await videoLink.click();
              await this._humanDelay(
                (warmUp.videoWatchMin || 5) * 1000,
                (warmUp.videoWatchMax || 25) * 1000
              );
            }
          } catch (e) {}
          break;
        }

        case 'explorer': {
          // Visit random VK sections
          const destinations = ['https://vkvideo.ru', 'https://vk.com/clips', 'https://vk.com/discover'];
          const dest = destinations[Math.floor(Math.random() * destinations.length)];
          if (!pageAlive()) return;
          await this._safeGoto(page, dest, { label: `warmup:explorer → ${dest}`, timeout: 20000 });
          await this._humanDelay(2000, 4000);
          const scrolls = this._randomDelay(2, 5);
          for (let i = 0; i < scrolls; i++) {
            if (!pageAlive()) return;
            await page.mouse.wheel(0, this._randomDelay(200, 500));
            await this._humanDelay(1500, 3000);
          }
          break;
        }

        case 'searcher': {
          // Search for something on vkvideo.ru
          const queries = ['музыка 2025', 'смешные видео', 'новости', 'рецепты', 'фильмы', 'мемы'];
          const query = queries[Math.floor(Math.random() * queries.length)];
          if (!pageAlive()) return;
          await this._safeGoto(page, 'https://vkvideo.ru', { label: 'warmup:searcher', timeout: 20000 });
          await this._humanDelay(1000, 2000);
          try {
            const searchInput = page.locator('input[type="search"], input[placeholder*="Поиск"], input[name="q"]').first();
            if (await searchInput.isVisible({ timeout: 3000 })) {
              await this._humanType(page, searchInput, query);
              await page.keyboard.press('Enter');
              await this._humanDelay(2000, 4000);
              for (let i = 0; i < this._randomDelay(1, 3); i++) {
                if (!pageAlive()) return;
                await page.mouse.wheel(0, this._randomDelay(200, 400));
                await this._humanDelay(1000, 2000);
              }
            }
          } catch (e) {}
          break;
        }

        case 'impatient': {
          // Quick browse, leave fast
          if (!pageAlive()) return;
          await this._safeGoto(page, 'https://vk.com/feed', { label: 'warmup:impatient', timeout: 15000 });
          await this._humanDelay(1000, 3000);
          await page.mouse.wheel(0, 300);
          await this._humanDelay(500, 1500);
          break;
        }
      }
    } catch (error) {
      this.log(`[WarmUp] Error in scenario ${scenario}: ${error.message}`);
    }
  }

  // ============================================================
  // VIDEO SEARCH & ENGAGEMENT
  // ============================================================

  async searchAndFindVideo(page, keywords, targetUrl, maxScrolls = 0) {
    this.log(`[Search] Searching for video: keywords="${keywords || 'none'}", target=${targetUrl || 'none'}, maxScrolls=${maxScrolls || 'unlimited'}`);
    
    // Extract video ID from target URL for matching (e.g., "video-224119603_456311034")
    let targetVideoId = null;
    if (targetUrl) {
      const match = targetUrl.match(/(video-?\d+_\d+)/);
      if (match) targetVideoId = match[1];
      this.log(`[Search] Target video ID: ${targetVideoId || 'could not parse'}`);
    }
    
    try {
      // ── Navigate to VKVideo (vkvideo.ru is the current VK video domain) ──
      const searchUrl = 'https://vkvideo.ru';
      const navOk = await this._safeGoto(page, searchUrl, { label: 'VKVideo search page', timeout: 30000 });
      if (!navOk) {
        this.log('[Search] vkvideo.ru failed, trying vk.com/video...');
        await this._safeGoto(page, 'https://vk.com/video', { label: 'VK Video fallback', timeout: 30000 });
      }
      await this._waitForPageReady(page);
      await this._humanDelay(2000, 3000);

      if (keywords) {
        this.log(`[Search] Looking for search input on ${page.url().substring(0, 50)}...`);

        // Primary: use data-testid from codegen recording
        let searchInput = null;
        try {
          const testIdInput = page.getByTestId('top-search-video-input');
          if (await testIdInput.isVisible({ timeout: 3000 })) {
            searchInput = testIdInput;
            this.log('[Search] Found search input via data-testid="top-search-video-input"');
          }
        } catch (e) {}

        // Fallback: generic search selectors
        if (!searchInput) {
          const searchSelectors = [
            'input[type="search"]',
            'input[placeholder*="\u041f\u043e\u0438\u0441\u043a"]',
            'input[placeholder*="Search"]',
            'input[name="q"]',
            'input[class*="search"]',
          ];
          for (const sel of searchSelectors) {
            try {
              const el = page.locator(sel).first();
              if (await el.isVisible({ timeout: 2000 })) {
                searchInput = el;
                this.log(`[Search] Found search input: ${sel}`);
                break;
              }
            } catch (e) {}
          }
        }

        if (searchInput) {
          await searchInput.click();
          await this._humanDelay(300, 600);
          await searchInput.fill(keywords);
          await this._humanDelay(300, 600);
          await searchInput.press('Enter');
          this.log(`[Search] Submitted search: "${keywords.substring(0, 50)}"`);
          
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
          await this._humanDelay(3000, 5000);

          this.log(`[Search] Results page: ${page.url().substring(0, 80)}`);

          // ── Scroll-and-search loop ──
          // maxScrolls=0 means infinite scrolling until found or no more results
          const scrollLimit = maxScrolls > 0 ? maxScrolls : 200; // safety cap at 200
          let scrollsDone = 0;
          let prevLinkCount = 0;
          let noNewLinksCount = 0;
          
          if (targetVideoId) {
            const idParts = targetVideoId.match(/(-?\d+_\d+)/);
            const numericId = idParts ? idParts[1] : targetVideoId;
            this.log(`[Search] Will scroll and scan for: "${targetVideoId}" (numeric: "${numericId}")`);
            
            for (scrollsDone = 0; scrollsDone < scrollLimit; scrollsDone++) {
              // Check for video in current results
              const found = await page.evaluate(({ videoId, numId }) => {
                const links = document.querySelectorAll('a[href]');
                const videoLinks = [];
                for (const link of links) {
                  const href = link.href || link.getAttribute('href') || '';
                  if (href.includes('video') || href.includes(numId)) {
                    videoLinks.push({ el: link, href });
                  }
                }
                for (const { el, href } of videoLinks) {
                  if (href.includes(videoId) || href.includes(numId)) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.click();
                    return { found: true, href, total: videoLinks.length, method: 'exact' };
                  }
                }
                return { found: false, total: videoLinks.length, sample: videoLinks.slice(0, 5).map(v => v.href.substring(0, 80)) };
              }, { videoId: targetVideoId, numId: numericId });

              if (found.found) {
                this.log(`[Search] \u2705 Found target video after ${scrollsDone} scrolls (${found.total} links): ${found.href}`);
                await this._humanDelay(2000, 3000);
                return true;
              }
              
              // Detect if no more content is loading
              if (found.total === prevLinkCount) {
                noNewLinksCount++;
                if (noNewLinksCount >= 3) {
                  this.log(`[Search] No new results after ${noNewLinksCount} scrolls. Stopping. (${found.total} links total)`);
                  break;
                }
              } else {
                noNewLinksCount = 0;
              }
              prevLinkCount = found.total;
              
              // Log progress every 5 scrolls
              if (scrollsDone % 5 === 0 && scrollsDone > 0) {
                this.log(`[Search] Scroll ${scrollsDone}/${maxScrolls || '\u221e'}: ${found.total} links scanned`);
              }
              
              // Scroll down
              await page.mouse.wheel(0, this._randomDelay(400, 800));
              await this._humanDelay(1000, 2500);
              
              // Occasional scroll-up for natural behavior
              if (scrollsDone > 0 && scrollsDone % 7 === 0) {
                await page.mouse.wheel(0, -200);
                await this._humanDelay(500, 1000);
              }
            }
            
            // Final check with all loaded content
            const finalCheck = await page.evaluate(({ videoId, numId }) => {
              const links = document.querySelectorAll('a[href]');
              let total = 0;
              for (const link of links) {
                const href = link.href || link.getAttribute('href') || '';
                if (href.includes('video') || href.includes(numId)) {
                  total++;
                  if (href.includes(videoId) || href.includes(numId)) {
                    link.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    link.click();
                    return { found: true, href, total };
                  }
                }
              }
              return { found: false, total, sample: [...links].filter(l => (l.href||'').includes('video')).slice(0, 10).map(l => l.href.substring(0, 80)) };
            }, { videoId: targetVideoId, numId: numericId });
            
            if (finalCheck.found) {
              this.log(`[Search] \u2705 Found target video in final scan (${finalCheck.total} links): ${finalCheck.href}`);
              await this._humanDelay(2000, 3000);
              return true;
            }
            
            this.log(`[Search] Target video not found after ${scrollsDone} scrolls (${finalCheck.total} links). Sample hrefs:`);
            (finalCheck.sample || []).forEach((h, i) => this.log(`[Search]   ${i}: ${h}`));
          } else {
            // No target ID to match, just scroll a few times
            for (let s = 0; s < 8; s++) {
              await page.mouse.wheel(0, this._randomDelay(400, 800));
              await this._humanDelay(1000, 2000);
            }
          }
        } else {
          this.log('[Search] \u26a0\ufe0f Search input not found on page');
        }
      }
      
      // Fallback: navigate directly to target URL
      if (targetUrl) {
        this.log(`[Search] Navigating directly to video: ${targetUrl}`);
        const directOk = await this._safeGoto(page, targetUrl, { label: 'target video', timeout: 30000 });
        if (directOk) {
          await this._waitForPageReady(page);
          await this._humanDelay(2000, 3000);
          this.log(`[Search] Direct navigation OK, current URL: ${page.url().substring(0, 80)}`);
          return true;
        }
        this.log(`[Search] Direct navigation partial, current URL: ${page.url().substring(0, 80)}`);
        return page.url() !== 'about:blank';
      }

      return false;
    } catch (error) {
      this.log(`[Search] Error: ${error.message}`);
      if (targetUrl) {
        this.log('[Search] Attempting direct fallback navigation...');
        const ok = await this._safeGoto(page, targetUrl, { label: 'video fallback', timeout: 30000 });
        if (ok) {
          await this._humanDelay(2000, 3000);
          return true;
        }
      }
      return false;
    }
  }

  async watchVideo(page, duration) {
    const settings = this.store.get('settings') || {};
    const watchMin = duration || settings.watchDuration?.min || 30;
    const watchMax = duration || settings.watchDuration?.max || 120;
    const watchTime = this._randomDelay(watchMin, watchMax);
    
    this.log(`[Watch] Target watch time: ${watchTime}s (range ${watchMin}-${watchMax}s)`);
    
    // Shadow DOM helper — VK uses <vk-video-player> Web Component
    const FIND_VIDEOS_JS = `
      function _findVideos(root) {
        const found = [];
        for (const el of root.querySelectorAll('*')) {
          if (el.tagName === 'VIDEO') found.push(el);
          if (el.shadowRoot) found.push(..._findVideos(el.shadowRoot));
        }
        return found;
      }
    `;

    try {
      // ── Step 0: Get duration from page UI (data-testid="video_duration") ──
      let pageDuration = null;
      try {
        const durSpan = page.getByTestId('video_duration');
        if (await durSpan.isVisible({ timeout: 3000 })) {
          const durText = await durSpan.textContent();
          this.log(`[Watch] Duration from UI: "${durText}"`);
          const parts = durText.trim().split(':').map(Number);
          if (parts.length === 2) pageDuration = parts[0] * 60 + parts[1];
          else if (parts.length === 3) pageDuration = parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (pageDuration) this.log(`[Watch] Parsed duration: ${pageDuration}s`);
        }
      } catch (e) {}

      // ── Step 1: Wait for video element (Playwright locator pierces Shadow DOM) ──
      this.log('[Watch] Looking for <video> element (with Shadow DOM piercing)...');
      let videoFound = false;
      try {
        const videoLocator = page.locator('video').first();
        await videoLocator.waitFor({ state: 'attached', timeout: 10000 });
        videoFound = true;
        this.log('[Watch] <video> found via Playwright locator');
      } catch (e) {
        // Manual shadow DOM traversal
        const jsCount = await page.evaluate(() => {
          function _fv(root) { const f=[]; for(const el of root.querySelectorAll('*')){ if(el.tagName==='VIDEO')f.push(el); if(el.shadowRoot)f.push(..._fv(el.shadowRoot)); } return f; }
          return _fv(document).length;
        }).catch(() => 0);
        if (jsCount > 0) {
          videoFound = true;
          this.log(`[Watch] Found ${jsCount} video(s) via JS shadow DOM traversal`);
        } else {
          this.log('[Watch] \u26a0\ufe0f No <video> element found');
        }
      }

      // ── Step 2: Click player area to start playback ──
      try {
        const playerArea = page.locator('vk-video-player, [class*="VideoPlayer__player"]').first();
        if (await playerArea.isVisible({ timeout: 3000 })) {
          await playerArea.click();
          await this._humanDelay(500, 1000);
          this.log('[Watch] Clicked player area');
        }
      } catch (e) {}

      // ── Step 3: Force play via JS (traverse shadow DOM) ──
      const playResult = await page.evaluate(() => {
        function _fv(root) { const f=[]; for(const el of root.querySelectorAll('*')){ if(el.tagName==='VIDEO')f.push(el); if(el.shadowRoot)f.push(..._fv(el.shadowRoot)); } return f; }
        const videos = _fv(document);
        const results = [];
        for (const video of videos) {
          video.muted = true;
          try { video.play(); } catch (e) {}
          results.push({
            paused: video.paused,
            duration: isFinite(video.duration) ? Math.round(video.duration) : -1,
            currentTime: Math.round(video.currentTime),
            readyState: video.readyState,
            src: (video.src || video.currentSrc || '').substring(0, 60),
          });
        }
        // Remove overlays
        document.querySelectorAll('[class*="overlay"],[class*="Overlay"],[class*="promo"]')
          .forEach(el => { if (el.style) el.style.display = 'none'; });
        return results;
      }).catch(() => []);

      if (playResult.length > 0) {
        this.log(`[Watch] Video state: ${JSON.stringify(playResult)}`);
      }

      const mainVideo = playResult[0];
      if (mainVideo) {
        const durStr = mainVideo.duration > 0 ? `${mainVideo.duration}s` : (pageDuration ? `${pageDuration}s (UI)` : 'unknown');
        this.log(`[Watch] Status: paused=${mainVideo.paused}, duration=${durStr}, readyState=${mainVideo.readyState}`);
      }

      // ── Step 4: Click play if still paused ──
      if (!mainVideo || mainVideo.paused) {
        try {
          const playBtn = page.getByRole('button', { name: /play|воспроизвести/i }).first();
          if (await playBtn.isVisible({ timeout: 2000 })) {
            await playBtn.click();
            this.log('[Watch] Clicked play via getByRole');
            await this._humanDelay(500, 1000);
          }
        } catch (e) {}
        // Click player area again
        try {
          await page.locator('vk-video-player').first().click();
          this.log('[Watch] Clicked vk-video-player');
        } catch (e) {}
        // Force play JS
        await page.evaluate(() => {
          function _fv(r){const f=[];for(const e of r.querySelectorAll('*')){if(e.tagName==='VIDEO')f.push(e);if(e.shadowRoot)f.push(..._fv(e.shadowRoot))}return f}
          _fv(document).forEach(v=>{v.muted=true;try{v.play()}catch(e){}});
        }).catch(() => {});
      }

      // ── Step 5: Check playback state attribute ──
      try {
        const pbState = await page.evaluate(() => {
          const el = document.querySelector('[data-playback-state]');
          return el ? el.getAttribute('data-playback-state') : null;
        });
        if (pbState) this.log(`[Watch] data-playback-state: "${pbState}"`);
      } catch (e) {}

      // ── Step 6: Watch loop ──
      const startTime = Date.now();
      let lastProgressCheck = 0;
      let videoDuration = pageDuration ? `${pageDuration}s` : 'unknown';
      
      while ((Date.now() - startTime) / 1000 < watchTime) {
        if (page.isClosed()) {
          this.log('[Watch] Page closed, stopping');
          break;
        }
        
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed - lastProgressCheck >= 15) {
          lastProgressCheck = elapsed;
          try {
            const status = await page.evaluate(() => {
              function _fv(r){const f=[];for(const e of r.querySelectorAll('*')){if(e.tagName==='VIDEO')f.push(e);if(e.shadowRoot)f.push(..._fv(e.shadowRoot))}return f}
              const v = _fv(document)[0];
              if (!v) return { found: false };
              if (v.paused && !v.ended) { v.muted = true; try { v.play(); } catch (e) {} }
              return { 
                found: true, paused: v.paused, ended: v.ended,
                currentTime: Math.round(v.currentTime),
                duration: isFinite(v.duration) ? Math.round(v.duration) : -1,
                readyState: v.readyState, playbackRate: v.playbackRate,
                buffered: v.buffered.length > 0 ? Math.round(v.buffered.end(v.buffered.length - 1)) : 0,
              };
            });
            if (status.found) {
              const durStr = status.duration > 0 ? `${status.duration}s` : videoDuration;
              if (status.duration > 0) videoDuration = `${status.duration}s`;
              const state = status.paused ? 'PAUSED' : status.ended ? 'ENDED' : 'PLAYING';
              this.log(`[Watch] ${elapsed}s/${watchTime}s \u2014 video: ${status.currentTime}s/${durStr} [${state}] rate:${status.playbackRate} buf:${status.buffered}s`);
            } else {
              const pbState = await page.evaluate(() => {
                const el = document.querySelector('[data-playback-state]');
                return el ? el.getAttribute('data-playback-state') : '?';
              }).catch(() => '?');
              this.log(`[Watch] ${elapsed}s/${watchTime}s \u2014 no video via JS, state: ${pbState}, dur: ${videoDuration}`);
            }
          } catch (e) {}
        }
        
        const x = this._randomDelay(200, 1700);
        const y = this._randomDelay(200, 800);
        await page.mouse.move(x, y);
        if (Math.random() < 0.08) await page.mouse.wheel(0, this._randomDelay(-50, 50));
        await this._humanDelay(3000, 8000);
      }
      
      const totalWatched = Math.round((Date.now() - startTime) / 1000);
      this.log(`[Watch] \u2705 Done \u2014 watched ${totalWatched}s (target ${watchTime}s), duration: ${videoDuration}`);
      return true;
    } catch (error) {
      this.log(`[Watch] Error: ${error.message}`);
      return false;
    }
  }

  /**
   * Sets video playback speed to 0.25x using VK Video player settings.
   * 
   * IMPORTANT: VK Video uses <vk-video-player> Web Component with Shadow DOM.
   * All player controls (settings, play, timeline) are INSIDE the shadow root.
   * - page.getByTestId() pierces shadow DOM automatically
   * - page.getByText() pierces shadow DOM automatically  
   * - page.locator('[attr]') does NOT pierce shadow DOM
   * - document.querySelector() in evaluate does NOT pierce shadow DOM
   * 
   * Sequence: click settings-btn → click "Скорость" → click "0.25"
   * Fallback: find <video> inside shadow root and set playbackRate = 0.25
   */
  async _setPlaybackSpeed025(page) {
    this.log('[Speed] Setting playback speed to 0.25x...');
    try {
      // First: hover/click on player area to make controls visible
      try {
        const playerArea = page.locator('vk-video-player, [class*="VideoPlayer"]').first();
        if (await playerArea.isVisible({ timeout: 3000 })) {
          await playerArea.hover();
          await this._humanDelay(500, 1000);
          this.log('[Speed] Hovered over player to show controls');
        }
      } catch (e) {}

      // Method 1: Use getByTestId (pierces Shadow DOM automatically)
      let uiSuccess = false;
      try {
        const settingsBtn = page.getByTestId('settings-btn');
        if (await settingsBtn.isVisible({ timeout: 5000 })) {
          await settingsBtn.click();
          this.log('[Speed] Clicked settings button (via getByTestId)');
          await this._humanDelay(500, 1000);

          // Click "Скорость" — getByText also pierces shadow DOM
          const speedItem = page.getByText('Скорость', { exact: false });
          if (await speedItem.first().isVisible({ timeout: 3000 })) {
            await speedItem.first().click();
            this.log('[Speed] Clicked "Скорость" menu item');
            await this._humanDelay(500, 1000);

            // Click "0.25"
            const speed025 = page.getByText('0.25', { exact: true });
            if (await speed025.isVisible({ timeout: 3000 })) {
              await speed025.click();
              this.log('[Speed] ✅ Set speed to 0.25x via UI');
              uiSuccess = true;
              await this._humanDelay(300, 600);
            } else {
              this.log('[Speed] 0.25 option not visible');
              await page.keyboard.press('Escape');
            }
          } else {
            this.log('[Speed] "Скорость" menu not visible');
            await page.keyboard.press('Escape');
          }
        } else {
          this.log('[Speed] settings-btn not visible (controls may be hidden)');
        }
      } catch (e) {
        this.log(`[Speed] UI method error: ${e.message.substring(0, 80)}`);
      }

      // Method 2: Fallback — find video inside shadow DOM and set playbackRate via JS
      if (!uiSuccess) {
        this.log('[Speed] Falling back to JS playbackRate (with shadow DOM traversal)...');
        const jsResult = await page.evaluate(() => {
          // Try 1: direct querySelectorAll (works if no shadow DOM)
          let videos = document.querySelectorAll('video');
          
          // Try 2: traverse shadow roots to find video elements
          if (videos.length === 0) {
            const players = document.querySelectorAll('vk-video-player');
            for (const player of players) {
              if (player.shadowRoot) {
                const sv = player.shadowRoot.querySelectorAll('video');
                if (sv.length > 0) videos = sv;
              }
              // Also check nested shadow-root-container
              const containers = player.querySelectorAll('.shadow-root-container, .root-container');
              for (const c of containers) {
                if (c.shadowRoot) {
                  const sv2 = c.shadowRoot.querySelectorAll('video');
                  if (sv2.length > 0) videos = sv2;
                }
              }
            }
          }
          
          // Try 3: Deep shadow DOM traversal
          if (videos.length === 0) {
            function findVideosInShadow(root) {
              const found = [];
              const all = root.querySelectorAll('*');
              for (const el of all) {
                if (el.tagName === 'VIDEO') found.push(el);
                if (el.shadowRoot) found.push(...findVideosInShadow(el.shadowRoot));
              }
              return found;
            }
            videos = findVideosInShadow(document);
          }
          
          let set = false;
          for (const v of videos) {
            v.playbackRate = 0.25;
            set = true;
          }
          return { set, count: videos.length };
        });
        if (jsResult.set) {
          this.log(`[Speed] ✅ Set playbackRate=0.25 via JS on ${jsResult.count} video(s)`);
        } else {
          this.log('[Speed] ⚠️ No video elements found even in shadow DOM');
        }
      }
    } catch (e) {
      this.log(`[Speed] Error: ${e.message}`);
      // Last resort
      await page.evaluate(() => {
        function findVideos(root) {
          const found = [];
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'VIDEO') found.push(el);
            if (el.shadowRoot) found.push(...findVideos(el.shadowRoot));
          }
          return found;
        }
        findVideos(document).forEach(v => { v.playbackRate = 0.25; });
      }).catch(() => {});
    }
  }

  async pressLike(page) {
    this.log('[Like] Attempting to like...');
    try {
      // VKVideo uses data-testid attributes for buttons
      // video_page_like_button = on the video page (full view)
      // video_modal_like_button = on the modal (overlay) player
      const likeSelectors = [
        '[data-testid="video_page_like_button"]',
        '[data-testid="video_modal_like_button"]',
        '[data-testid="like_button"]',
        '.like_btn:not(.active)',
        'button[class*="like"]:not(.active)',
        '[data-like-id]',
        '.PostBottomAction:first-child',
      ];

      for (const sel of likeSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 })) {
            await btn.click();
            this.log('[Like] ✅ Liked');
            await this._humanDelay(500, 1500);
            return true;
          }
        } catch (e) {}
      }
      
      this.log('[Like] Like button not found');
      return false;
    } catch (error) {
      this.log(`[Like] Error: ${error.message}`);
      return false;
    }
  }

  async postComment(page, text) {
    this.log(`[Comment] Posting: "${text.substring(0, 30)}..."`);
    try {
      const commentSelectors = [
        'div[contenteditable="true"][class*="comment"]',
        '.reply_field',
        'textarea[name="comment"]',
        'div[contenteditable="true"]',
      ];

      let commentInput = null;
      for (const sel of commentSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            commentInput = el;
            break;
          }
        } catch (e) {}
      }

      if (!commentInput) {
        // Try clicking "Комментировать" button first
        try {
          const btn = page.locator('button:has-text("Комментировать"), a:has-text("Комментировать")').first();
          if (await btn.isVisible({ timeout: 2000 })) {
            await btn.click();
            await this._humanDelay(500, 1000);
            // Try again
            for (const sel of commentSelectors) {
              const el = page.locator(sel).first();
              if (await el.isVisible({ timeout: 2000 })) {
                commentInput = el;
                break;
              }
            }
          }
        } catch (e) {}
      }

      if (!commentInput) {
        this.log('[Comment] Comment input not found');
        return false;
      }

      await commentInput.click();
      await this._humanDelay(300, 600);
      await this._humanType(page, commentInput, text);
      await this._humanDelay(500, 1000);
      
      // Submit comment
      await page.keyboard.press('Enter');
      await this._humanDelay(1000, 2000);
      
      this.log('[Comment] ✅ Comment posted');
      return true;
    } catch (error) {
      this.log(`[Comment] Error: ${error.message}`);
      return false;
    }
  }

  // ============================================================
  // TASK EXECUTION
  // ============================================================

  async executeEngagementTask(task, onProgress, signal) {
    const settings = this.store.get('settings') || {};
    const {
      videoUrl,
      viewCount = 0,
      likeCount = 0,
      commentCount = 0,
      searchKeywords,
      useSearch = false,
      searchScrollCount = 0,
      accountIds = [],
      proxyIds = [],
      slowSpeed = false,
      ghostWatchers = false,
    } = task;

    if (!videoUrl) {
      throw new Error('No video URL specified');
    }

    this.log(`[Task] Starting engagement task for: ${videoUrl}`);
    this.log(`[Task] Views: ${viewCount}, Likes: ${likeCount}, Comments: ${commentCount}`);
    this.log(`[Task] Mode: ${useSearch ? 'search' : 'direct'}${useSearch ? ` (scrolls: ${searchScrollCount || 'unlimited'})` : ''}, Accounts: ${accountIds.length}, Proxies: ${proxyIds.length}`);
    this.log(`[Task] Slow speed (0.25x): ${slowSpeed ? 'YES' : 'no'}, Ghost Watchers: ${ghostWatchers ? 'YES' : 'no'}`);

    const accounts = this.store.get('accounts') || [];
    const comments = this.store.get('comments') || [];
    const maxConcurrency = settings.maxConcurrency || 3;

    // Build operation plan
    const ops = [];
    const usedProxyIds = new Set();
    
    for (let i = 0; i < Math.max(viewCount, likeCount, commentCount); i++) {
      const accountId = accountIds[i % accountIds.length];
      const account = accounts.find(a => a.id === accountId);
      if (!account) continue;

      // Assign proxy: round-robin from task.proxyIds, fall back to account.proxyId
      let proxyId = null;
      if (proxyIds.length > 0) {
        proxyId = proxyIds[i % proxyIds.length];
        usedProxyIds.add(proxyId);
      } else if (account.proxyId) {
        proxyId = account.proxyId;
      }

      ops.push({
        type: 'engagement',
        accountId,
        proxyId,
        shouldLike: i < likeCount,
        shouldComment: i < commentCount,
        commentText: i < commentCount && comments.length > 0 
          ? comments[Math.floor(Math.random() * comments.length)]?.text || ''
          : '',
        slowSpeed,
      });
    }

    // Ghost Watchers: use unused proxies to anonymously view the video
    const ghostOps = [];
    if (ghostWatchers && proxyIds.length > 0) {
      const unusedProxyIds = proxyIds.filter(pid => !usedProxyIds.has(pid));
      // Also add all proxies as additional ghost watchers (they can watch more than once)
      const allGhostProxies = unusedProxyIds.length > 0 ? unusedProxyIds : proxyIds;
      for (const pid of allGhostProxies) {
        ghostOps.push({
          type: 'ghost',
          proxyId: pid,
          slowSpeed,
        });
      }
      this.log(`[Task] \ud83d\udc7b Ghost Watchers: ${ghostOps.length} (unused proxies: ${unusedProxyIds.length}, total proxies: ${proxyIds.length})`);
    }

    this.log(`[Task] Total operations: ${ops.length} engagement + ${ghostOps.length} ghost, Concurrency: ${maxConcurrency}`);
    if (proxyIds.length > 0) {
      const proxyList = this.store.get('proxies') || [];
      for (const pid of proxyIds) {
        const px = proxyList.find(p => p.id === pid);
        if (px) this.log(`[Task] Proxy: ${px.type || 'http'}://${px.host}:${px.port} (${px.country || px.countryCode || '?'}) status=${px.status}`);
      }
    } else {
      this.log('[Task] \u26a0\ufe0f No proxies selected for this task');
    }

    const results = { views: 0, likes: 0, comments: 0, errors: 0, ghostViews: 0 };

    // Combine all ops
    const allOps = [...ops, ...ghostOps];
    const totalOps = allOps.length;

    // Process in batches
    for (let batchStart = 0; batchStart < totalOps; batchStart += maxConcurrency) {
      if (signal?.aborted) {
        this.log('[Task] Aborted');
        break;
      }

      const batch = allOps.slice(batchStart, batchStart + maxConcurrency);
      const batchNum = Math.floor(batchStart / maxConcurrency) + 1;
      const totalBatches = Math.ceil(totalOps / maxConcurrency);
      this.log(`[Task] Batch ${batchNum}/${totalBatches}`);

      const batchPromises = batch.map((op, idx) => {
        return new Promise(async (resolve) => {
          // Stagger start
          await this._humanDelay(idx * 1000, idx * 2000 + 1000);
          
          let opResult = null;
          try {
            if (op.type === 'ghost') {
              opResult = await this._ghostWatchOp(op, task, settings);
              if (opResult.viewed) results.ghostViews++;
              if (opResult.error) results.errors++;
            } else {
              opResult = await this._executeSingleOp(op, task, settings);
              if (opResult.viewed) results.views++;
              if (opResult.liked) results.likes++;
              if (opResult.commented) results.comments++;
              if (opResult.error) results.errors++;
            }
          } catch (e) {
            results.errors++;
            this.log(`[Task] Op error: ${e.message}`);
          }

          if (onProgress) {
            onProgress({
              current: batchStart + idx + 1,
              total: totalOps,
              status: opResult?.error ? 'error' : 'ok',
              message: `Views: ${results.views}, Likes: ${results.likes}, Comments: ${results.comments}, Ghost: ${results.ghostViews}, Errors: ${results.errors}`,
            });
          }

          resolve();
        });
      });

      await Promise.all(batchPromises);
    }

    this.log(`[Task] Completed. Views: ${results.views}, Likes: ${results.likes}, Comments: ${results.comments}, Ghost views: ${results.ghostViews}, Errors: ${results.errors}`);
    return results;
  }

  /**
   * Ghost Watch Operation — anonymous video viewing via proxy (no VK login).
   * Navigates directly to vkvideo.ru video URL and watches for a random duration.
   * No likes, comments, or account interaction.
   */
  async _ghostWatchOp(op, task, settings) {
    const { proxyId, slowSpeed } = op;
    const { videoUrl } = task;
    const opStart = Date.now();

    // Ensure the URL is on vkvideo.ru (the only domain that works without login)
    let ghostUrl = videoUrl;
    if (ghostUrl.includes('vk.com/video')) {
      const match = ghostUrl.match(/(video-?\d+_\d+)/);
      if (match) ghostUrl = `https://vkvideo.ru/${match[1]}`;
    }

    const allProxies = this.store.get('proxies') || [];
    let proxyUrl = null;
    let proxyInfo = 'direct';
    if (proxyId) {
      const proxy = allProxies.find(p => p.id === proxyId);
      if (proxy) {
        proxyUrl = this._buildProxyUrl(proxy);
        proxyInfo = `${proxy.type || 'http'}://${proxy.host}:${proxy.port} (${proxy.country || proxy.countryCode || '?'})`;
      }
    }

    this.log(`[\ud83d\udc7b Ghost] \u2500\u2500\u2500 Starting ghost watch \u2500\u2500\u2500`);
    this.log(`[\ud83d\udc7b Ghost] Proxy: ${proxyInfo}`);
    this.log(`[\ud83d\udc7b Ghost] URL: ${ghostUrl}`);

    let contextId = null;
    try {
      const launchOpts = {
        proxy: proxyUrl,
        headless: settings.headless !== undefined ? settings.headless : false,
      };

      const { context, contextId: cId } = await this._launchContext(launchOpts);
      contextId = cId;
      const page = await context.newPage();
      const result = { viewed: false, error: false };

      // Navigate directly to video
      const navOk = await this._safeGoto(page, ghostUrl, { label: 'ghost video', timeout: 30000 });
      
      // Detect dead proxy
      const currentUrl = page.url();
      if (currentUrl.includes('chrome-error') || (!navOk && currentUrl === 'about:blank')) {
        this.log(`[\ud83d\udc7b Ghost] \u274c Proxy error: ${currentUrl.substring(0, 50)}`);
        await this._safeClose(contextId);
        return { viewed: false, error: true };
      }

      await this._waitForPageReady(page);
      await this._humanDelay(2000, 3000);
      this.log(`[\ud83d\udc7b Ghost] Page loaded: ${page.url().substring(0, 80)}`);

      // Set speed if requested
      if (slowSpeed) {
        await this._setPlaybackSpeed025(page);
      }

      // Watch video
      const watchDuration = this._randomDelay(
        settings.watchDuration?.min || 30,
        settings.watchDuration?.max || 120
      );
      const watched = await this.watchVideo(page, watchDuration);
      result.viewed = watched;

      const totalTime = ((Date.now() - opStart) / 1000).toFixed(1);
      this.log(`[\ud83d\udc7b Ghost] \u2500\u2500\u2500 Ghost watch complete in ${totalTime}s \u2500\u2500\u2500 viewed=${result.viewed}`);

      await this._safeClose(contextId);
      return result;

    } catch (error) {
      const totalTime = ((Date.now() - opStart) / 1000).toFixed(1);
      this.log(`[\ud83d\udc7b Ghost] \u274c Error after ${totalTime}s: ${error.message}`);
      if (contextId) await this._safeClose(contextId);
      return { viewed: false, error: true };
    }
  }

  async _executeSingleOp(op, task, settings) {
    const { accountId, shouldLike, shouldComment, commentText, slowSpeed } = op;
    const { videoUrl, searchKeywords, useSearch, searchScrollCount = 0, proxyIds: taskProxyIds = [] } = task;
    const opStart = Date.now();

    const accounts = this.store.get('accounts') || [];
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      this.log(`[Op] \u274c Account ${accountId} not found in store`);
      return { error: 'Account not found' };
    }

    // Build ordered proxy list for failover: primary first, then remaining task proxies
    const allProxies = this.store.get('proxies') || [];
    const proxyQueue = [];
    // Primary proxy from op
    if (op.proxyId) proxyQueue.push(op.proxyId);
    // Add remaining task proxies as fallbacks (excluding primary)
    for (const pid of taskProxyIds) {
      if (!proxyQueue.includes(pid)) proxyQueue.push(pid);
    }

    this.log(`[Op] \u2500\u2500\u2500 Starting operation \u2500\u2500\u2500`);
    this.log(`[Op] Account: ${account.login?.substring(0, 6) || accountId.substring(0, 8)}***, type=${account.authType}, status=${account.status}, hasCookies=${account.hasCookies}`);
    this.log(`[Op] Video: ${videoUrl}`);
    this.log(`[Op] Plan: view=yes${shouldLike ? ', like=yes' : ''}${shouldComment ? ', comment=yes' : ''}, search=${useSearch ? `"${searchKeywords?.substring(0, 40)}"` : 'direct'}`);
    this.log(`[Op] Proxy queue: ${proxyQueue.length} (primary=${op.proxyId ? op.proxyId.substring(0, 8) : 'none'}, fallbacks=${proxyQueue.length - (op.proxyId ? 1 : 0)})`);

    const cookiesDir = path.join(app.getPath('userData'), 'accounts');
    const statePath = path.join(cookiesDir, `${accountId}_state.json`);
    const cookiesPath = path.join(cookiesDir, `${accountId}_cookies.json`);

    // Try each proxy in order (failover). Empty string = "no proxy" (direct)
    const proxyAttempts = proxyQueue.length > 0 ? [...proxyQueue] : [null];
    // If task allows direct connection, add null (direct) as last resort
    if (task.allowDirect && proxyQueue.length > 0) proxyAttempts.push(null);

    for (let proxyAttempt = 0; proxyAttempt < proxyAttempts.length; proxyAttempt++) {
      const currentProxyId = proxyAttempts[proxyAttempt];
      let proxyUrl = null;
      let proxyInfo = 'direct (no proxy)';
      
      if (currentProxyId) {
        const proxy = allProxies.find(p => p.id === currentProxyId);
        if (proxy) {
          proxyUrl = this._buildProxyUrl(proxy);
          proxyInfo = `${proxy.type || 'http'}://${proxy.host}:${proxy.port} (${proxy.country || proxy.countryCode || '?'}) status=${proxy.status}`;
        } else {
          this.log(`[Op] \u26a0\ufe0f Proxy ${currentProxyId} not found, skipping`);
          continue;
        }
      }
      
      if (proxyAttempt > 0) {
        this.log(`[Op] \ud83d\udd04 Proxy failover attempt ${proxyAttempt + 1}/${proxyAttempts.length}`);
      }
      this.log(`[Op] Proxy: ${proxyInfo}`);

      let contextId = null;
      try {
        // Build launch options
        const launchOpts = { 
          proxy: proxyUrl,
          headless: settings.headless !== undefined ? settings.headless : false,
        };

        // Prefer storageState (restores cookies + localStorage in one step)
        if (account.hasCookies && fs.existsSync(statePath)) {
          launchOpts.storageStatePath = statePath;
          this.log('[Op] Using saved storage state');
        } else if (account.hasCookies && fs.existsSync(cookiesPath)) {
          this.log('[Op] Using saved cookies (no storage state)');
        } else {
          this.log('[Op] No saved session \u2014 will need full login');
        }

        const launchStart = Date.now();
        const { context, contextId: cId } = await this._launchContext(launchOpts);
        contextId = cId;
        this.log(`[Op] Browser launched in ${((Date.now() - launchStart) / 1000).toFixed(1)}s`);

        const page = await context.newPage();
        const result = { viewed: false, liked: false, commented: false, error: false };

        // ── Check session ──
        let loggedIn = false;
        if (account.hasCookies) {
          // If no storageState was loaded, try manual cookies
          if (!launchOpts.storageStatePath && fs.existsSync(cookiesPath)) {
            try {
              const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
              await this._loadCookies(context, cookies);
              this.log(`[Op] Loaded ${cookies.length} cookies manually`);
            } catch (e) {
              this.log(`[Op] Failed to load cookies: ${e.message}`);
            }
          }
            
          const navOk = await this._safeGoto(page, 'https://vk.com/feed', { label: 'VK feed (session check)', timeout: 25000 });
          
          // Detect dead proxy: chrome-error:// or about:blank
          const currentUrl = page.url();
          if (currentUrl.includes('chrome-error') || (!navOk && currentUrl === 'about:blank')) {
            this.log(`[Op] \u274c Proxy error detected (${currentUrl.substring(0, 50)}), will try next proxy...`);
            await this._safeClose(contextId);
            contextId = null;
            // Mark this proxy as failed if it exists
            if (currentProxyId) {
              const proxyIdx = allProxies.findIndex(p => p.id === currentProxyId);
              if (proxyIdx !== -1) {
                allProxies[proxyIdx].status = 'error';
                allProxies[proxyIdx].lastError = new Date().toISOString();
                this.store.set('proxies', allProxies);
              }
            }
            continue; // Try next proxy
          }
          
          if (navOk) {
            await this._waitForPageReady(page);
            await this._humanDelay(1000, 2000);
            loggedIn = await this._checkVKLogin(page);
          }
          
          if (loggedIn) {
            this.log('[Op] \u2705 Logged in via saved session');
          } else {
            this.log('[Op] Session expired or invalid');
          }
        }
        
        // ── Full login if needed ──
        if (!loggedIn) {
          if (account.authType === 'logpass' && account.login && account.password) {
            this.log('[Op] Performing full login...');
            const loginStart = Date.now();
            const loginResult = await this.loginVK(page, account.login, account.password);
            const loginTime = ((Date.now() - loginStart) / 1000).toFixed(1);
            
            // Check if login failed due to proxy error
            const postLoginUrl = page.url();
            if (postLoginUrl.includes('chrome-error')) {
              this.log(`[Op] \u274c Proxy error during login, will try next proxy...`);
              await this._safeClose(contextId);
              contextId = null;
              continue;
            }
            
            if (loginResult.success) {
              loggedIn = true;
              this.log(`[Op] \u2705 Login successful in ${loginTime}s`);
              await this._saveSession(context, accountId);
            } else {
              this.log(`[Op] \u274c Login failed in ${loginTime}s: ${loginResult.error}`);
              result.error = true;
              await this._safeClose(contextId);
              return result;
            }
          } else {
            this.log('[Op] \u274c No credentials available for login');
            result.error = true;
            await this._safeClose(contextId);
            return result;
          }
        }

        // ── Warm-up browsing ──
        if (settings.warmUp) {
          const warmStart = Date.now();
          await this.warmUpBrowsing(page);
          this.log(`[Op] Warm-up completed in ${((Date.now() - warmStart) / 1000).toFixed(1)}s`);
        }

        // ── Navigate to video ──
        const navStart = Date.now();
        if (useSearch && searchKeywords) {
          const found = await this.searchAndFindVideo(page, searchKeywords, videoUrl, searchScrollCount);
          if (!found && videoUrl) {
            this.log('[Op] Search failed, navigating directly to video URL...');
            await this._safeGoto(page, videoUrl, { label: 'video direct', timeout: 30000 });
            await this._humanDelay(2000, 3000);
          }
        } else {
          await this._safeGoto(page, videoUrl, { label: 'video direct', timeout: 30000 });
          await this._waitForPageReady(page);
          await this._humanDelay(2000, 3000);
        }
        this.log(`[Op] Navigation to video took ${((Date.now() - navStart) / 1000).toFixed(1)}s`);
        this.log(`[Op] Current URL: ${page.url().substring(0, 100)}`);

        // ── Set 0.25x speed if requested ──
        if (slowSpeed) {
          await this._setPlaybackSpeed025(page);
        }

        // ── Watch video ──
        const watchDuration = this._randomDelay(
          settings.watchDuration?.min || 30,
          settings.watchDuration?.max || 120
        );
        await this.watchVideo(page, watchDuration);
        result.viewed = true;

        // ── Like ──
        if (shouldLike) {
          const liked = await this.pressLike(page);
          result.liked = liked;
          this.log(`[Op] Like: ${liked ? '\u2705' : '\u274c'}`);
        }

        // ── Comment ──
        if (shouldComment && commentText) {
          const commented = await this.postComment(page, commentText);
          result.commented = commented;
          this.log(`[Op] Comment: ${commented ? '\u2705' : '\u274c'}`);
        }

        const totalTime = ((Date.now() - opStart) / 1000).toFixed(1);
        this.log(`[Op] \u2500\u2500\u2500 Operation complete in ${totalTime}s \u2500\u2500\u2500 viewed=${result.viewed}, liked=${result.liked}, commented=${result.commented}`);

        await this._safeClose(contextId);
        return result;

      } catch (error) {
        const totalTime = ((Date.now() - opStart) / 1000).toFixed(1);
        this.log(`[Op] \u274c Error after ${totalTime}s: ${error.message}`);
        if (contextId) await this._safeClose(contextId);
        
        // If it looks like a proxy/network error, try next proxy
        const errMsg = error.message.toLowerCase();
        if (proxyAttempt < proxyAttempts.length - 1 && (
          errMsg.includes('net::err_') || errMsg.includes('proxy') || 
          errMsg.includes('connection') || errMsg.includes('timeout') ||
          errMsg.includes('chrome-error') || errMsg.includes('econnrefused')
        )) {
          this.log(`[Op] Network/proxy error, will try next proxy...`);
          continue;
        }
        
        return { viewed: false, liked: false, commented: false, error: true };
      }
    }

    // All proxies exhausted
    this.log(`[Op] \u274c All proxies exhausted (${proxyAttempts.length} tried). Operation failed.`);
    return { viewed: false, liked: false, commented: false, error: true };
  }

  // ============================================================
  // SESSION PERSISTENCE
  // ============================================================

  /**
   * Saves full browser session (cookies + storage state) for an account.
   * This allows fast re-login without going through the full auth flow.
   */
  async _saveSession(context, accountId) {
    try {
      const cookiesDir = path.join(app.getPath('userData'), 'accounts');
      fs.mkdirSync(cookiesDir, { recursive: true });

      // Save cookies
      const cookies = await context.cookies();
      fs.writeFileSync(
        path.join(cookiesDir, `${accountId}_cookies.json`),
        JSON.stringify(cookies, null, 2)
      );

      // Save full storage state (cookies + localStorage + sessionStorage)
      try {
        const storageState = await context.storageState();
        fs.writeFileSync(
          path.join(cookiesDir, `${accountId}_state.json`),
          JSON.stringify(storageState, null, 2)
        );
        this.log(`[Session] Saved full state for account ${accountId}`);
      } catch (e) {
        this.log(`[Session] Could not save storage state: ${e.message}`);
      }

      // Update account in store (always read fresh)
      const latestAccounts = this.store.get('accounts') || [];
      const idx = latestAccounts.findIndex(a => a.id === accountId);
      if (idx !== -1) {
        latestAccounts[idx].hasCookies = true;
        latestAccounts[idx].status = 'valid';
        latestAccounts[idx].lastVerified = new Date().toISOString();
        this.store.set('accounts', latestAccounts);
      }
    } catch (e) {
      this.log(`[Session] Save error: ${e.message}`);
    }
  }

  // ============================================================
  // BULK VERIFY
  // ============================================================

  /**
   * Verifies multiple accounts in sequence.
   * Called from main.js ipcMain handler 'account:bulkVerify'.
   */
  async bulkVerifyCookies(accountIds, proxyId = null, onProgress) {
    const results = [];
    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i];
      try {
        const result = await this.verifyCookies(accountId, proxyId);
        results.push({ accountId, ...result });
      } catch (e) {
        this.log(`[BulkVerify] Error for ${accountId}: ${e.message}`);
        results.push({ accountId, valid: false, error: e.message });
      }

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: accountIds.length,
          accountId,
          valid: results[results.length - 1].valid,
        });
      }
    }
    return results;
  }

  // ============================================================
  // CLEANUP
  // ============================================================

  async cleanup() {
    this.log('[Engine] Cleaning up all active contexts...');
    const contextIds = [...this.activeContexts.keys()];
    for (const id of contextIds) {
      await this._safeClose(id);
    }
    this.log(`[Engine] Cleaned up ${contextIds.length} contexts`);
  }
}

module.exports = { PlaywrightEngine };

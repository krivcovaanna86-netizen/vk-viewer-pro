/**
 * PlaywrightEngine v1.0
 * VK Video Engagement Tool - Browser Automation Engine
 * 
 * Supports: fingerprint injection, playwright-extra stealth, plain launch
 * Features: VK login, cookie management, warm-up, search, watch, like, comment
 */

const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const http = require('http');
const https = require('https');

class PlaywrightEngine {
  constructor(store) {
    this.store = store;
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

  async _launchContext(options = {}) {
    const settings = this.store.get('settings') || {};
    const headless = options.headless !== undefined ? options.headless : (settings.headless !== undefined ? settings.headless : false);
    const stealth = settings.stealth !== undefined ? settings.stealth : true;
    
    const launchOpts = {
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--lang=ru-RU',
      ],
    };

    if (options.proxy) {
      launchOpts.proxy = typeof options.proxy === 'string' 
        ? this._parseProxy(options.proxy) 
        : options.proxy;
    }

    let browser;
    try {
      // Try playwright-extra with stealth if available and enabled
      if (stealth) {
        try {
          const { chromium: stealthChromium } = require('playwright-extra');
          const StealthPlugin = require('puppeteer-extra-plugin-stealth');
          stealthChromium.use(StealthPlugin());
          browser = await stealthChromium.launch(launchOpts);
          this.log('[Engine] Launched with stealth plugin');
        } catch (e) {
          browser = await chromium.launch(launchOpts);
          this.log('[Engine] Launched plain (stealth not available)');
        }
      } else {
        browser = await chromium.launch(launchOpts);
        this.log('[Engine] Launched plain');
      }
    } catch (e) {
      browser = await chromium.launch(launchOpts);
      this.log('[Engine] Launched plain (fallback)');
    }

    // Build context options — use Playwright's native storageState if provided
    const contextOpts = {
      viewport: { width: 1920, height: 1080 },
      locale: 'ru-RU',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
      await page.goto('https://vk.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._humanDelay(3000, 5000);

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
            'войти другим способом', 'другие способы входа', 'войти другим',
            'other', 'другие', 'способ', 'log in another way', 'other login',
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
        await page.goto('https://id.vk.com/auth', { waitUntil: 'domcontentloaded', timeout: 30000 });
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

        await this._humanDelay(2500, 4000);
      }

      // ── Step 5a: Robot challenge after submit ──
      await this._handleRobotChallenge(page);

      // ── Step 5b: "I'm not a robot" checkbox (Python ref: after phone input) ──
      for (let i = 0; i < 3; i++) {
        if (await this._clickNotRobotCheckbox(page)) break;
        await this._humanDelay(800, 1200);
      }

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

      await this._humanDelay(3000, 5000);

      // ── Step 10: Post-password checks (Python ref: captcha loop) ──
      this.log('[VK Login] Step 10: Post-password checks...');

      // Robot challenge / "Продолжить" clicks (Python ref: 10 attempts)
      for (let i = 0; i < 10; i++) {
        const hasRobot = await this._handleRobotChallenge(page);
        if (!hasRobot) break;
        await this._humanDelay(1500, 2500);
      }

      // Dismiss any remaining popups
      await this._dismissConfirmationPopup(page);

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
        await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 15000 });
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
   * This popup appears after clicking "Подтвердить другим способом".
   * 
   * CRITICAL: Must click "Пароль" / "Password" option — NOT just close!
   * The popup offers: QR code, SMS code, Password, Restore access
   * 
   * Based on Python ref: XPath search for elements containing 'password'/'паролю'
   * with filter to exclude 'confirm' and 'other' text.
   */
  async _selectPasswordInPopup(page) {
    this.log('[VK Login] Looking for password option in popup...');
    
    // Approach 1: Evaluate (Python ref pattern — most reliable)
    // Python ref: finds elements with text 'password'/'паролю', excludes 'confirm'/'other'
    try {
      const clicked = await page.evaluate(() => {
        const passwordTexts = ['password', 'паролю', 'пароль', 'account password', 'введите пароль', 'по паролю'];
        const excludeTexts = ['confirm', 'other', 'подтвердить', 'другим'];
        
        // Search all visible elements with password text
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          if (el.offsetParent === null) continue;
          if (!el.isConnected) continue;
          
          const text = (el.textContent || '').toLowerCase().trim();
          if (text.length > 80 || text.length === 0) continue;
          
          // Must contain a password-related text
          const hasPassword = passwordTexts.some(p => text.includes(p));
          if (!hasPassword) continue;
          
          // Must NOT contain exclude texts (to avoid clicking "Confirm using other method")
          const hasExclude = excludeTexts.some(e => text.includes(e));
          if (hasExclude) continue;
          
          // Prefer leaf-ish elements (not too many children)
          const childCount = el.children.length;
          if (childCount > 10) continue;
          
          try {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
            return `Clicked: "${text.substring(0, 60)}" (${el.tagName})`;
          } catch (e) {
            continue;
          }
        }
        
        // Fallback: look specifically in dialog/modal containers
        const containers = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"], [class*="bottomSheet"], [class*="ActionSheet"], [class*="sheet"]');
        for (const container of containers) {
          const elements = container.querySelectorAll('div, span, a, button, li, [role="button"], [role="option"]');
          for (const el of elements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (text.length > 100) continue;
            if (passwordTexts.some(p => text.includes(p)) && el.offsetParent !== null) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.click();
              return `Clicked in modal: "${text.substring(0, 60)}"`;
            }
          }
        }
        
        return null;
      });
      
      if (clicked) {
        this.log(`[VK Login] ${clicked}`);
        await this._humanDelay(1500, 2500);
        return true;
      }
    } catch (e) {
      this.log(`[VK Login] Evaluate error: ${e.message}`);
    }

    // Approach 2: Playwright locators
    const passwordTexts = ['пароль', 'password', 'account password'];
    for (const text of passwordTexts) {
      try {
        const selectors = [
          `span:has-text("${text}")`,
          `div:has-text("${text}")`,
          `a:has-text("${text}")`,
          `button:has-text("${text}")`,
          `[role="button"]:has-text("${text}")`,
          `li:has-text("${text}")`,
        ];
        for (const sel of selectors) {
          try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 800 })) {
              const elText = await el.textContent().catch(() => '');
              if (elText && elText.toLowerCase().includes(text) && elText.length < 80) {
                // Exclude "confirm using other" matches
                const lower = elText.toLowerCase();
                if (lower.includes('confirm') || lower.includes('other') || lower.includes('подтвердить') || lower.includes('другим')) continue;
                await el.click();
                this.log(`[VK Login] Clicked password option: "${elText.trim().substring(0, 50)}"`);
                await this._humanDelay(1500, 2500);
                return true;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    // Approach 3: Keyboard navigation
    try {
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        await this._humanDelay(300, 500);
        const focusedText = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? (el.textContent || '').toLowerCase().trim() : '';
        }).catch(() => '');
        if (passwordTexts.some(t => focusedText.includes(t))) {
          await page.keyboard.press('Enter');
          this.log('[VK Login] Selected password via keyboard navigation');
          await this._humanDelay(1500, 2500);
          return true;
        }
      }
    } catch (e) {}

    this.log('[VK Login] Could not find password option in popup');
    return false;
  }

  /**
   * Dismisses generic confirmation/info popups (e.g., "Закрыть" buttons)
   * Used as a fallback after other handlers
   */
  async _dismissConfirmationPopup(page) {
    try {
      const closeTexts = ['закрыть', 'close', 'отмена', 'cancel', 'не сейчас', 'not now', 'позже', 'later'];
      
      const closed = await page.evaluate((texts) => {
        const elements = document.querySelectorAll('button, a, span, [role="button"]');
        for (const el of elements) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (texts.some(t => text === t || text.includes(t)) && el.offsetParent !== null && text.length < 30) {
            el.click();
            return true;
          }
        }
        return false;
      }, closeTexts);

      if (closed) {
        this.log('[VK Login] Dismissed popup');
        await this._humanDelay(500, 1000);
        return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * Handles robot challenge: "Проверяем, что вы не робот"
   * Based on Python ref: is_robot_check_visible + click_robot_check_continue + dismiss_robot_check
   * Returns true if a robot challenge was found and handled.
   */
  async _handleRobotChallenge(page) {
    const maxAttempts = 5;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Python ref: is_robot_check_visible
      const isRobot = await page.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes('робот') || body.includes('robot');
      }).catch(() => false);

      if (!isRobot) return false;

      this.log(`[VK Login] Robot challenge detected (attempt ${attempt + 1}/${maxAttempts})`);

      // Python ref: click_robot_check_continue — multiple strategies
      let clicked = false;
      
      // 1. XPath-style: buttons with "Продолжить" / "Continue" (Python ref priority)
      try {
        clicked = await page.evaluate(() => {
          // Buttons and role=button with Continue text
          const xpathEls = document.querySelectorAll('button, *[role="button"]');
          for (const el of xpathEls) {
            const text = (el.textContent || '').toLowerCase();
            if ((text.includes('продолжить') || text.includes('continue')) && el.offsetParent !== null) {
              el.scrollIntoView();
              el.click();
              return true;
            }
          }
          return false;
        });
      } catch (e) {}

      // 2. Python ref: CSS selectors (body > div > button.start, button.start, button[type=submit])
      if (!clicked) {
        const cssSelectors = [
          'body > div > button.start',
          'button.start',
          'button[type="submit"]',
          'div button.start',
        ];
        for (const sel of cssSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 800 })) {
              await btn.click();
              clicked = true;
              break;
            }
          } catch (e) {}
        }
      }

      // 3. Python ref: any clickable element with "Продолжить"/"Continue"
      if (!clicked) {
        try {
          clicked = await page.evaluate(() => {
            const els = document.querySelectorAll('button, a, span, div');
            for (const el of els) {
              const text = (el.textContent || '').toLowerCase();
              if ((text.includes('продолжить') || text.includes('continue')) && 
                  el.offsetParent !== null && 
                  ['button', 'a', 'span', 'div'].includes(el.tagName.toLowerCase())) {
                el.scrollIntoView();
                el.click();
                return true;
              }
            }
            return false;
          });
        } catch (e) {}
      }

      // 4. Python ref: Turnstile iframes
      if (!clicked) {
        try {
          const frames = page.frames();
          for (const frame of frames) {
            try {
              const clickedInFrame = await frame.evaluate(() => {
                const els = document.querySelectorAll('button, *[role="button"], input[type="submit"]');
                for (const el of els) {
                  if (el.offsetParent !== null) {
                    el.click();
                    return true;
                  }
                }
                return false;
              });
              if (clickedInFrame) {
                clicked = true;
                break;
              }
            } catch (e) {}
          }
        } catch (e) {}
      }

      // 5. Try ruCaptcha to solve the challenge
      if (!clicked) {
        await this._trySolveCaptchaOnPage(page);
      }

      await this._humanDelay(2000, 3000);
    }
    
    return true;
  }

  /**
   * Clicks "I'm not a robot" / "Я не робот" checkbox
   */
  async _clickNotRobotCheckbox(page) {
    try {
      // Check for visible checkbox
      const clicked = await page.evaluate(() => {
        // Direct checkbox
        const checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"], .checkbox');
        for (const cb of checkboxes) {
          if (cb.offsetParent !== null) {
            cb.click();
            return true;
          }
        }
        // Text-based
        const elements = document.querySelectorAll('*');
        for (const el of elements) {
          const text = (el.textContent || '').toLowerCase();
          if ((text.includes('not a robot') || text.includes('не робот')) && text.length < 50 && el.offsetParent !== null) {
            el.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (clicked) {
        this.log('[VK Login] Clicked not-a-robot checkbox');
        await this._humanDelay(1500, 2500);
      }

      // Try iframes (recaptcha)
      const frames = page.frames();
      for (const frame of frames) {
        try {
          const cb = frame.locator('[role="checkbox"], .rc-anchor-checkbox, input[type="checkbox"]').first();
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
      
      // Positive URL checks
      const loggedInUrls = ['/feed', '/im', '/friends', '/groups', '/music', '/video', '/clips', '/market'];
      if (loggedInUrls.some(u => url.includes(u))) return true;
      
      // User profile page (vk.com/id123...)
      if (/vk\.com\/id\d+/.test(url)) return true;
      
      // Main page when logged in
      if ((url === 'https://vk.com/' || url === 'https://vk.com') && !url.includes('login') && !url.includes('auth')) {
        // Check for logged-in indicators
        const isLoggedIn = await page.evaluate(() => {
          const selectors = [
            'a[href*="/im"]',
            '[class*="TopNavBtn"]',
            'a[href*="/friends"]',
            '#l_pr', // left menu profile link
            '#l_msg', // left menu messages
            '[data-l="userPage"]',
            '.TopNavLink',
            '#top_profile_link',
          ];
          for (const sel of selectors) {
            if (document.querySelector(sel)) return true;
          }
          return false;
        }).catch(() => false);
        
        return isLoggedIn;
      }
      
      return false;
    } catch (e) {
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
          await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this._humanDelay(2000, 4000);
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
          await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this._humanDelay(2000, 4000);
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
        await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 30000 });
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
          await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 15000 });
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
          await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 15000 });
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
          const destinations = ['https://vk.com/video', 'https://vk.com/clips', 'https://vk.com/discover'];
          const dest = destinations[Math.floor(Math.random() * destinations.length)];
          if (!pageAlive()) return;
          await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
          // Search for something
          const queries = ['музыка 2025', 'смешные видео', 'новости', 'рецепты', 'фильмы', 'мемы'];
          const query = queries[Math.floor(Math.random() * queries.length)];
          if (!pageAlive()) return;
          await page.goto('https://vk.com/video', { waitUntil: 'domcontentloaded', timeout: 15000 });
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
          await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 15000 });
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

  async searchAndFindVideo(page, keywords, targetUrl) {
    this.log(`[Search] Searching for video: ${keywords || targetUrl}`);
    
    // Extract video ID from target URL for matching (e.g., "video-224119603_456311034")
    let targetVideoId = null;
    if (targetUrl) {
      const match = targetUrl.match(/(video-?\d+_\d+)/);
      if (match) targetVideoId = match[1];
    }
    
    try {
      await page.goto('https://vk.com/video', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this._humanDelay(2000, 3000);

      if (keywords) {
        const searchInput = page.locator('input[type="search"], input[placeholder*="Поиск"], input[name="q"]').first();
        if (await searchInput.isVisible({ timeout: 5000 })) {
          await this._humanType(page, searchInput, keywords);
          await page.keyboard.press('Enter');
          await this._humanDelay(3000, 5000);

          // Scroll through results a few times to load more
          for (let scroll = 0; scroll < 3; scroll++) {
            await page.mouse.wheel(0, this._randomDelay(300, 600));
            await this._humanDelay(1000, 2000);
          }

          // Look for the target video in results by video ID
          if (targetVideoId) {
            const found = await page.evaluate((videoId) => {
              const links = document.querySelectorAll('a[href*="/video"]');
              for (const link of links) {
                const href = link.href || link.getAttribute('href') || '';
                if (href.includes(videoId)) {
                  link.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  link.click();
                  return { found: true, href };
                }
              }
              return { found: false };
            }, targetVideoId);

            if (found.found) {
              this.log(`[Search] Found target video in results: ${found.href}`);
              await this._humanDelay(2000, 3000);
              return true;
            }
            
            this.log('[Search] Target video not found in search results, navigating directly...');
          }
        }
      }
      
      // Fallback: navigate directly to target URL instead of clicking a random video
      if (targetUrl) {
        this.log(`[Search] Navigating directly to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this._humanDelay(2000, 3000);
        return true;
      }

      return false;
    } catch (error) {
      this.log(`[Search] Error: ${error.message}`);
      // Last resort: navigate directly
      if (targetUrl) {
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await this._humanDelay(2000, 3000);
          return true;
        } catch (e) {}
      }
      return false;
    }
  }

  async watchVideo(page, duration) {
    const settings = this.store.get('settings') || {};
    const watchMin = duration || settings.watchDuration?.min || 30;
    const watchMax = duration || settings.watchDuration?.max || 120;
    const watchTime = this._randomDelay(watchMin, watchMax);
    
    this.log(`[Watch] Watching for ${watchTime} seconds...`);
    
    try {
      // Click play if needed
      try {
        const playBtn = page.locator('.videoplayer_btn_play, [class*="play"], button[aria-label="Play"]').first();
        if (await playBtn.isVisible({ timeout: 2000 })) {
          await playBtn.click();
          await this._humanDelay(500, 1000);
        }
      } catch (e) {}

      // Simulate watching with random mouse movements
      const startTime = Date.now();
      while ((Date.now() - startTime) / 1000 < watchTime) {
        if (page.isClosed()) break;
        
        // Random mouse movement
        const x = this._randomDelay(100, 1800);
        const y = this._randomDelay(100, 900);
        await page.mouse.move(x, y);
        
        // Occasional scroll
        if (Math.random() < 0.1) {
          await page.mouse.wheel(0, this._randomDelay(-100, 100));
        }
        
        await this._humanDelay(3000, 8000);
      }
      
      this.log('[Watch] Done watching');
      return true;
    } catch (error) {
      this.log(`[Watch] Error: ${error.message}`);
      return false;
    }
  }

  async pressLike(page) {
    this.log('[Like] Attempting to like...');
    try {
      const likeSelectors = [
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
      accountIds = [],
    } = task;

    if (!videoUrl) {
      throw new Error('No video URL specified');
    }

    this.log(`[Task] Starting engagement task for: ${videoUrl}`);
    this.log(`[Task] Views: ${viewCount}, Likes: ${likeCount}, Comments: ${commentCount}`);
    this.log(`[Task] Mode: ${useSearch ? 'search' : 'direct'}, Accounts: ${accountIds.length}`);

    const accounts = this.store.get('accounts') || [];
    const comments = this.store.get('comments') || [];
    const maxConcurrency = settings.maxConcurrency || 3;

    // Build operation plan
    const ops = [];
    let opIndex = 0;
    
    for (let i = 0; i < Math.max(viewCount, likeCount, commentCount); i++) {
      const accountId = accountIds[i % accountIds.length];
      const account = accounts.find(a => a.id === accountId);
      if (!account) continue;

      ops.push({
        accountId,
        proxyId: account.proxyId || null,
        shouldLike: i < likeCount,
        shouldComment: i < commentCount,
        commentText: i < commentCount && comments.length > 0 
          ? comments[Math.floor(Math.random() * comments.length)]?.text || ''
          : '',
      });
    }

    this.log(`[Task] Total operations: ${ops.length}, Concurrency: ${maxConcurrency}`);

    const results = { views: 0, likes: 0, comments: 0, errors: 0 };

    // Process in batches
    for (let batchStart = 0; batchStart < ops.length; batchStart += maxConcurrency) {
      if (signal?.aborted) {
        this.log('[Task] Aborted');
        break;
      }

      const batch = ops.slice(batchStart, batchStart + maxConcurrency);
      this.log(`[Task] Batch ${Math.floor(batchStart / maxConcurrency) + 1}/${Math.ceil(ops.length / maxConcurrency)}`);

      const batchPromises = batch.map((op, idx) => {
        return new Promise(async (resolve) => {
          // Stagger start
          await this._humanDelay(idx * 1000, idx * 2000 + 1000);
          
          try {
            const result = await this._executeSingleOp(op, task, settings);
            if (result.viewed) results.views++;
            if (result.liked) results.likes++;
            if (result.commented) results.comments++;
            if (result.error) results.errors++;
          } catch (e) {
            results.errors++;
            this.log(`[Task] Op error: ${e.message}`);
          }

          if (onProgress) {
            onProgress({
              current: batchStart + idx + 1,
              total: ops.length,
              status: result?.error ? 'error' : 'ok',
              message: `Views: ${results.views}, Likes: ${results.likes}, Comments: ${results.comments}, Errors: ${results.errors}`,
            });
          }

          resolve();
        });
      });

      await Promise.all(batchPromises);
    }

    this.log(`[Task] Completed. Views: ${results.views}, Likes: ${results.likes}, Comments: ${results.comments}, Errors: ${results.errors}`);
    return results;
  }

  async _executeSingleOp(op, task, settings) {
    const { accountId, proxyId, shouldLike, shouldComment, commentText } = op;
    const { videoUrl, searchKeywords, useSearch } = task;

    const accounts = this.store.get('accounts') || [];
    const account = accounts.find(a => a.id === accountId);
    if (!account) return { error: 'Account not found' };

    let proxyUrl = null;
    if (proxyId) {
      const proxies = this.store.get('proxies') || [];
      const proxy = proxies.find(p => p.id === proxyId);
      if (proxy) proxyUrl = this._buildProxyUrl(proxy);
    }

    this.log(`[Op] Account: ${account.login?.substring(0, 4) || accountId}***, Proxy: ${proxyUrl ? 'yes' : 'no'}`);

    const cookiesDir = path.join(app.getPath('userData'), 'accounts');
    const statePath = path.join(cookiesDir, `${accountId}_state.json`);
    const cookiesPath = path.join(cookiesDir, `${accountId}_cookies.json`);

    let contextId = null;
    try {
      // Build launch options — use native storageState if available
      const launchOpts = { 
        proxy: proxyUrl,
        headless: settings.headless !== undefined ? settings.headless : false,
      };

      // Prefer storageState (restores cookies + localStorage in one step)
      if (account.hasCookies && fs.existsSync(statePath)) {
        launchOpts.storageStatePath = statePath;
      }

      const { context, contextId: cId } = await this._launchContext(launchOpts);
      contextId = cId;

      const page = await context.newPage();
      const result = { viewed: false, liked: false, commented: false, error: false };

      // Check if session works
      let loggedIn = false;
      if (account.hasCookies) {
        // If no storageState was loaded, try manual cookies
        if (!launchOpts.storageStatePath && fs.existsSync(cookiesPath)) {
          try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            await this._loadCookies(context, cookies);
          } catch (e) {}
        }
          
        await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this._humanDelay(2000, 3000);
        loggedIn = await this._checkVKLogin(page);
        
        if (loggedIn) {
          this.log('[Op] Logged in via saved session');
        }
      }
      
      // If not logged in, do full login
      if (!loggedIn) {
        if (account.authType === 'logpass' && account.login && account.password) {
          this.log('[Op] Performing full login...');
          const loginResult = await this.loginVK(page, account.login, account.password);
          if (loginResult.success) {
            loggedIn = true;
            // Save session for next time
            await this._saveSession(context, accountId);
          } else {
            result.error = true;
            await this._safeClose(contextId);
            return result;
          }
        } else {
          result.error = true;
          await this._safeClose(contextId);
          return result;
        }
      }

      // Warm-up browsing
      if (settings.warmUp) {
        await this.warmUpBrowsing(page);
      }

      // Navigate to video
      if (useSearch && searchKeywords) {
        const found = await this.searchAndFindVideo(page, searchKeywords, videoUrl);
        // If search did not navigate to any video, go directly
        if (!found && videoUrl) {
          this.log('[Op] Search failed, navigating directly to video URL...');
          await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await this._humanDelay(2000, 3000);
        }
      } else {
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this._humanDelay(2000, 3000);
      }

      // Watch video
      const watchDuration = this._randomDelay(
        settings.watchDuration?.min || 30,
        settings.watchDuration?.max || 120
      );
      await this.watchVideo(page, watchDuration);
      result.viewed = true;

      // Like
      if (shouldLike) {
        const liked = await this.pressLike(page);
        result.liked = liked;
      }

      // Comment
      if (shouldComment && commentText) {
        const commented = await this.postComment(page, commentText);
        result.commented = commented;
      }

      await this._safeClose(contextId);
      return result;

    } catch (error) {
      this.log(`[Op] Error: ${error.message}`);
      if (contextId) await this._safeClose(contextId);
      return { viewed: false, liked: false, commented: false, error: true };
    }
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

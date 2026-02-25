/**
 * VK Video Engagement Tool v1.0 — Renderer App
 *
 * Full UI logic: tabs, accounts, proxies, comments, tasks, settings,
 * Best-Proxies.ru panel, modals, log panel.
 */

// ───────── Globals ─────────

let accounts = [];
let proxies = [];
let comments = [];
let commentFolders = [];
let tasks = [];
let settings = {};
let logExpanded = true;
let selectedAccountIds = new Set();
let selectedCommentIds = new Set();

// ───────── Tab Navigation ─────────

const tabButtons = document.querySelectorAll('.nav-btn[data-tab]');
const tabPages = document.querySelectorAll('.tab-page');
const pageTitle = document.getElementById('pageTitle');

const tabTitles = {
  tasks: 'Task Queue',
  accounts: 'VK Accounts',
  proxies: 'Proxies',
  comments: 'Comment Templates',
  settings: 'Settings',
};

function switchTab(tab) {
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  tabPages.forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  pageTitle.textContent = tabTitles[tab] || tab;

  if (tab === 'accounts') loadAccounts();
  if (tab === 'proxies') loadProxies();
  if (tab === 'comments') loadComments();
  if (tab === 'tasks') loadTasks();
  if (tab === 'settings') loadSettings();
}

tabButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ───────── Modal ─────────

const modalBackdrop = document.getElementById('modalBackdrop');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalFooter = document.getElementById('modalFooter');
const modalClose = document.getElementById('modalClose');

function openModal(title, bodyHtml, footerHtml = '', opts = {}) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalFooter.innerHTML = footerHtml;
  modal.classList.toggle('modal-wide', !!opts.wide);
  modalBackdrop.classList.add('active');
}

function closeModal() {
  modalBackdrop.classList.remove('active');
}

modalClose.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ───────── Logging ─────────

const logBody = document.getElementById('logBody');
const logPanel = document.getElementById('logPanel');

function addLog(level, message) {
  const ts = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `<span class="log-time">${ts}</span><span class="log-msg">${escapeHtml(message)}</span>`;
  logBody.appendChild(entry);
  logBody.scrollTop = logBody.scrollHeight;
}

if (window.api) {
  window.api.logs.onEntry(d => addLog(d.level, d.message));
  window.api.logs.onClear(() => { logBody.innerHTML = ''; });
}

document.getElementById('btnToggleLog').addEventListener('click', () => {
  logExpanded = !logExpanded;
  logPanel.classList.toggle('collapsed', !logExpanded);
  document.querySelector('#btnToggleLog i').className = logExpanded ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
});

document.getElementById('btnClearLog').addEventListener('click', () => {
  window.api?.logs.clear();
  logBody.innerHTML = '';
});

// ───────── Helper ─────────

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function statusText(status) {
  const map = { active: 'Active', dead: 'Dead', unknown: 'Unknown', valid: 'Valid', invalid: 'Invalid', blocked: 'Blocked', unchecked: 'Unchecked' };
  return map[status] || status;
}

function showToast(message, type = 'info') {
  addLog(type, message);
}

// ═══════════════════════════════════════════════
//                  ACCOUNTS
// ═══════════════════════════════════════════════

async function loadAccounts() {
  if (!window.api) return;
  accounts = await window.api.account.getAll();
  renderAccounts();
}

function renderAccounts() {
  const tbody = document.getElementById('accountTableBody');
  if (!accounts.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty-state"><i class="fas fa-users"></i><p>No accounts. Import login:pass or paste cookies.</p></div></td></tr>';
    return;
  }
  selectedAccountIds = new Set([...selectedAccountIds].filter(id => accounts.some(a => a.id === id)));
  tbody.innerHTML = accounts.map(a => `
    <tr data-id="${a.id}">
      <td><input type="checkbox" class="acc-cb" data-id="${a.id}" ${selectedAccountIds.has(a.id) ? 'checked' : ''}></td>
      <td class="acc-name-cell" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</td>
      <td><span class="badge ${a.authType === 'logpass' ? 'active' : 'inactive'}">${a.authType === 'logpass' ? 'Login:Pass' : 'Cookies'}</span></td>
      <td>${a.hasCookies ? `<span style="color:var(--success)">${a.cookieCount} cookies</span>` : '<span class="text-muted">--</span>'}</td>
      <td><span class="status-badge ${a.status}">${statusText(a.status)}</span></td>
      <td>
        <button class="btn-icon" title="Verify" onclick="verifyAccount('${a.id}')"><i class="fas fa-check-circle"></i></button>
        <button class="btn-icon" title="Import cookies" onclick="importCookiesForAccount('${a.id}')"><i class="fas fa-cookie"></i></button>
        <button class="btn-icon" title="Remove" onclick="removeAccount('${a.id}')"><i class="fas fa-trash" style="color:var(--danger)"></i></button>
      </td>
    </tr>
  `).join('');

  // Checkbox listeners
  tbody.querySelectorAll('.acc-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedAccountIds.add(cb.dataset.id);
      else selectedAccountIds.delete(cb.dataset.id);
    });
  });
}

document.getElementById('accSelectAll').addEventListener('change', (e) => {
  const checked = e.target.checked;
  document.querySelectorAll('.acc-cb').forEach(cb => {
    cb.checked = checked;
    if (checked) selectedAccountIds.add(cb.dataset.id);
    else selectedAccountIds.delete(cb.dataset.id);
  });
});

// Import Login:Pass
document.getElementById('btnImportLogpass').addEventListener('click', () => {
  openModal('Import Login:Password', `
    <div class="form-group">
      <label>Paste login:password pairs (one per line)</label>
      <textarea id="logpassText" rows="8" placeholder="login1:password1\nlogin2:password2\n..." style="width:100%;font-family:monospace;"></textarea>
    </div>
    <p class="text-sm text-muted">Format: login:password (phone, email, or username).</p>
  `, `<button class="btn btn-primary" id="btnDoImportLogpass"><i class="fas fa-upload"></i> Import</button>`);

  document.getElementById('btnDoImportLogpass').addEventListener('click', async () => {
    const text = document.getElementById('logpassText').value.trim();
    if (!text) return;
    try {
      const r = await window.api.account.importLogpass(text);
      showToast(`Imported ${r.created} accounts from ${r.total} lines`, 'success');
      closeModal();
      loadAccounts();
    } catch (e) { showToast(`Import error: ${e.message}`, 'error'); }
  });
});

// Paste Cookies
document.getElementById('btnImportCookieText').addEventListener('click', () => {
  openModal('Paste Cookies', `
    <div class="form-group">
      <label>Paste cookies (Netscape, JSON, or header format)</label>
      <textarea id="cookieText" rows="10" placeholder="Paste cookies here..." style="width:100%;font-family:monospace;"></textarea>
    </div>
    <p class="text-sm text-muted">Supports: Netscape/TAB, JSON array, JSON object, Cookie header.</p>
  `, `<button class="btn btn-primary" id="btnDoPasteCookies"><i class="fas fa-upload"></i> Import</button>`, { wide: true });

  document.getElementById('btnDoPasteCookies').addEventListener('click', async () => {
    const text = document.getElementById('cookieText').value.trim();
    if (!text) return;
    try {
      const r = await window.api.account.importFromText(text);
      if (r.created) {
        showToast(`Account created: ${r.accounts?.[0]?.name || '?'} (cookies)`, 'success');
        closeModal();
        loadAccounts();
      } else {
        showToast(`Cookie import failed: ${r.error || 'unknown'}`, 'error');
      }
    } catch (e) { showToast(`Import error: ${e.message}`, 'error'); }
  });
});

// Import Cookie Files
document.getElementById('btnImportCookieFiles').addEventListener('click', async () => {
  try {
    const r = await window.api.account.importFromFiles();
    if (r.created) { showToast(`Imported ${r.created} accounts from files`, 'success'); loadAccounts(); }
    else if (r.created === 0) showToast('No accounts created (possibly canceled or no valid cookies)', 'warning');
  } catch (e) { showToast(`File import error: ${e.message}`, 'error'); }
});

// Verify
async function verifyAccount(id) {
  try {
    showToast(`Verifying account...`, 'info');
    await window.api.account.verify(id);
    loadAccounts();
  } catch (e) { showToast(`Verify error: ${e.message}`, 'error'); }
}

document.getElementById('btnVerifyAll').addEventListener('click', async () => {
  const ids = accounts.map(a => a.id);
  if (!ids.length) return;
  showToast(`Verifying ${ids.length} accounts...`, 'info');
  try { await window.api.account.bulkVerify(ids); loadAccounts(); }
  catch (e) { showToast(`Verify error: ${e.message}`, 'error'); }
});

document.getElementById('btnVerifySelected').addEventListener('click', async () => {
  const ids = [...selectedAccountIds];
  if (!ids.length) { showToast('No accounts selected', 'warning'); return; }
  showToast(`Verifying ${ids.length} accounts...`, 'info');
  try { await window.api.account.bulkVerify(ids); loadAccounts(); }
  catch (e) { showToast(`Verify error: ${e.message}`, 'error'); }
});

if (window.api) {
  window.api.account.onVerifyProgress(d => {
    showToast(`Verifying ${d.current}/${d.total}...`, 'info');
  });
}

async function importCookiesForAccount(id) {
  try {
    const r = await window.api.account.importCookies(id);
    if (r) { showToast('Cookies imported', 'success'); loadAccounts(); }
  } catch (e) { showToast(`Cookie import error: ${e.message}`, 'error'); }
}

async function removeAccount(id) {
  try {
    await window.api.account.remove(id);
    selectedAccountIds.delete(id);
    showToast('Account removed', 'info');
    loadAccounts();
  } catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
}

document.getElementById('btnRemoveSelected').addEventListener('click', async () => {
  const ids = [...selectedAccountIds];
  if (!ids.length) { showToast('No accounts selected', 'warning'); return; }
  try {
    await window.api.account.bulkRemove(ids);
    selectedAccountIds.clear();
    showToast(`Removed ${ids.length} accounts`, 'info');
    loadAccounts();
  } catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
});

document.getElementById('btnRemoveInvalid').addEventListener('click', async () => {
  try {
    const r = await window.api.account.removeInvalid();
    showToast(`Removed ${r.removed} invalid/blocked accounts`, 'info');
    loadAccounts();
  } catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
});

// ═══════════════════════════════════════════════
//                  PROXIES
// ═══════════════════════════════════════════════

async function loadProxies() {
  if (!window.api) return;
  proxies = await window.api.proxy.getAll();
  renderProxies();
}

function renderProxies() {
  const tbody = document.getElementById('proxyTableBody');
  if (!proxies.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9"><div class="empty-state"><i class="fas fa-server"></i><p>No proxies. Add manually or fetch from Best-Proxies.ru</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = proxies.map(p => `
    <tr data-id="${p.id}">
      <td><span class="badge ${p.type === 'socks5' || p.type === 'socks4' ? 'active' : 'inactive'}">${p.type.toUpperCase()}</span></td>
      <td style="font-family:monospace;font-size:12px">${escapeHtml(p.host)}</td>
      <td style="font-family:monospace;font-size:12px">${p.port}</td>
      <td>${p.country || p.countryCode || '--'}</td>
      <td>${p.level ? ['', 'High Anon', 'Anon', 'Transparent'][p.level] || p.level : '--'}</td>
      <td><span class="badge ${p.source === 'best-proxies' ? 'active' : 'inactive'}">${p.source}</span></td>
      <td><span class="status-badge ${p.status}">${statusText(p.status)}</span></td>
      <td>${p.latency ? `${p.latency}ms` : '--'}</td>
      <td>
        <button class="btn-icon" title="Test" onclick="testProxy('${p.id}')"><i class="fas fa-bolt"></i></button>
        <button class="btn-icon" title="Remove" onclick="removeProxy('${p.id}')"><i class="fas fa-trash" style="color:var(--danger)"></i></button>
      </td>
    </tr>
  `).join('');
}

// Add Proxy
document.getElementById('btnAddProxy').addEventListener('click', () => {
  openModal('Add Proxy', `
    <div class="form-row">
      <div class="form-group">
        <label>Type</label>
        <select id="proxyType"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Host</label><input type="text" id="proxyHost" placeholder="1.2.3.4"></div>
      <div class="form-group"><label>Port</label><input type="number" id="proxyPort" placeholder="8080"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Username (optional)</label><input type="text" id="proxyUser" placeholder=""></div>
      <div class="form-group"><label>Password (optional)</label><input type="text" id="proxyPass" placeholder=""></div>
    </div>
  `, `<button class="btn btn-primary" id="btnDoAddProxy"><i class="fas fa-plus"></i> Add</button>`);

  document.getElementById('btnDoAddProxy').addEventListener('click', async () => {
    const proxy = {
      type: document.getElementById('proxyType').value,
      host: document.getElementById('proxyHost').value.trim(),
      port: document.getElementById('proxyPort').value.trim(),
      username: document.getElementById('proxyUser').value.trim(),
      password: document.getElementById('proxyPass').value.trim(),
    };
    if (!proxy.host || !proxy.port) { showToast('Host and port required', 'warning'); return; }
    try {
      await window.api.proxy.add(proxy);
      showToast(`Proxy added: ${proxy.host}:${proxy.port}`, 'success');
      closeModal();
      loadProxies();
    } catch (e) { showToast(`Add error: ${e.message}`, 'error'); }
  });
});

// Import Proxies
document.getElementById('btnImportProxies').addEventListener('click', async () => {
  try {
    const r = await window.api.proxy.import();
    if (r.count > 0) { showToast(`Imported ${r.count} proxies`, 'success'); loadProxies(); }
    else showToast('No proxies imported', 'info');
  } catch (e) { showToast(`Import error: ${e.message}`, 'error'); }
});

async function testProxy(id) {
  showToast('Testing proxy...', 'info');
  try {
    const r = await window.api.proxy.test(id);
    loadProxies();
  } catch (e) { showToast(`Test error: ${e.message}`, 'error'); }
}

async function removeProxy(id) {
  try {
    await window.api.proxy.remove(id);
    showToast('Proxy removed', 'info');
    loadProxies();
  } catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
}

// ─── Best-Proxies.ru Panel ───

const bpPanel = document.getElementById('bpPanel');

document.getElementById('btnBestProxies').addEventListener('click', () => {
  const isOpen = bpPanel.style.display !== 'none';
  bpPanel.style.display = isOpen ? 'none' : 'block';
  // Load saved key
  if (!isOpen && settings.bestProxiesKey) {
    document.getElementById('bpApiKey').value = settings.bestProxiesKey;
  }
});

document.getElementById('btnCloseBpPanel').addEventListener('click', () => {
  bpPanel.style.display = 'none';
});

// Fetch Best-Proxies
document.getElementById('btnBpFetch').addEventListener('click', async () => {
  const key = document.getElementById('bpApiKey').value.trim();
  if (!key) { showToast('API key required', 'warning'); return; }

  const opts = { key };
  const type = document.getElementById('bpType').value;
  const level = document.getElementById('bpLevel').value;
  const limit = document.getElementById('bpLimit').value;
  const response = document.getElementById('bpResponse').value;
  const country = document.getElementById('bpCountry').value.trim();
  const speed = document.getElementById('bpSpeed').value;
  const bl = document.getElementById('bpBl').value;

  // Advanced parameters
  const ports = document.getElementById('bpPorts')?.value.trim();
  const pex = document.getElementById('bpPex')?.checked;
  const cex = document.getElementById('bpCex')?.checked;
  const uptime = document.getElementById('bpUptime')?.value.trim();
  const nocascade = document.getElementById('bpNocascade')?.checked;
  const mail = document.getElementById('bpMail')?.checked;
  const google = document.getElementById('bpGoogle')?.checked;
  const mailru = document.getElementById('bpMailru')?.checked;
  const telegram = document.getElementById('bpTelegram')?.checked;
  const avito = document.getElementById('bpAvito')?.checked;
  const format = document.getElementById('bpFormat')?.value || 'json';
  const includeType = document.getElementById('bpIncludeType')?.checked;

  if (type) opts.type = type;
  if (level) opts.level = level;
  if (limit) opts.limit = parseInt(limit);
  if (response) opts.response = parseInt(response);
  if (country) opts.country = country;
  if (speed) opts.speed = speed;
  if (bl) opts.bl = parseInt(bl);
  if (ports) opts.ports = ports;
  if (pex) opts.pex = 1;
  if (cex) opts.cex = 1;
  if (uptime) opts.uptime = uptime;
  if (nocascade) opts.nocascade = 1;
  if (mail) opts.mail = 1;
  if (google) opts.google = 1;
  if (mailru) opts.mailru = 1;
  if (telegram) opts.telegram = 1;
  if (avito) opts.avito = 1;
  if (includeType) opts.includeType = true;
  if (format) opts.format = format;

  const resultDiv = document.getElementById('bpResult');
  resultDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Fetching proxies...';
  showToast('Fetching proxies from Best-Proxies.ru...', 'info');

  try {
    const r = await window.api.proxy.fetchBestProxies(opts);
    resultDiv.innerHTML = `<span style="color:var(--success)"><i class="fas fa-check"></i> Fetched ${r.total}, Added ${r.added}, Skipped ${r.skipped} duplicates</span>`;
    loadProxies();
  } catch (e) {
    resultDiv.innerHTML = `<span style="color:var(--danger)"><i class="fas fa-xmark"></i> ${escapeHtml(e.message)}</span>`;
  }
});

// Stats
document.getElementById('btnBpStats').addEventListener('click', async () => {
  const key = document.getElementById('bpApiKey').value.trim();
  if (!key) { showToast('API key required', 'warning'); return; }
  const resultDiv = document.getElementById('bpResult');
  resultDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading stats...';
  try {
    const stats = await window.api.proxy.getBestProxiesStats(key);
    let html = '<b>Best-Proxies.ru Stats:</b><br>';
    for (const [k, v] of Object.entries(stats)) {
      html += `${escapeHtml(k)}: <b>${typeof v === 'object' ? JSON.stringify(v) : v}</b><br>`;
    }
    resultDiv.innerHTML = html;
  } catch (e) { resultDiv.innerHTML = `<span style="color:var(--danger)">Stats error: ${escapeHtml(e.message)}</span>`; }
});

// Key Info
document.getElementById('btnBpKeyInfo').addEventListener('click', async () => {
  const key = document.getElementById('bpApiKey').value.trim();
  if (!key) { showToast('API key required', 'warning'); return; }
  const resultDiv = document.getElementById('bpResult');
  resultDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading key info...';
  try {
    const info = await window.api.proxy.getBestProxiesKeyInfo(key, 'hours');
    resultDiv.innerHTML = `<b>Key remaining time:</b> ${info.remaining} hours`;
  } catch (e) { resultDiv.innerHTML = `<span style="color:var(--danger)">Key info error: ${escapeHtml(e.message)}</span>`; }
});

// Clear Best-Proxies
document.getElementById('btnBpClear').addEventListener('click', async () => {
  try {
    const r = await window.api.proxy.clearBestProxies();
    showToast(`Cleared ${r.removed} Best-Proxies.ru proxies`, 'info');
    loadProxies();
  } catch (e) { showToast(`Clear error: ${e.message}`, 'error'); }
});

// ═══════════════════════════════════════════════
//                  COMMENTS
// ═══════════════════════════════════════════════

async function loadComments() {
  if (!window.api) return;
  comments = await window.api.comments.getAll();
  commentFolders = await window.api.commentFolders.getAll();
  renderComments();
}

function renderComments() {
  const list = document.getElementById('commentList');
  document.getElementById('commentCounter').textContent = comments.length;

  if (!comments.length && !commentFolders.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><p>No templates</p></div>';
    return;
  }

  let html = '';

  // Comment Folders
  if (commentFolders.length) {
    html += '<div style="margin-bottom:14px">';
    for (const folder of commentFolders) {
      html += `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;overflow:hidden">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(76,117,163,0.08);cursor:pointer" onclick="toggleFolder('${folder.id}')">
            <span><i class="fas fa-folder" style="color:${folder.color};margin-right:8px"></i><b>${escapeHtml(folder.name)}</b> <span class="text-muted text-sm">(${folder.comments.length})</span></span>
            <span>
              <button class="btn-icon" title="Quick import" onclick="event.stopPropagation();quickImportToFolder('${folder.id}')"><i class="fas fa-bolt"></i></button>
              <button class="btn-icon" title="Delete" onclick="event.stopPropagation();deleteFolder('${folder.id}')"><i class="fas fa-trash" style="color:var(--danger)"></i></button>
            </span>
          </div>
          <div id="folder-${folder.id}" style="display:none;padding:8px 14px">
            ${folder.comments.length ? folder.comments.map(c => `
              <div class="comment-item" style="margin-bottom:4px">
                <span class="comment-text">${escapeHtml(c.text)}</span>
                <button class="btn-icon" title="Remove" onclick="removeFolderComment('${folder.id}','${c.id}')"><i class="fas fa-xmark" style="color:var(--danger)"></i></button>
              </div>
            `).join('') : '<p class="text-muted text-sm">Empty folder</p>'}
          </div>
        </div>`;
    }
    html += '</div>';
  }

  // Standalone comments
  if (comments.length) {
    html += comments.map(c => `
      <div class="comment-item">
        <input type="checkbox" class="comment-cb" data-id="${c.id}" ${selectedCommentIds.has(c.id) ? 'checked' : ''}>
        <span class="comment-text">${escapeHtml(c.text)}</span>
        <button class="btn-icon" title="Remove" onclick="removeComment('${c.id}')"><i class="fas fa-trash" style="color:var(--danger)"></i></button>
      </div>
    `).join('');
  }

  list.innerHTML = html;

  // Comment checkboxes
  list.querySelectorAll('.comment-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCommentIds.add(cb.dataset.id);
      else selectedCommentIds.delete(cb.dataset.id);
    });
  });
}

function toggleFolder(folderId) {
  const el = document.getElementById(`folder-${folderId}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// Quick Import Comments
document.getElementById('btnQuickImportComments').addEventListener('click', () => {
  openModal('Quick Import Comments', `
    <div class="form-group">
      <label>Paste comments (one per line, or comma-separated)</label>
      <textarea id="quickCommentText" rows="8" placeholder="Comment 1\nComment 2\nComment 3..." style="width:100%"></textarea>
    </div>
  `, `<button class="btn btn-primary" id="btnDoQuickImport"><i class="fas fa-upload"></i> Import</button>`);

  document.getElementById('btnDoQuickImport').addEventListener('click', async () => {
    const text = document.getElementById('quickCommentText').value.trim();
    if (!text) return;
    try {
      const r = await window.api.comments.quickImport(text);
      showToast(`Imported ${r.count} comments`, 'success');
      closeModal();
      loadComments();
    } catch (e) { showToast(`Import error: ${e.message}`, 'error'); }
  });
});

// Import Comments File
document.getElementById('btnImportCommentsFile').addEventListener('click', async () => {
  try {
    const r = await window.api.comments.importFile();
    if (r.count > 0) { showToast(`Imported ${r.count} comments from file`, 'success'); loadComments(); }
  } catch (e) { showToast(`Import error: ${e.message}`, 'error'); }
});

// Add Comment
document.getElementById('btnAddComment').addEventListener('click', () => {
  openModal('Add Comment Template', `
    <div class="form-group">
      <label>Comment text</label>
      <textarea id="newCommentText" rows="3" placeholder="Your comment template..." style="width:100%"></textarea>
    </div>
  `, `<button class="btn btn-primary" id="btnDoAddComment"><i class="fas fa-plus"></i> Add</button>`);

  document.getElementById('btnDoAddComment').addEventListener('click', async () => {
    const text = document.getElementById('newCommentText').value.trim();
    if (!text) return;
    try {
      await window.api.comments.add({ text });
      showToast('Comment added', 'success');
      closeModal();
      loadComments();
    } catch (e) { showToast(`Add error: ${e.message}`, 'error'); }
  });
});

async function removeComment(id) {
  try { await window.api.comments.remove(id); selectedCommentIds.delete(id); loadComments(); }
  catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
}

document.getElementById('btnRemoveSelectedComments').addEventListener('click', async () => {
  const ids = [...selectedCommentIds];
  if (!ids.length) { showToast('No comments selected', 'warning'); return; }
  try {
    await window.api.comments.bulkRemove(ids);
    selectedCommentIds.clear();
    showToast(`Removed ${ids.length} comments`, 'info');
    loadComments();
  } catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
});

// Folder operations
async function quickImportToFolder(folderId) {
  openModal('Quick Import to Folder', `
    <div class="form-group">
      <label>Paste comments (one per line)</label>
      <textarea id="folderImportText" rows="6" placeholder="Comment 1\nComment 2..." style="width:100%"></textarea>
    </div>
  `, `<button class="btn btn-primary" id="btnDoFolderImport"><i class="fas fa-upload"></i> Import</button>`);

  document.getElementById('btnDoFolderImport').addEventListener('click', async () => {
    const text = document.getElementById('folderImportText').value.trim();
    if (!text) return;
    try {
      const r = await window.api.commentFolders.quickImport(folderId, text);
      showToast(`Imported ${r.count} comments to folder`, 'success');
      closeModal();
      loadComments();
    } catch (e) { showToast(`Import error: ${e.message}`, 'error'); }
  });
}

async function deleteFolder(folderId) {
  try { await window.api.commentFolders.delete(folderId); loadComments(); }
  catch (e) { showToast(`Delete error: ${e.message}`, 'error'); }
}

async function removeFolderComment(folderId, commentId) {
  try { await window.api.commentFolders.removeComment(folderId, commentId); loadComments(); }
  catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
}

// ═══════════════════════════════════════════════
//                   TASKS
// ═══════════════════════════════════════════════

async function loadTasks() {
  if (!window.api) return;
  tasks = await window.api.task.getAll();
  renderTasks();
}

function renderTasks() {
  const list = document.getElementById('taskList');
  if (!tasks.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No tasks yet</p></div>';
    return;
  }
  list.innerHTML = tasks.map(t => {
    const pct = t.progress || 0;
    return `
    <div class="task-card" data-id="${t.id}">
      <div class="task-card-header">
        <span class="task-type engagement"><i class="fas fa-video"></i> VK Video</span>
        <span class="task-status ${t.status}">${t.status}</span>
      </div>
      ${t.videoUrl ? `<div class="task-video-info"><i class="fas fa-link"></i> ${escapeHtml(t.videoUrl)}</div>` : ''}
      <div class="task-engagement-row">
        <span class="engagement-badge views"><i class="fas fa-eye"></i> ${t.viewCount} views</span>
        ${t.likeCount ? `<span class="engagement-badge likes"><i class="fas fa-heart"></i> ${t.likeCount} likes</span>` : ''}
        ${t.commentCount ? `<span class="engagement-badge comments-badge"><i class="fas fa-comment"></i> ${t.commentCount} comments</span>` : ''}
      </div>
      <div class="task-info">
        <span><i class="fas fa-users"></i> ${t.accountIds?.length || 0} accounts</span>
        <span><i class="fas fa-server"></i> ${t.proxyIds?.length || 0} proxies</span>
        <span><i class="fas fa-clock"></i> ${formatDate(t.createdAt)}</span>
        ${t.useSearch ? `<span><i class="fas fa-search"></i> "${escapeHtml(t.searchKeywords || '')}"</span>` : ''}
        ${t.slowSpeed ? `<span><i class="fas fa-gauge-simple"></i> 0.25x</span>` : ''}
        ${t.ghostWatchers ? `<span><i class="fas fa-ghost"></i> Ghost</span>` : ''}
      </div>
      <div class="task-progress"><div class="task-progress-bar" style="width:${pct}%"></div></div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${pct}% — ${t.completedItems || 0}/${t.totalItems || t.viewCount} ops (${t.successItems || 0} ok, ${t.errorItems || 0} err)</div>
      <div class="task-actions">
        ${t.status === 'running' ? `<button class="btn btn-sm btn-danger" onclick="stopTask('${t.id}')"><i class="fas fa-stop"></i> Stop</button>` : `<button class="btn btn-sm btn-success" onclick="startTask('${t.id}')"><i class="fas fa-play"></i> Start</button>`}
        <button class="btn btn-sm btn-secondary" onclick="removeTask('${t.id}')"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;
  }).join('');
}

// Task progress updates
if (window.api) {
  window.api.task.onProgress(d => {
    const card = document.querySelector(`.task-card[data-id="${d.taskId}"]`);
    if (card) {
      const bar = card.querySelector('.task-progress-bar');
      if (bar) bar.style.width = `${d.progress || 0}%`;
    }
    // Reload task list to reflect latest state
    loadTasks();
  });
}

// Create Task
document.getElementById('btnCreateTask').addEventListener('click', async () => {
  // Refresh data
  await loadAccounts();
  await loadProxies();
  await loadComments();

  const accountCheckboxes = accounts.map(a => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0">
      <input type="checkbox" class="task-acc-cb" value="${a.id}" ${a.status === 'valid' ? 'checked' : ''}> ${escapeHtml(a.name)} <span class="status-badge ${a.status}" style="font-size:9px">${a.status}</span>
    </label>
  `).join('') || '<p class="text-muted text-sm">No accounts</p>';

  const proxyCheckboxes = proxies.map(p => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0">
      <input type="checkbox" class="task-proxy-cb" value="${p.id}" ${p.status === 'active' ? 'checked' : ''}> ${p.type.toUpperCase()} ${escapeHtml(p.host)}:${p.port} <span class="status-badge ${p.status}" style="font-size:9px">${p.status}</span>
    </label>
  `).join('') || '<p class="text-muted text-sm">No proxies</p>';

  const folderOptions = commentFolders.map(f =>
    `<option value="${f.id}">${escapeHtml(f.name)} (${f.comments.length})</option>`
  ).join('');

  openModal('Create Engagement Task', `
    <div class="form-group">
      <label>VK Video URL</label>
      <input type="text" id="taskVideoUrl" placeholder="https://vk.com/video-12345_67890" style="width:100%">
    </div>
    <div class="form-row">
      <div class="form-group"><label>Views</label><input type="number" id="taskViews" value="1" min="1"></div>
      <div class="form-group"><label>Likes</label><input type="number" id="taskLikes" value="0" min="0"></div>
      <div class="form-group"><label>Comments</label><input type="number" id="taskComments" value="0" min="0"></div>
    </div>
    <div class="form-group checkbox-group">
      <label><input type="checkbox" id="taskUseSearch"><span>Search video by keywords (instead of direct URL)</span></label>
    </div>
    <div class="form-group" id="taskSearchGroup" style="display:none">
      <label>Search Keywords</label>
      <input type="text" id="taskSearchKeywords" placeholder="e.g. funny video 2025" style="width:100%">
      <div style="margin-top:6px;display:flex;align-items:center;gap:8px">
        <label style="font-size:11px;white-space:nowrap">Max scrolls (0 = scroll until found):</label>
        <input type="number" id="taskSearchScrolls" value="0" min="0" max="200" style="width:70px;font-size:12px">
      </div>
    </div>
    <div class="form-group">
      <label>Comment Folder (optional)</label>
      <select id="taskCommentFolder" style="width:100%">
        <option value="">Use global comment templates</option>
        ${folderOptions}
      </select>
    </div>
    <div class="form-group checkbox-group">
      <label><input type="checkbox" id="taskAllowDirect"><span>Allow direct connection (no proxy)</span></label>
    </div>
    <div class="form-group checkbox-group">
      <label><input type="checkbox" id="taskSlowSpeed"><span>Slow playback speed (0.25x) \u2014 longer watch, more retention</span></label>
    </div>
    <div class="form-group checkbox-group">
      <label><input type="checkbox" id="taskGhostWatchers"><span>\ud83d\udc7b Ghost Watchers \u2014 use unused proxies to view video anonymously (no login, no like/comment, vkvideo.ru only)</span></label>
    </div>
    <div class="form-group">
      <label>Accounts</label>
      <div style="max-height:120px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;font-weight:600;border-bottom:1px solid var(--border);margin-bottom:4px">
          <input type="checkbox" id="taskAccSelectAll" checked> Select All
        </label>
        ${accountCheckboxes}
      </div>
    </div>
    <div class="form-group">
      <label>Proxies</label>
      <div style="max-height:120px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;font-weight:600;border-bottom:1px solid var(--border);margin-bottom:4px">
          <input type="checkbox" id="taskProxySelectAll" checked> Select All
        </label>
        ${proxyCheckboxes}
      </div>
    </div>
  `, `<button class="btn btn-primary" id="btnDoCreateTask"><i class="fas fa-rocket"></i> Create Task</button>`, { wide: true });

  // Search toggle
  document.getElementById('taskUseSearch').addEventListener('change', (e) => {
    document.getElementById('taskSearchGroup').style.display = e.target.checked ? 'block' : 'none';
  });

  // Select all toggles
  document.getElementById('taskAccSelectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.task-acc-cb').forEach(cb => cb.checked = e.target.checked);
  });
  document.getElementById('taskProxySelectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.task-proxy-cb').forEach(cb => cb.checked = e.target.checked);
  });
  // Uncheck "Select All" if any individual checkbox is unchecked
  document.querySelectorAll('.task-acc-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const all = document.querySelectorAll('.task-acc-cb');
      const checked = document.querySelectorAll('.task-acc-cb:checked');
      document.getElementById('taskAccSelectAll').checked = (all.length === checked.length);
    });
  });
  document.querySelectorAll('.task-proxy-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const all = document.querySelectorAll('.task-proxy-cb');
      const checked = document.querySelectorAll('.task-proxy-cb:checked');
      document.getElementById('taskProxySelectAll').checked = (all.length === checked.length);
    });
  });

  // Create
  document.getElementById('btnDoCreateTask').addEventListener('click', async () => {
    const videoUrl = document.getElementById('taskVideoUrl').value.trim();
    const viewCount = parseInt(document.getElementById('taskViews').value) || 1;
    const likeCount = parseInt(document.getElementById('taskLikes').value) || 0;
    const commentCount = parseInt(document.getElementById('taskComments').value) || 0;
    const useSearch = document.getElementById('taskUseSearch').checked;
    const searchKeywords = document.getElementById('taskSearchKeywords').value.trim();
    const searchScrollCount = parseInt(document.getElementById('taskSearchScrolls')?.value) || 0;
    const commentFolderId = document.getElementById('taskCommentFolder').value || null;
    const allowDirect = document.getElementById('taskAllowDirect').checked;
    const slowSpeed = document.getElementById('taskSlowSpeed').checked;
    const ghostWatchers = document.getElementById('taskGhostWatchers').checked;
    const accountIds = [...document.querySelectorAll('.task-acc-cb:checked')].map(cb => cb.value);
    const proxyIds = [...document.querySelectorAll('.task-proxy-cb:checked')].map(cb => cb.value);

    if (!videoUrl) { showToast('Video URL required', 'warning'); return; }
    if (!accountIds.length) { showToast('Select at least 1 account', 'warning'); return; }
    if (useSearch && !searchKeywords) { showToast('Search keywords required when search is enabled', 'warning'); return; }
    if (accountIds.length > viewCount) {
      showToast(`Note: ${accountIds.length} accounts selected but only ${viewCount} views requested. Only ${viewCount} will be used.`, 'info');
    }

    try {
      await window.api.task.create({
        videoUrl, viewCount, likeCount, commentCount,
        useSearch, searchKeywords, searchScrollCount, commentFolderId,
        allowDirect, slowSpeed, ghostWatchers, accountIds, proxyIds,
      });
      showToast('Task created', 'success');
      closeModal();
      loadTasks();
    } catch (e) { showToast(`Create error: ${e.message}`, 'error'); }
  });
});

async function startTask(id) {
  try { await window.api.task.start(id); loadTasks(); }
  catch (e) { showToast(`Start error: ${e.message}`, 'error'); }
}

async function stopTask(id) {
  try { await window.api.task.stop(id); loadTasks(); }
  catch (e) { showToast(`Stop error: ${e.message}`, 'error'); }
}

async function removeTask(id) {
  try { await window.api.task.remove(id); loadTasks(); }
  catch (e) { showToast(`Remove error: ${e.message}`, 'error'); }
}

document.getElementById('btnStartAll').addEventListener('click', async () => {
  try { await window.api.task.startAll(); loadTasks(); }
  catch (e) { showToast(`Start all error: ${e.message}`, 'error'); }
});

document.getElementById('btnStopAll').addEventListener('click', async () => {
  try { await window.api.task.stopAll(); loadTasks(); }
  catch (e) { showToast(`Stop all error: ${e.message}`, 'error'); }
});

// ═══════════════════════════════════════════════
//                  SETTINGS
// ═══════════════════════════════════════════════

async function loadSettings() {
  if (!window.api) return;
  settings = await window.api.settings.get() || {};

  document.getElementById('bestProxiesKey').value = settings.bestProxiesKey || '';
  document.getElementById('ruCaptchaKey').value = settings.ruCaptchaKey || '';
  document.getElementById('typingDelayMin').value = settings.typingDelay?.min || 50;
  document.getElementById('typingDelayMax').value = settings.typingDelay?.max || 150;
  // watchDuration min/max removed — video is now watched in full (auto-detected)
  document.getElementById('maxConcurrency').value = settings.maxConcurrency || 3;
  document.getElementById('headlessMode').checked = !!settings.headless;

  const wu = settings.warmUp || {};
  document.getElementById('warmUpHomeMin').value = wu.homePageMin || 3;
  document.getElementById('warmUpHomeMax').value = wu.homePageMax || 8;
  document.getElementById('warmUpScrollMin').value = wu.scrollPauseMin || 1.5;
  document.getElementById('warmUpScrollMax').value = wu.scrollPauseMax || 5;
  document.getElementById('warmUpVideoMin').value = wu.videoWatchMin || 5;
  document.getElementById('warmUpVideoMax').value = wu.videoWatchMax || 25;

  const sw = wu.scenarioWeight || {};
  document.getElementById('warmUpWChill').value = sw.chill || 30;
  document.getElementById('warmUpWCurious').value = sw.curious || 25;
  document.getElementById('warmUpWExplorer').value = sw.explorer || 20;
  document.getElementById('warmUpWSearcher').value = sw.searcher || 15;
  document.getElementById('warmUpWImpatient').value = sw.impatient || 10;
}

document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const newSettings = {
    bestProxiesKey: document.getElementById('bestProxiesKey').value.trim(),
    ruCaptchaKey: document.getElementById('ruCaptchaKey').value.trim(),
    typingDelay: {
      min: parseInt(document.getElementById('typingDelayMin').value) || 50,
      max: parseInt(document.getElementById('typingDelayMax').value) || 150,
    },
    // watchDuration min/max removed — video is watched in full (auto-detected)
    watchDuration: { min: 0, max: 0 },
    maxConcurrency: parseInt(document.getElementById('maxConcurrency').value) || 3,
    headless: document.getElementById('headlessMode').checked,
    stealth: true,
    warmUp: {
      homePageMin: parseFloat(document.getElementById('warmUpHomeMin').value) || 3,
      homePageMax: parseFloat(document.getElementById('warmUpHomeMax').value) || 8,
      scrollPauseMin: parseFloat(document.getElementById('warmUpScrollMin').value) || 1.5,
      scrollPauseMax: parseFloat(document.getElementById('warmUpScrollMax').value) || 5,
      videoWatchMin: parseFloat(document.getElementById('warmUpVideoMin').value) || 5,
      videoWatchMax: parseFloat(document.getElementById('warmUpVideoMax').value) || 25,
      scenarioWeight: {
        chill: parseInt(document.getElementById('warmUpWChill').value) || 30,
        curious: parseInt(document.getElementById('warmUpWCurious').value) || 25,
        explorer: parseInt(document.getElementById('warmUpWExplorer').value) || 20,
        searcher: parseInt(document.getElementById('warmUpWSearcher').value) || 15,
        impatient: parseInt(document.getElementById('warmUpWImpatient').value) || 10,
      },
    },
  };
  try {
    await window.api.settings.save(newSettings);
    settings = newSettings;
    showToast('Settings saved', 'success');
  } catch (e) { showToast(`Save error: ${e.message}`, 'error'); }
});

// ───────── Init ─────────

(async () => {
  await loadTasks();
  await loadSettings();
  addLog('info', 'VK Video Engagement Tool v1.0 ready. Best-Proxies.ru API + VK multi-account.');
})();

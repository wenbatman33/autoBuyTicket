'use strict';

// Default settings
const DEFAULTS = {
  enabled: false,
  saleStartTime: '',
  tickets: [],           // [{name, qty}] priority order
  pollInterval: 1500,
  autoAgree: true,
  autoNext: true,
  autoApiSubmit: false,
};

let settings = { ...DEFAULTS };
let countdownTimer = null;
let dragSrcIndex = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(null);
  settings = { ...DEFAULTS, ...stored };
  buildDatetimeSelects();
  renderAll();
  startCountdown();
  bindEvents();
});

// ─── Datetime Selects ─────────────────────────────────────────────────────────
function buildDatetimeSelects() {
  const now = new Date();
  const cy = now.getFullYear();

  // Year: current ~ +2
  populateSelect('dtYear', range(cy, cy + 2), v => v, v => v + '年');
  // Month
  populateSelect('dtMonth', range(1, 12), v => pad(v), v => pad(v) + '月');
  // Day (will be updated on month change)
  populateDays();
  // Hour
  populateSelect('dtHour', range(0, 23), v => pad(v), v => pad(v) + '時');
  // Minute
  populateSelect('dtMinute', range(0, 59), v => pad(v), v => pad(v) + '分');
}

function populateSelect(id, values, toVal, toLabel) {
  const sel = document.getElementById(id);
  const current = sel.value;
  sel.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = toVal(v);
    opt.textContent = toLabel(v);
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

function populateDays() {
  const year = Number(document.getElementById('dtYear').value) || new Date().getFullYear();
  const month = Number(document.getElementById('dtMonth').value) || 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const current = document.getElementById('dtDay').value;
  populateSelect('dtDay', range(1, daysInMonth), v => pad(v), v => pad(v) + '日');
  // restore value if still valid
  const dayNum = Number(current);
  if (dayNum >= 1 && dayNum <= daysInMonth) {
    document.getElementById('dtDay').value = pad(dayNum);
  }
}

function range(from, to) {
  const arr = [];
  for (let i = from; i <= to; i++) arr.push(i);
  return arr;
}

function getDatetimeValue() {
  const y = document.getElementById('dtYear').value;
  const mo = document.getElementById('dtMonth').value;
  const d = document.getElementById('dtDay').value;
  const h = document.getElementById('dtHour').value;
  const mi = document.getElementById('dtMinute').value;
  if (!y || !mo || !d) return '';
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
}

function setDatetimeValue(isoStr) {
  if (!isoStr) return;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return;
  document.getElementById('dtYear').value = String(d.getFullYear());
  document.getElementById('dtMonth').value = pad(d.getMonth() + 1);
  populateDays();
  document.getElementById('dtDay').value = pad(d.getDate());
  document.getElementById('dtHour').value = pad(d.getHours());
  document.getElementById('dtMinute').value = pad(d.getMinutes());
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderAll() {
  document.getElementById('masterToggle').checked = settings.enabled;
  setDatetimeValue(settings.saleStartTime || '');
  document.getElementById('pollInterval').value = settings.pollInterval;
  document.getElementById('pollIntervalDisplay').textContent = settings.pollInterval + 'ms';
  document.getElementById('autoAgree').checked = settings.autoAgree;
  document.getElementById('autoNext').checked = settings.autoNext;
  document.getElementById('autoApiSubmit').checked = settings.autoApiSubmit;
  renderTicketList();
}

function renderTicketList() {
  const list = document.getElementById('ticketList');
  list.innerHTML = '';
  if (!settings.tickets.length) {
    list.innerHTML = '<div style="color:#555;font-size:11px;text-align:center;padding:8px;">尚未新增票券（新增後將依序嘗試）</div>';
    return;
  }
  settings.tickets.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'ticket-item';
    item.draggable = true;
    item.dataset.index = i;
    item.innerHTML = `
      <span class="ticket-priority">${i + 1}</span>
      <span class="ticket-drag-handle">⠿</span>
      <span class="ticket-name" title="${escHtml(t.name)}">${escHtml(t.name)}</span>
      <span class="ticket-qty-badge">${t.qty} 張</span>
      <button class="ticket-delete" data-index="${i}" title="刪除">✕</button>
    `;
    // Drag events
    item.addEventListener('dragstart', onDragStart);
    item.addEventListener('dragover', onDragOver);
    item.addEventListener('drop', onDrop);
    item.addEventListener('dragend', onDragEnd);
    // Delete
    item.querySelector('.ticket-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      settings.tickets.splice(Number(e.currentTarget.dataset.index), 1);
      renderTicketList();
    });
    list.appendChild(item);
  });
}

// ─── Drag & Drop (reorder) ────────────────────────────────────────────────────
function onDragStart(e) {
  dragSrcIndex = Number(e.currentTarget.dataset.index);
  e.currentTarget.classList.add('dragging');
}
function onDragOver(e) {
  e.preventDefault();
  document.querySelectorAll('.ticket-item').forEach(el => el.classList.remove('drag-over'));
  e.currentTarget.classList.add('drag-over');
}
function onDrop(e) {
  e.preventDefault();
  const targetIndex = Number(e.currentTarget.dataset.index);
  if (dragSrcIndex !== null && dragSrcIndex !== targetIndex) {
    const [moved] = settings.tickets.splice(dragSrcIndex, 1);
    settings.tickets.splice(targetIndex, 0, moved);
    renderTicketList();
  }
}
function onDragEnd(e) {
  dragSrcIndex = null;
  document.querySelectorAll('.ticket-item').forEach(el => {
    el.classList.remove('dragging', 'drag-over');
  });
}

// ─── Countdown ────────────────────────────────────────────────────────────────
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
  const el = document.getElementById('countdown');
  const val = getDatetimeValue();
  if (!val) {
    el.textContent = '尚未設定開賣時間';
    el.style.color = '#555';
    return;
  }
  const diff = new Date(val).getTime() - Date.now();
  if (diff <= 0) {
    el.textContent = '🔴 開賣中！';
    el.style.color = '#e94560';
    return;
  }
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  el.textContent = `⏱ ${pad(h)}:${pad(m)}:${pad(s)}`;
  el.style.color = diff < 60000 ? '#ff9800' : '#4caf50';
}

function pad(n) { return String(n).padStart(2, '0'); }

// ─── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('masterToggle').addEventListener('change', (e) => {
    settings.enabled = e.target.checked;
  });

  // 監聽所有日期時間下拉選單
  ['dtYear', 'dtMonth', 'dtDay', 'dtHour', 'dtMinute'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      if (id === 'dtYear' || id === 'dtMonth') populateDays();
      settings.saleStartTime = getDatetimeValue();
      updateCountdown();
    });
  });

  document.getElementById('pollInterval').addEventListener('input', (e) => {
    settings.pollInterval = Number(e.target.value);
    document.getElementById('pollIntervalDisplay').textContent = e.target.value + 'ms';
  });

  document.getElementById('autoAgree').addEventListener('change', (e) => {
    settings.autoAgree = e.target.checked;
  });
  document.getElementById('autoNext').addEventListener('change', (e) => {
    settings.autoNext = e.target.checked;
  });
  document.getElementById('autoApiSubmit').addEventListener('change', (e) => {
    settings.autoApiSubmit = e.target.checked;
  });

  document.getElementById('addTicketBtn').addEventListener('click', addTicket);
  document.getElementById('newTicketName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTicket();
  });

  document.getElementById('saveBtn').addEventListener('click', saveSettings);
}

function addTicket() {
  const nameEl = document.getElementById('newTicketName');
  const qtyEl = document.getElementById('newTicketQty');
  const name = nameEl.value.trim();
  const qty = Math.max(1, Math.min(10, Number(qtyEl.value) || 1));
  if (!name) {
    nameEl.focus();
    return;
  }
  settings.tickets.push({ name, qty });
  nameEl.value = '';
  qtyEl.value = '1';
  renderTicketList();
  nameEl.focus();
}

async function saveSettings() {
  // 若輸入欄有未送出的票名，自動加入清單再儲存
  const pendingName = document.getElementById('newTicketName').value.trim();
  if (pendingName) addTicket();

  // Read latest checkbox states
  settings.enabled = document.getElementById('masterToggle').checked;
  settings.saleStartTime = getDatetimeValue();
  settings.pollInterval = Number(document.getElementById('pollInterval').value);
  settings.autoAgree = document.getElementById('autoAgree').checked;
  settings.autoNext = document.getElementById('autoNext').checked;
  settings.autoApiSubmit = document.getElementById('autoApiSubmit').checked;

  await chrome.storage.local.set(settings);

  // Notify active KKTix tabs
  const tabs = await chrome.tabs.query({ url: '*://*.kktix.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
  }

  const statusEl = document.getElementById('saveStatus');
  statusEl.textContent = '✅ 設定已儲存';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

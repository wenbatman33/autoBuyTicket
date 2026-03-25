'use strict';

// Content Script

const STATE = {
  IDLE: 'idle',
  WAITING: 'waiting',
  POLLING: 'polling',
  FILLING: 'filling',
  QUEUING: 'queuing',
  DONE: 'done',
  STOPPED: 'stopped',
};

let state = STATE.IDLE;
let settings = null;
let pollTimer = null;
let backoffMs = 0;
let pollCount = 0;
let overlay = null;
let observer = null;

(async function init() {
  settings = await loadSettings();
  injectOverlay();
  if (!settings.enabled) {
    updateOverlay(STATE.IDLE, '插件已停用');
    return;
  }
  if (isSeatingPage()) {
    handleSeatingPage();
    return;
  }

  startAutomation();
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SETTINGS_UPDATED') {
    settings = msg.settings;
    if (!settings.enabled) {
      stop('插件已停用');
    } else if (state === STATE.IDLE || state === STATE.STOPPED) {
      startAutomation();
    }
  }
});

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (data) => {
      resolve({
        enabled: false,
        saleStartTime: '',
        tickets: [],
        pollInterval: 1500,
        autoAgree: true,
        autoNext: true,
        autoApiSubmit: false,
        ...data,
      });
    });
  });
}

function isSeatingPage() {
  return /\/registrations\/(?!new$)[^/]+/.test(location.pathname);
}

async function handleSeatingPage() {
  setState(STATE.FILLING);
  updateOverlay(STATE.FILLING, '選座頁面，處理中…');
  log('進入選座頁面，尋找按鈕');

  const computerKeywords = ['電腦配位', '電腦選位'];
  const confirmKeywords = ['完成選位', '確認座位'];
  const dismissKeywords = ['知道了'];
  for (let i = 0; i < 34; i++) {
    await randomDelay(300, 300);

    const btns = Array.from(document.querySelectorAll(
      'button, input[type="submit"], a.btn, a[class*="btn"], [role="button"], a[ng-click]'
    ));
    if (i % 3 === 0) {
      const btnTexts = btns.map(b => b.textContent.trim()).filter(t => t).join(' | ');
      log(`選座頁掃描 #${i+1}，${btns.length} 個按鈕：${btnTexts.slice(0, 300)}`);
    }
    for (const kw of computerKeywords) {
      for (const btn of btns) {
        if (btn.textContent.trim().includes(kw) && !btn.disabled) {
          log(`點擊電腦配位按鈕：${btn.textContent.trim()}`);
          btn.click();
          updateOverlay(STATE.DONE, '✅ 電腦配位完成，請填寫資料');
          setState(STATE.DONE);
          chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: '電腦配位完成' }).catch(() => {});
          return;
        }
      }
    }
    for (const btn of btns) {
      const t = btn.textContent.trim();
      if (dismissKeywords.some(kw => t === kw || t.startsWith(kw)) && !btn.disabled) {
        log(`關閉提示 modal：${t.slice(0, 30)}`);
        btn.click();
        break;
      }
    }
    if (i >= 10) {
      for (const kw of confirmKeywords) {
        for (const btn of btns) {
          if (btn.textContent.trim().startsWith(kw) && !btn.disabled) {
            log(`嘗試點擊確認按鈕：${btn.textContent.trim()}`);
            btn.click();
            updateOverlay(STATE.DONE, '✅ 已點擊確認選座，請確認付款流程');
            setState(STATE.DONE);
            chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: '選座完成' }).catch(() => {});
            return;
          }
        }
      }
    }
  }

  updateOverlay(STATE.STOPPED, '⚠️ 請手動選座完成購票');
  log('未找到可自動點擊的選座按鈕，請手動操作');
}

function startAutomation() {
  if (state === STATE.DONE) return;
  const saleTime = settings.saleStartTime ? new Date(settings.saleStartTime).getTime() : null;
  const now = Date.now();

  if (saleTime && now < saleTime - 500) {
    setState(STATE.WAITING);
    scheduleWaitLoop(saleTime);
  } else {
    beginPolling();
  }
}
function scheduleWaitLoop(saleTime) {
  clearTimer();
  const remaining = saleTime - Date.now();
  updateOverlay(STATE.WAITING, formatCountdown(remaining));
  if (remaining <= 2000 && remaining > 0) {
    updateOverlay(STATE.WAITING, '即將重整頁面…');
    log(`開賣前 ${Math.round(remaining)}ms，重整頁面`);
    pollTimer = setTimeout(() => location.reload(), remaining - 100);
    return;
  }

  if (remaining <= 0) {
    beginPolling();
    return;
  }
  const tickInterval = remaining > 5000 ? 1000 : 200;
  pollTimer = setTimeout(() => scheduleWaitLoop(saleTime), tickInterval);
}
function beginPolling() {
  setState(STATE.POLLING);
  backoffMs = 0;
  pollCount = 0;
  pollCycle();
}

async function pollCycle() {
  if (state !== STATE.POLLING) return;
  pollCount++;
  updateOverlay(STATE.POLLING, `第 ${pollCount} 次探測…`);

  try {
    if (hasTicketsAvailable(document)) {
      setState(STATE.FILLING);
      updateOverlay(STATE.FILLING, '偵測到票券，立即填表…');
      await tryFillCurrentPage();
      return;
    }
    const html = await fetchPage();
    const doc = parseHTML(html);

    if (hasTicketsAvailable(doc)) {
      setState(STATE.FILLING);
      updateOverlay(STATE.FILLING, '伺服器有票，等待頁面更新…');
      observeAndFill();
    } else {
      scheduleNextPoll();
    }
  } catch (err) {
    if (err.status === 429 || err.status === 503) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 2000, 30000);
      updateOverlay(STATE.POLLING, `被限速，等待 ${backoffMs / 1000}s…`);
      pollTimer = setTimeout(pollCycle, backoffMs);
    } else {
      scheduleNextPoll();
    }
  }
}

function scheduleNextPoll() {
  if (state !== STATE.POLLING) return;
  const base = settings.pollInterval || 1500;
  const jitter = Math.floor(Math.random() * 600) - 300; // ±300ms
  const delay = Math.max(300, base + jitter);
  pollTimer = setTimeout(pollCycle, delay);
}

async function fetchPage() {
  const resp = await fetch(location.href, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
    },
  });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.text();
}

function parseHTML(html) {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}

const NO_TICKET_TEXTS = [
  '目前沒有任何可以購買的票卷',
  '目前沒有任何可以購買的票券',
  '沒有可購買的票',
  'No tickets available',
];

function hasTicketsAvailable(doc) {
  const plusBtns = findAvailablePlusButtons(doc);
  if (plusBtns.length > 0) { log(`hasTickets: 找到 ${plusBtns.length} 個 + 按鈕`); return true; }
  const proceedBtn = findProceedButton(doc);
  if (proceedBtn && !proceedBtn.disabled) { log('hasTickets: 找到下一步按鈕'); return true; }
  const quantities = doc.querySelectorAll('select[name*="quantity"], input[name*="quantity"]');
  if (quantities.length > 0) { log(`hasTickets: 找到 ${quantities.length} 個數量欄位`); return true; }
  const bodyText = (doc.body || doc).textContent;
  const matched = NO_TICKET_TEXTS.find(t => bodyText.includes(t));
  if (matched) { log(`hasTickets: 全頁無票文字「${matched}」`); return false; }

  log('hasTickets: 無票（plusBtns=0, proceedBtn=null, quantities=0, 無售完文字）');
  return false;
}
function findAvailablePlusButtons(doc) {
  return Array.from(doc.querySelectorAll('button.plus:not([disabled])'));
}

function findTicketRows(doc) {
  const plusBtns = findAvailablePlusButtons(doc);
  const rows = new Set();
  for (const btn of plusBtns) {
    const row = btn.closest('li, tr, [class*="ticket"], [class*="row"], [class*="item"]');
    if (row) rows.add(row);
  }
  if (rows.size > 0) return Array.from(rows);
  const selectors = [
    '[data-ticket-type-id]',
    '[class*="ticket-type"]',
    '[class*="ticket_type"]',
    'li[class*="ticket"]',
    '.registration-ticket-type',
  ];
  for (const sel of selectors) {
    const nodes = doc.querySelectorAll(sel);
    if (nodes.length) return Array.from(nodes);
  }
  return [];
}
function findProceedButton(doc) {
  const keywords = ['電腦配位', '電腦選位', '自行選位', '選位', '下一步', '繼續', 'Next'];
  const btns = doc.querySelectorAll(
    'button, input[type="submit"], a.btn, a[class*="btn"], [role="button"], a[href*="seating"], a[ng-click]'
  );
  log(`findProceedButton: 掃描 ${btns.length} 個元素`);
  for (const kw of keywords) {
    for (const btn of btns) {
      const text = btn.textContent.trim();
      if (text.includes(kw) && !btn.disabled) {
        log(`findProceedButton: 找到「${text}」(${btn.tagName}.${btn.className})`);
        return btn;
      }
    }
  }
  return null;
}

async function fillForm(doc) {
  const isCurrentPage = (doc === document);

  if (!isCurrentPage) {
    observeAndFill();
    return;
  }
  await tryFillCurrentPage();
}

async function tryFillCurrentPage() {
  if (settings.autoAgree) {
    checkAgreementCheckbox(document);
  }
  const selected = selectTicketsByPriority(document);

  if (!selected) {
    setState(STATE.POLLING);
    scheduleNextPoll();
    return;
  }
  await randomDelay(150, 300);

  log(`設定狀態 autoApiSubmit=${settings.autoApiSubmit} autoNext=${settings.autoNext}`);
  if (settings.autoApiSubmit) {
    const submitted = await tryApiSubmit(document);
    if (submitted) return;
  }
  if (settings.autoNext) {
    clickProceedButton(document);
  } else {
    log('autoNext 已關閉，跳過點擊按鈕');
  }
}

function selectTicketsByPriority(doc) {
  if (!settings.tickets || settings.tickets.length === 0) {
    log('selectTickets: 未設定項目清單');
    stop('未設定項目清單，請先新增項目');
    return false;
  }

  log('selectTickets: 優先清單', JSON.stringify(settings.tickets));
  for (const { name, qty } of settings.tickets) {
    if (trySelectTicket(doc, name, qty)) {
      log(`已選票：${name} x${qty}`);
      return true;
    }
    log(`找不到「${name}」，嘗試下一個`);
  }
  log('no match, retry');
  return false;
}

function selectFirstAvailableTicket(doc) {
  const plusBtns = findAvailablePlusButtons(doc);
  if (plusBtns.length > 0) {
    const btn = plusBtns[0];
    const unit = btn.closest('.ticket-unit') ||
                 btn.closest('li, tr, [class*="ticket"], [class*="row"], [class*="item"]') ||
                 btn.parentElement;
    angularAddQuantity(btn, unit, 1);
    return true;
  }
  return false;
}

function trySelectTicket(doc, nameKeyword, qty) {
  
  const units = doc.querySelectorAll('.ticket-unit');
  log(`trySelectTicket: .ticket-unit 找到 ${units.length} 個，搜尋「${nameKeyword}」`);
  for (const unit of units) {
    if (!unit.textContent.includes(nameKeyword)) continue;

    const plusBtn = unit.querySelector('button.plus:not([disabled])');
    if (!plusBtn) {
      log(`「${nameKeyword}」已售完或不可選`);
      continue;
    }

    angularAddQuantity(plusBtn, unit, qty);
    log(`已選票：${nameKeyword} x${qty}`);
    return true;
  }
  const ROW_SELECTORS = 'li, tr, [class*="ticket-unit"], [class*="ticket_type"], [class*="ticket-row"]';
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.includes(nameKeyword)) continue;
    let el = node.parentElement;
    let rowContainer = null;
    for (let d = 0; d < 8 && el && el !== doc.body; d++) {
      if (el.matches(ROW_SELECTORS)) { rowContainer = el; break; }
      el = el.parentElement;
    }
    if (!rowContainer) continue;
    const plusBtn = rowContainer.querySelector('button.plus:not([disabled])');
    if (plusBtn) {
      angularAddQuantity(plusBtn, rowContainer, qty);
      log(`Fallback 選票：${nameKeyword} x${qty}（行容器 ${rowContainer.className}）`);
      return true;
    }
    log(`Fallback：找到「${nameKeyword}」但該行無可用 + 按鈕`);
  }

  return false;
}
function angularAddQuantity(plusBtn, unit, qty) {
  const container = unit || plusBtn?.parentElement;
  log(`選票 click x${qty}，container: ${container?.className}`);
  for (let i = 0; i < qty; i++) {
    const btn = container
      ? container.querySelector('button.plus:not([disabled])')
      : (plusBtn && !plusBtn.disabled ? plusBtn : null);
    if (!btn || btn.disabled) { log(`click ${i + 1}: 按鈕 disabled 或不存在`); break; }
    btn.click();
    log(`click ${i + 1}/${qty} OK`);
  }
}

function isDisabled(el) {
  return el.disabled || el.closest('[disabled]') !== null ||
    (el.tagName === 'SELECT' && el.options.length <= 1 && el.options[0]?.value === '0');
}

function setInputValue(input, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, String(value));
  } else {
    input.value = String(value);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function checkAgreementCheckbox(doc) {
  const cb = doc.getElementById('person_agree_terms');
  if (cb && !cb.checked) {
    cb.click();
    try {
      const scope = window.angular && angular.element(cb).scope();
      if (scope) {
        scope.conditions = scope.conditions || {};
        scope.conditions.agreeTerm = true;
        scope.$apply();
      }
    } catch (e) { /* ignore */ }
    log('已勾選同意條款 (#person_agree_terms)');
    return;
  }
  const keywords = ['服務條款', '隱私權政策', '使用條款'];
  const checkboxes = doc.querySelectorAll('input[type="checkbox"]');
  for (const checkbox of checkboxes) {
    if (checkbox.checked) continue;
    const label = checkbox.id
      ? doc.querySelector(`label[for="${CSS.escape(checkbox.id)}"]`)
      : checkbox.closest('label');
    const text = label?.textContent || checkbox.closest('label, div, p')?.textContent || '';
    if (keywords.some(k => text.includes(k))) {
      checkbox.click();
      log('已勾選同意條款 (keyword fallback)');
      return;
    }
  }
}

function clickProceedButton(doc) {
  const btn = findProceedButton(doc);
  if (btn) {
    const label = btn.textContent.trim() || '送出';
    log(`點擊按鈕：${label}`);
    btn.click();
    updateOverlay(STATE.DONE, `✅ 已點擊「${label}」，請完成付款`);
    setState(STATE.DONE);
    chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: `已點擊「${label}」，請完成付款。` }).catch(() => {});
    return;
  }

  // Fallback: submit button
  const submitBtn = doc.querySelector('button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])');
  if (submitBtn) {
    log('點擊 submit 按鈕');
    submitBtn.click();
    updateOverlay(STATE.DONE, '✅ 已送出，請完成付款');
    setState(STATE.DONE);
  }
}

// Body: {"tickets":[{"id":ticketTypeId,"quantity":N,"invitationCodes":[],"use_qualification_id":null}],
//        "currency":"TWD","recaptcha":{},"agreeTerm":true}
async function tryApiSubmit(doc) {
  try {
    const selectedTickets = getSelectedTicketsFromScope();
    if (!selectedTickets.length) {
      log('API 送出：Angular scope 無已選票種，跳過');
      return false;
    }

    // 2. CSRF token（Rails authenticity_token）
    const csrfToken = doc.querySelector('meta[name="csrf-token"]')?.content;
    if (!csrfToken) { log('API 送出：找不到 csrf-token'); return false; }

    // 3. Event slug from URL
    const slugMatch = location.pathname.match(/\/events\/([^/]+)\//);
    if (!slugMatch) { log('API 送出：無法取得 slug'); return false; }
    const slug = slugMatch[1];

    const url = `https://queue.kktix.com/queue/${slug}?authenticity_token=${encodeURIComponent(csrfToken)}`;
    const body = JSON.stringify({
      tickets: selectedTickets.map(t => ({
        id: t.id,
        quantity: t.quantity,
        invitationCodes: [],
        use_qualification_id: null,
      })),
      currency: 'TWD',
      recaptcha: {},
      agreeTerm: true,
    });

    log(`API 送出 → ${url}`);
    log(`tickets: ${JSON.stringify(selectedTickets)}`);

    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'text/plain',
        'origin': 'https://kktix.com',
        'referer': 'https://kktix.com/',
      },
      body,
    });

    const text = await resp.text();
    log(`API 回應 status=${resp.status} redirected=${resp.redirected} url=${resp.url}`);
    log(`API 回應 body: ${text.slice(0, 500)}`);
    if (resp.redirected) {
      log(`跟隨 redirect → ${resp.url}`);
      location.href = resp.url;
      updateOverlay(STATE.DONE, '✅ 完成！請完成付款');
      setState(STATE.DONE);
      chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: '已完成，請繼續後續步驟。' }).catch(() => {});
      return true;
    }

    if (resp.ok || resp.status === 201) {
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}

      if (json) log(`API 回應 JSON keys: ${Object.keys(json).join(', ')}`);
      const redirectUrl = json?.redirect_url || json?.redirectUrl || json?.url ||
                          json?.redirect || json?.location || json?.next_url;
      if (redirectUrl) {
        log(`轉跳 → ${redirectUrl}`);
        location.href = redirectUrl;
        updateOverlay(STATE.DONE, '✅ 完成！請完成付款');
        setState(STATE.DONE);
        chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: '已完成，請繼續後續步驟。' }).catch(() => {});
        return true;
      }
      const queueToken = json?.token;
      if (queueToken) {
        log(`收到 queue token，進入 QUEUING 狀態`);
        setState(STATE.QUEUING);
        if (observer) { observer.disconnect(); observer = null; }
        clearTimer();
        updateOverlay(STATE.QUEUING, '已進入佇列，等待處理…');
        const slugMatch = location.pathname.match(/\/events\/([^/]+)\//);
        const slug = slugMatch ? slugMatch[1] : null;
        if (slug) {
          pollQueueStatus(slug, queueToken);
          return true;
        }
      }

      log('API 成功但無法解析回應，fallback 到 DOM 點擊');
      return false;
    }

    log(`API 送出失敗 (${resp.status})，改用 DOM 點擊`);
    return false;
  } catch (e) {
    log('API 送出例外，改用 DOM 點擊', e);
    return false;
  }
}
//
//   <div class="ticket-unit ng-scope" ng-class="{active: ticketModel.quantity != 0}">
//       ...
//     </div>
//   </div>
function getSelectedTicketsFromScope() {
  const result = [];
  const units = document.querySelectorAll('.ticket-unit');

  for (const unit of units) {
    const ticketEl = unit.querySelector('[id^="ticket_"]');
    if (!ticketEl) continue;
    const idMatch = ticketEl.id.match(/^ticket_(\d+)$/);
    if (!idMatch) continue;
    const id = parseInt(idMatch[1]);
    let qty = 0;
    const qtyEl = unit.querySelector(
      'input[type="number"][ng-model], input[type="number"], ' +
      '[ng-bind="ticketModel.quantity"], [ng-bind*="quantity"], ' +
      '.quantity-value, .ticket-quantity-value'
    );
    if (qtyEl) {
      qty = parseInt(qtyEl.value !== undefined ? qtyEl.value : qtyEl.textContent) || 0;
    }
    if (qty <= 0 && unit.classList.contains('active')) qty = 1;

    if (qty > 0) {
      result.push({ id, quantity: qty });
      log(`getSelectedTickets: id=${id} qty=${qty} (active=${unit.classList.contains('active')})`);
    }
  }

  if (!result.length) log('getSelectedTickets: 找不到已選票種');
  return result;
}
function observeAndFill() {
  if (observer) observer.disconnect();

  observer = new MutationObserver(async () => {
    if (state !== STATE.POLLING && state !== STATE.FILLING) return;
    const noTicket = NO_TICKET_TEXTS.some(t => document.body.textContent.includes(t));
    if (noTicket) return;

    const rows = findTicketRows(document);
    if (rows.length > 0) {
      observer.disconnect();
      setState(STATE.FILLING);
      updateOverlay(STATE.FILLING, 'DOM 更新，立即填表…');
      await tryFillCurrentPage();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  tryFillCurrentPage();
}

function injectOverlay() {
  if (document.getElementById('evt-helper-overlay')) return;

  const style = document.createElement('style');
  style.textContent = `
    #evt-helper-overlay {
      position: fixed;
      top: 18px;
      left: 18px;
      z-index: 2147483647;
      background: #0f0f0f;
      border: 1px solid #e94560;
      border-radius: 10px;
      width: 270px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
      color: #e0e0e0;
      box-shadow: 0 4px 24px rgba(233,69,96,0.35);
      overflow: hidden;
      user-select: none;
    }
    #evt-helper-overlay * { box-sizing: border-box; }
    #evt-helper-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      background: rgba(233,69,96,0.18);
      cursor: grab;
      font-weight: 700;
      font-size: 13px;
      gap: 6px;
    }
    #evt-helper-header:active { cursor: grabbing; }
    #evt-helper-minimize {
      background: rgba(233,69,96,0.2);
      border: none;
      color: #e94560;
      cursor: pointer;
      font-size: 14px;
      width: 22px; height: 22px;
      border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      line-height: 1; flex-shrink: 0;
    }
    #evt-helper-minimize:hover { background: #e94560; color: white; }
    #evt-helper-body { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    #evt-helper-overlay.minimized #evt-helper-body { display: none; }

    /* Status bar */
    #evt-helper-statusbar {
      background: rgba(233,69,96,0.08);
      border: 1px solid rgba(233,69,96,0.25);
      border-radius: 6px;
      padding: 6px 8px;
      display: flex; flex-direction: column; gap: 3px;
    }
    #evt-helper-status { color: #ccc; line-height: 1.4; word-break: break-all; font-size: 11px; }
    #evt-helper-countdown {
      font-size: 17px; font-weight: 700; color: #e94560;
      text-align: center; font-variant-numeric: tabular-nums; min-height: 20px;
    }

    /* Section */
    .kb-section { display: flex; flex-direction: column; gap: 5px; }
    .kb-label { color: #888; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }

    /* Toggle */
    .kb-toggle-row { display: flex; align-items: center; justify-content: space-between; }
    .kb-toggle-row span { font-weight: 600; font-size: 12px; }
    .kb-switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
    .kb-switch input { opacity: 0; width: 0; height: 0; }
    .kb-slider {
      position: absolute; inset: 0; background: #333; border-radius: 20px; cursor: pointer;
      transition: .2s;
    }
    .kb-slider:before {
      content: ''; position: absolute; width: 14px; height: 14px;
      left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: .2s;
    }
    .kb-switch input:checked + .kb-slider { background: #e94560; }
    .kb-switch input:checked + .kb-slider:before { transform: translateX(16px); }

    /* Datetime */
    .kb-dt-row { display: flex; align-items: center; gap: 3px; }
    .kb-sel {
      background: #1a1a1a; border: 1px solid #333; border-radius: 4px; color: #e0e0e0;
      padding: 3px 2px; font-size: 11px; cursor: pointer; flex: 1; min-width: 0;
    }
    .kb-sel:focus { outline: none; border-color: #e94560; }
    .kb-sep { color: #666; font-size: 11px; flex-shrink: 0; }

    /* Ticket list */
    .kb-ticket-item {
      display: flex; align-items: center; gap: 4px;
      background: #1a1a1a; border-radius: 5px; padding: 4px 6px;
    }
    .kb-ticket-num { color: #e94560; font-weight: 700; font-size: 10px; width: 12px; flex-shrink: 0; }
    .kb-ticket-name { flex: 1; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kb-ticket-qty { color: #888; font-size: 10px; flex-shrink: 0; }
    .kb-ticket-del {
      background: none; border: none; color: #555; cursor: pointer; font-size: 12px;
      padding: 0 2px; line-height: 1; flex-shrink: 0;
    }
    .kb-ticket-del:hover { color: #e94560; }
    .kb-add-row { display: flex; gap: 4px; }
    .kb-input {
      background: #1a1a1a; border: 1px solid #333; border-radius: 4px; color: #e0e0e0;
      padding: 4px 6px; font-size: 11px; flex: 1; min-width: 0;
    }
    .kb-input:focus { outline: none; border-color: #e94560; }
    .kb-input-qty { width: 38px; flex: none; text-align: center; }
    .kb-btn-add {
      background: rgba(233,69,96,0.2); border: 1px solid rgba(233,69,96,0.4);
      border-radius: 4px; color: #e94560; cursor: pointer; padding: 4px 7px; font-size: 11px;
      flex-shrink: 0;
    }
    .kb-btn-add:hover { background: #e94560; color: white; }

    /* Range */
    .kb-range-row { display: flex; align-items: center; gap: 6px; }
    .kb-range { flex: 1; accent-color: #e94560; }
    .kb-range-val { color: #e94560; font-size: 10px; width: 40px; text-align: right; flex-shrink: 0; }

    /* Checkbox */
    .kb-check-row { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .kb-check-row input { accent-color: #e94560; cursor: pointer; }
    .kb-check-row span { font-size: 11px; }

    /* 主開關 */
    #kb-enabled-wrap {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      background: rgba(233,69,96,0.1); border: 1px solid rgba(233,69,96,0.3);
      border-radius: 8px; padding: 10px; cursor: pointer;
    }
    #kb-enabled-wrap:has(input:checked) {
      background: rgba(233,69,96,0.25); border-color: #e94560;
    }
    #kb-enabled { display: none; }
    #kb-enabled-label {
      font-size: 15px; font-weight: 700; color: #888; letter-spacing: .5px;
    }
    #kb-enabled-wrap:has(input:checked) #kb-enabled-label { color: #e94560; }
    /* 大型開關圖示 */
    #kb-enabled-wrap::before {
      content: '○';
      font-size: 22px; color: #444; line-height: 1;
    }
    #kb-enabled-wrap:has(input:checked)::before { content: '●'; color: #e94560; }

    /* Divider */
    .kb-divider { border: none; border-top: 1px solid #222; margin: 0; }
  `;
  document.documentElement.appendChild(style);

  overlay = document.createElement('div');
  overlay.id = 'evt-helper-overlay';
  overlay.innerHTML = `
    <div id="evt-helper-header">
      <span>🎫 助手</span>
      <button id="evt-helper-minimize" title="收合">－</button>
    </div>
    <div id="evt-helper-body">

      <!-- 狀態列 -->
      <div id="evt-helper-statusbar">
        <div id="evt-helper-status">初始化…</div>
        <div id="evt-helper-countdown"></div>
      </div>

      <hr class="kb-divider">

      <!-- 開賣時間 -->
      <div class="kb-section">
        <div class="kb-label">開賣時間</div>
        <div class="kb-dt-row">
          <select id="kb-year" class="kb-sel"></select>
          <span class="kb-sep">/</span>
          <select id="kb-month" class="kb-sel"></select>
          <span class="kb-sep">/</span>
          <select id="kb-day" class="kb-sel"></select>
        </div>
        <div class="kb-dt-row" style="margin-top:3px">
          <select id="kb-hour" class="kb-sel"></select>
          <span class="kb-sep">:</span>
          <select id="kb-minute" class="kb-sel"></select>
        </div>
      </div>

      <hr class="kb-divider">

      <!-- 項目優先清單 -->
      <div class="kb-section">
        <div class="kb-label">項目優先清單</div>
        <div id="kb-ticket-list"></div>
        <div class="kb-add-row">
          <input type="text" id="kb-ticket-name" class="kb-input" placeholder="項目關鍵字">
          <input type="number" id="kb-ticket-qty" class="kb-input kb-input-qty" value="1" min="1" max="10">
          <button id="kb-ticket-add" class="kb-btn-add">＋</button>
        </div>
      </div>

      <hr class="kb-divider">

      <!-- 檢查間隔 -->
      <div class="kb-section">
        <div class="kb-label">檢查間隔</div>
        <div class="kb-range-row">
          <input type="range" id="kb-poll" class="kb-range" min="500" max="5000" step="100" value="1500">
          <span id="kb-poll-val" class="kb-range-val">1500ms</span>
        </div>
      </div>

      <hr class="kb-divider">

      
      <div class="kb-section">
        <label class="kb-check-row">
          <input type="checkbox" id="kb-agree">
          <span>勾選同意條款</span>
        </label>
        <label class="kb-check-row">
          <input type="checkbox" id="kb-next">
          <span>點擊下一步</span>
        </label>
        <label class="kb-check-row">
          <input type="checkbox" id="kb-api">
          <span>直接送出</span>
        </label>
      </div>

      <hr class="kb-divider">

      
      <label id="kb-enabled-wrap">
        <input type="checkbox" id="kb-enabled">
        <span id="kb-enabled-label">啟動</span>
      </label>

    </div>
  `;
  document.documentElement.appendChild(overlay);
  panelPopulate();
  panelBindEvents();
  makeDraggable(overlay, document.getElementById('evt-helper-header'));
  setInterval(updateOverlayCountdown, 1000);
  startImageBlocker();
}
function panelPopulate() {
  const now = new Date();
  const cy = now.getFullYear();

  // Year / Month / Day / Hour / Minute
  panelFillSelect('kb-year',   range(cy, cy + 2), v => v,       v => v + '年');
  panelFillSelect('kb-month',  range(1, 12),       v => pad(v), v => pad(v) + '月');
  panelFillSelect('kb-hour',   range(0, 23),       v => pad(v), v => pad(v) + '時');
  panelFillSelect('kb-minute', range(0, 59),       v => pad(v), v => pad(v) + '分');
  panelFillDays();

  if (settings.saleStartTime) {
    const d = new Date(settings.saleStartTime);
    if (!isNaN(d)) {
      document.getElementById('kb-year').value   = String(d.getFullYear());
      document.getElementById('kb-month').value  = pad(d.getMonth() + 1);
      panelFillDays();
      document.getElementById('kb-day').value    = pad(d.getDate());
      document.getElementById('kb-hour').value   = pad(d.getHours());
      document.getElementById('kb-minute').value = pad(d.getMinutes());
    }
  } else {
    document.getElementById('kb-year').value  = String(now.getFullYear());
    document.getElementById('kb-month').value = pad(now.getMonth() + 1);
    panelFillDays();
    document.getElementById('kb-day').value   = pad(now.getDate());
  }

  document.getElementById('kb-enabled').checked = !!settings.enabled;
  document.getElementById('kb-poll').value       = settings.pollInterval || 1500;
  document.getElementById('kb-poll-val').textContent = (settings.pollInterval || 1500) + 'ms';
  document.getElementById('kb-agree').checked    = settings.autoAgree !== false;
  document.getElementById('kb-next').checked     = settings.autoNext !== false;
  document.getElementById('kb-api').checked      = !!settings.autoApiSubmit;

  panelRenderTickets();
}

function panelFillSelect(id, values, toVal, toLabel) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = toVal(v); opt.textContent = toLabel(v);
    sel.appendChild(opt);
  }
  if (cur) sel.value = cur;
}

function panelFillDays() {
  const y = Number(document.getElementById('kb-year')?.value)  || new Date().getFullYear();
  const m = Number(document.getElementById('kb-month')?.value) || 1;
  const days = new Date(y, m, 0).getDate();
  const cur  = document.getElementById('kb-day')?.value;
  panelFillSelect('kb-day', range(1, days), v => pad(v), v => pad(v) + '日');
  const n = Number(cur);
  if (n >= 1 && n <= days) document.getElementById('kb-day').value = pad(n);
}

function panelGetDatetime() {
  const y  = document.getElementById('kb-year')?.value;
  const mo = document.getElementById('kb-month')?.value;
  const d  = document.getElementById('kb-day')?.value;
  const h  = document.getElementById('kb-hour')?.value;
  const mi = document.getElementById('kb-minute')?.value;
  if (!y || !mo || !d) return '';
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
}

function panelRenderTickets() {
  const list = document.getElementById('kb-ticket-list');
  if (!list) return;
  list.innerHTML = '';
  if (!settings.tickets?.length) {
    list.innerHTML = '<div style="color:#555;font-size:10px;text-align:center;padding:4px;">尚未新增項目</div>';
    return;
  }
  settings.tickets.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'kb-ticket-item';
    item.innerHTML = `
      <span class="kb-ticket-num">${i + 1}</span>
      <span class="kb-ticket-name" title="${escHtml(t.name)}">${escHtml(t.name)}</span>
      <span class="kb-ticket-qty">${t.qty}張</span>
      <button class="kb-ticket-del" data-i="${i}">✕</button>
    `;
    item.querySelector('.kb-ticket-del').addEventListener('click', (e) => {
      settings.tickets.splice(Number(e.currentTarget.dataset.i), 1);
      panelRenderTickets();
    });
    list.appendChild(item);
  });
}
function panelBindEvents() {
  document.getElementById('evt-helper-minimize').addEventListener('click', (e) => {
    e.stopPropagation();
    const minimized = overlay.classList.toggle('minimized');
    e.currentTarget.textContent = minimized ? '＋' : '－';
  });

  ['kb-year', 'kb-month', 'kb-day', 'kb-hour', 'kb-minute'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (id === 'kb-year' || id === 'kb-month') panelFillDays();
      settings.saleStartTime = panelGetDatetime();
      panelSave();
    });
  });

  document.getElementById('kb-enabled').addEventListener('change', (e) => {
    settings.enabled = e.target.checked;
    panelSave();
  });

  document.getElementById('kb-poll').addEventListener('change', (e) => {
    settings.pollInterval = Number(e.target.value);
    document.getElementById('kb-poll-val').textContent = e.target.value + 'ms';
    panelSave();
  });
  document.getElementById('kb-poll').addEventListener('input', (e) => {
    document.getElementById('kb-poll-val').textContent = e.target.value + 'ms';
  });

  document.getElementById('kb-agree').addEventListener('change', (e) => { settings.autoAgree = e.target.checked; panelSave(); });
  document.getElementById('kb-next').addEventListener('change',  (e) => { settings.autoNext  = e.target.checked; panelSave(); });
  document.getElementById('kb-api').addEventListener('change',   (e) => { settings.autoApiSubmit = e.target.checked; panelSave(); });

  document.getElementById('kb-ticket-add').addEventListener('click', panelAddTicket);
  document.getElementById('kb-ticket-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panelAddTicket();
  });

}

function panelAddTicket() {
  const nameEl = document.getElementById('kb-ticket-name');
  const qtyEl  = document.getElementById('kb-ticket-qty');
  const name   = nameEl.value.trim();
  const qty    = Math.max(1, Math.min(10, Number(qtyEl.value) || 1));
  if (!name) { nameEl.focus(); return; }
  if (!settings.tickets) settings.tickets = [];
  settings.tickets.push({ name, qty });
  nameEl.value = ''; qtyEl.value = '1';
  panelRenderTickets();
  nameEl.focus();
}

async function panelSave() {
  const pending = document.getElementById('kb-ticket-name').value.trim();
  if (pending) panelAddTicket();

  settings.enabled        = document.getElementById('kb-enabled').checked;
  settings.saleStartTime  = panelGetDatetime();
  settings.pollInterval   = Number(document.getElementById('kb-poll').value);
  settings.autoAgree      = document.getElementById('kb-agree').checked;
  settings.autoNext       = document.getElementById('kb-next').checked;
  settings.autoApiSubmit  = document.getElementById('kb-api').checked;

  await chrome.storage.local.set(settings);
  if (settings.enabled && (state === STATE.IDLE || state === STATE.STOPPED)) {
    startAutomation();
  }
}
function makeDraggable(el, handle) {
  let ox = 0, oy = 0, sx = 0, sy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    const onMove = (e) => {
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top  = (oy + e.clientY - sy) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function blockLargeImg(img) {
  if (!img.src || img.src.startsWith('data:')) return;
  const w = parseInt(img.getAttribute('width') || 0);
  const h = parseInt(img.getAttribute('height') || 0);
  if (w > 200 || h > 200) {
    img.src = BLANK_GIF;
    return;
  }
  img.addEventListener('load', function check() {
    img.removeEventListener('load', check);
    if (img.naturalWidth > 200 || img.naturalHeight > 200) {
      img.src = BLANK_GIF;
    }
  }, { once: true });
}

function startImageBlocker() {
  document.querySelectorAll('img').forEach(blockLargeImg);
  const imgObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') blockLargeImg(node);
        node.querySelectorAll?.('img').forEach(blockLargeImg);
      }
    }
  });
  imgObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function updateOverlay(newState, message) {
  if (!overlay) return;
  const statusEl = document.getElementById('evt-helper-status');
  if (statusEl) statusEl.textContent = pollCount > 0 ? `[#${pollCount}] ${message}` : message;
}

function updateOverlayCountdown() {
  const el = document.getElementById('evt-helper-countdown');
  if (!el || !settings) return;
  if (settings.saleStartTime && state !== STATE.DONE && state !== STATE.STOPPED) {
    const diff = new Date(settings.saleStartTime).getTime() - Date.now();
    if (diff > 0) {
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      el.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
      el.style.color = diff < 60000 ? '#ff9800' : '#e94560';
      return;
    }
  }
  el.textContent = '';
}

function pad(n) { return String(n).padStart(2, '0'); }

function range(from, to) {
  const arr = [];
  for (let i = from; i <= to; i++) arr.push(i);
  return arr;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setState(s) {
  state = s;
}

function stop(reason) {
  clearTimer();
  if (observer) { observer.disconnect(); observer = null; }
  setState(STATE.STOPPED);
  updateOverlay(STATE.STOPPED, `🛑 ${reason}`);
}

function clearTimer() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function formatCountdown(ms) {
  if (ms <= 0) return '開賣中！';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `開賣倒數 ${pad(h)}:${pad(m)}:${pad(s)}`;
}

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function log(...args) {
  console.log('[EH]', ...args);
}

async function pollQueueStatus(slug, jwtToken, attempt = 1) {
  if (state !== STATE.QUEUING) return;
  const url = `https://queue.kktix.com/queue/token/${jwtToken}`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'origin': 'https://kktix.com',
        'referer': 'https://kktix.com/',
      },
    });
    if (resp.redirected) {
      log(`佇列完成，redirect → ${resp.url}`);
      location.href = resp.url;
      updateOverlay(STATE.DONE, '✅ 完成！請完成付款');
      setState(STATE.DONE);
      chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: '已完成，請繼續後續步驟。' }).catch(() => {});
      return;
    }

    const text = await resp.text();
    log(`queue #${attempt} status=${resp.status}`);

    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (json?.to_param) {
      const dest = `https://kktix.com/events/${slug}/registrations/${json.to_param}`;
      log(`佇列完成！to_param=${json.to_param}，轉跳 → ${dest}`);
      location.href = dest;
      updateOverlay(STATE.DONE, '✅ 完成！請完成付款');
      setState(STATE.DONE);
      chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: '已完成，請繼續後續步驟。' }).catch(() => {});
      return;
    }
    const redirectUrl = json?.redirect_url || json?.redirectUrl || json?.url ||
                        json?.redirect || json?.location || json?.next_url;
    if (redirectUrl) {
      log(`佇列完成，轉跳 → ${redirectUrl}`);
      location.href = redirectUrl;
      updateOverlay(STATE.DONE, '✅ 完成！請完成付款');
      setState(STATE.DONE);
      chrome.runtime.sendMessage({ type: 'SET_STATE', state: 'done', detail: '已完成，請繼續後續步驟。' }).catch(() => {});
      return;
    }
    const position = json?.position || json?.queue_position || json?.rank;
    const msg = position ? `佇列位置 #${position}，等待中…` : `佇列等待中（第 ${attempt} 次）…`;
    updateOverlay(STATE.FILLING, msg);
    if (attempt < 120) {
      pollTimer = setTimeout(() => pollQueueStatus(slug, jwtToken, attempt + 1), 1500);
    } else {
      log('queue timeout');
      updateOverlay(STATE.STOPPED, '佇列等待逾時，請手動操作');
    }
  } catch (e) {
    log('queue error', e);
    if (attempt < 120) {
      pollTimer = setTimeout(() => pollQueueStatus(slug, jwtToken, attempt + 1), 2000);
    }
  }
}

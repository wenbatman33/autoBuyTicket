'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// KKTix 自動搶票 — Service Worker
// 職責：chrome.alarms 計時、跨 tab 協調、訊息轉發
// ═══════════════════════════════════════════════════════════════════════════════

const ALARM_PRE_SALE = 'kktix-pre-sale-wakeup';

// ─── Alarm Setup ──────────────────────────────────────────────────────────────
// 當設定更新時，重新設定 alarm（讓 service worker 在開賣前被喚醒）
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.saleStartTime || changes.enabled) {
    await resetAlarm();
  }
});

chrome.runtime.onInstalled.addListener(resetAlarm);
chrome.runtime.onStartup.addListener(resetAlarm);

async function resetAlarm() {
  await chrome.alarms.clear(ALARM_PRE_SALE);
  const data = await chrome.storage.local.get(['saleStartTime', 'enabled']);
  if (!data.enabled || !data.saleStartTime) return;

  const saleMs = new Date(data.saleStartTime).getTime();
  const wakeMs = saleMs - 35000; // 開賣前 35 秒喚醒
  if (wakeMs > Date.now()) {
    chrome.alarms.create(ALARM_PRE_SALE, { when: wakeMs });
    console.log('[KKTix BG] Alarm set for', new Date(wakeMs).toLocaleTimeString());
  }
}

// ─── Alarm Fired ──────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_PRE_SALE) return;

  const data = await chrome.storage.local.get(null);
  if (!data.enabled) return;

  // 找所有 KKTix registrations/new 的 tab，通知它們準備倒數
  const tabs = await chrome.tabs.query({ url: '*://*.kktix.com/events/*/registrations/new*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'PRESALE_WAKEUP', settings: data }).catch(() => {});
  }

  // 若沒有打開的 tab，不自動開啟（使用者應自行開啟頁面）
  if (tabs.length === 0) {
    console.log('[KKTix BG] No registration tabs open. Please open the event page.');
  }
});

// ─── Message Routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true; // async
  }

  if (msg.type === 'SET_STATE') {
    // content script 通知搶票結果
    console.log('[KKTix BG] State update:', msg.state, msg.detail);
    if (msg.state === 'done') {
      // 可在此觸發桌面通知
      showNotification('搶票成功！', msg.detail || '請在頁面上完成付款流程。');
    }
    sendResponse({ ok: true });
  }
});

// ─── Desktop Notification ─────────────────────────────────────────────────────
function showNotification(title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    priority: 2,
  });
}

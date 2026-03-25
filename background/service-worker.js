'use strict';

const ALARM_PRE_SALE = 'evt-helper-wakeup';

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
  const wakeMs = saleMs - 35000;
  if (wakeMs > Date.now()) {
    chrome.alarms.create(ALARM_PRE_SALE, { when: wakeMs });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_PRE_SALE) return;

  const data = await chrome.storage.local.get(null);
  if (!data.enabled) return;

  const tabs = await chrome.tabs.query({ url: '*://*.kktix.com/events/*/registrations/new*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'PRESALE_WAKEUP', settings: data }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true;
  }

  if (msg.type === 'SET_STATE') {
    if (msg.state === 'done') {
      showNotification('完成！', msg.detail || '請在頁面上完成後續步驟。');
    }
    sendResponse({ ok: true });
  }
});

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案說明

KKTix 自動搶票 Chrome 擴充功能（Manifest V3）。使用靜默 `fetch` 輪詢偵測票券可用性，在開賣瞬間自動填表、勾選條款、點擊選位/下一步。

## 安裝與載入

1. 開啟 `chrome://extensions`
2. 右上角開啟「開發者模式」
3. 點擊「載入未封裝項目」，選擇此資料夾（`autoBuyTicket/`）
4. 擴充功能圖示出現後，點擊開啟 popup 進行設定

## 使用方式

1. 在 popup 新增票券優先清單（票名關鍵字 + 張數）
2. 設定開賣時間
3. 開啟活動報名頁 `https://kktix.com/events/{slug}/registrations/new`
4. 確認已手動登入 KKTix
5. 勾選「啟用」並儲存設定
6. 頁面右下角 overlay 會顯示倒數與狀態

## 檔案結構

```
manifest.json              Chrome MV3 宣告
popup/
  popup.html               設定 UI
  popup.js                 設定讀寫、countdown、票券清單管理
  popup.css                樣式
content/
  content.js               核心自動化（輪詢、填表、overlay）
background/
  service-worker.js        chrome.alarms 計時、桌面通知
icons/
  icon128.png              圖示
```

## 架構重點

- **輪詢**：`content.js` 用 `fetch()` 靜默抓頁面 HTML，解析後判斷是否有票，不觸發完整頁面 reload
- **退避策略**：收到 429/503 時指數退避（2s→4s→8s，最多 30s）；無票時隨機 ±300ms 抖動
- **選票邏輯**：`selectTicketsByPriority()` 依 storage 清單順序，比對票名關鍵字後設定 quantity；觸發 `input`/`change` event 以支援 React/Vue
- **API 直接送出**：從 `<meta name="csrf-token">` 取得 token，直接 POST `<form action>`，比 DOM click 快約 100-300ms
- **MutationObserver**：備用機制，監控 DOM 變化，fetch 有票但真實頁面尚未更新時使用
- **Service Worker**：開賣前 35 秒設定 `chrome.alarms` 喚醒，通知已開啟的 tab 準備；搶票成功後觸發桌面通知

## 注意事項

- KKTix 為 Ruby on Rails 應用，CSRF token 在 `<meta name="csrf-token">`
- 需手動登入後才可搶票，插件不負責登入流程
- 搶到票（點擊選位/下一步）後插件停止，付款由使用者手動完成
- 若 KKTix 改版導致選擇器失效，調整 `content.js` 中的 `findTicketRows()` 與 `trySelectTicket()` 的 CSS 選擇器

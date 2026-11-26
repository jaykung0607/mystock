# 家庭股市帳本 App — 規格書 v1

> 給 Claude Code 的說明：本檔是與使用者（Jay）逐題確認後的設計決策。實作時以本檔為準；
> 有疑問或需要偏離時，先問 Jay。標示「待驗證」的項目請先實測再採用。

## 1. 目標與範圍

- **自用**家庭持股帳本：Jay（管理者）+ 兩個小孩（國一、國小四年級）。不上架、不商業化。
- 追蹤**持股、成本、市值、損益、報酬率**，外加關注清單與走勢圖。
- **不做下單**、不串券商 API。
- 資產類別：台股/台股 ETF（例：006208）、美股/美股 ETF、國內投信基金、境外基金（例：貝萊德世界科技基金，需記錄級別）。

## 2. 平台與技術

| 項目 | 決策 |
|---|---|
| 形式 | PWA（手機 + iPad，加入主畫面使用） |
| 前端 | React + Vite + vite-plugin-pwa，TypeScript；圖表用 TradingView Lightweight Charts |
| 後端 | Cloudflare Workers + Hono，TypeScript |
| 資料庫 | Cloudflare D1（SQLite） |
| 部署 | GitHub 私有 repo → Cloudflare Pages 自動建置（Pages Functions 或獨立 Worker 皆可，擇簡） |
| 登入 | Cloudflare Access，One-time PIN（Email 驗證碼） |
| 成本 | 全部在 Cloudflare 免費方案內；網域選配 |
| 介面語言 | 繁體中文 |
| 漲跌色 | **一律紅漲綠跌**（含美股），避免小孩混淆 |

### 免費方案注意事項
- D1 免費方案每日讀寫行數有上限（2026-09-01 起超過即報錯，00:00 UTC = 台灣 08:00 重置）。
  → 報價寫入採**每日批次**；盤中報價只放快取（Cache API 或 KV），**不寫 D1**。
- 單次 Worker 呼叫的 D1 查詢數有上限（免費 50）→ 批次查詢、用 `batch()`。

## 3. 使用者與權限

| 身分 | 登入 Email | 權限 | 介面 |
|---|---|---|---|
| Jay（admin） | Jay 的 Gmail | 看/改所有帳本、全家合計、所有設定 | 完整版 |
| 小孩 1 | `<jay>+kid1@gmail.com` | 只看自己帳本（唯讀）；可編輯自己的關注清單 | 簡化版 |
| 小孩 2 | `<jay>+kid2@gmail.com` | 同上 | 簡化版 |

- Gmail「+」別名：驗證碼寄到 Jay 信箱，由 Jay 在小孩裝置上登入。
- Access policy session：Jay **1 週**、小孩 **1 個月**。
- 後端從 `Cf-Access-Jwt-Assertion` header 驗證 JWT（驗簽、aud），取 email → 對應 `users` 表 → 角色。
  **所有 API 一律在後端做權限檢查**，前端隱藏只是 UX。
- 本機開發時提供 dev bypass（環境變數指定模擬 email），正式環境不得啟用。
- 預留（v1 不做 UI）：小孩「可輸入、需核准」權限旗標。

### 小孩簡化介面
- 首頁大字：「我的錢現在值多少」「比投入多/少了多少（金額 + %）」+ 簡單資產走勢圖。
- 持股列表：名稱、市值、賺賠。**不顯示**匯兌拆分、手續費等細節。
- 關注清單：可新增/刪除自己的觀察標的。

## 4. 多幣別

- 每筆交易存**原幣金額 + 成交匯率（對 TWD）**。
- 輸入交易時自動帶入當日台銀即期賣出匯率，可手動改成對帳單實際匯率；
  「用既有外幣帳戶的美元買」情境允許使用者自行決定填哪個匯率。
- 合計（每人總覽、全家合計）一律換算 TWD；持股明細顯示原幣。
- 損益拆分（admin 介面）：
  - 投資損益（原幣）＝（現價 − 平均成本）× 數量 ± 已實現
  - 匯兌損益（TWD）＝ 原幣成本 ×（現匯率 − 成本加權匯率）
  - 總損益（TWD）＝ 投資損益 × 現匯率 + 匯兌損益
- 賣出也記匯率 → 已實現損益同樣拆分。
- 成本法：**移動平均成本**（台灣券商常用）。

## 5. 資料模型（草案，可調整）

```
users(id, email, display_name, role: 'admin'|'child', created_at)
accounts(id, user_id, name, broker, currency)            -- 一人可多個帳戶（證券戶、複委託、銀行基金）
instruments(id, type: 'tw_stock'|'us_stock'|'tw_fund'|'offshore_fund',
            symbol, name, currency, share_class, data_source, source_key)
transactions(id, account_id, instrument_id, type, trade_date,
             quantity, price, amount, fee, tax, fx_rate,
             withholding_tax, split_ratio, note,
             status: 'confirmed'|'pending', recurring_plan_id, created_by, created_at)
  -- type: 'opening'|'buy'|'sell'|'dividend_cash'|'dividend_reinvest'|'split'
recurring_plans(id, account_id, instrument_id, day_of_month, amount, currency, active)
prices_daily(instrument_id, date, close, PRIMARY KEY(instrument_id, date))
fx_daily(currency, date, rate, PRIMARY KEY(currency, date))
portfolio_snapshots(user_id, date, market_value_twd, cost_twd)   -- 資產走勢圖用，每日排程寫入
watchlist(user_id, instrument_id, added_at)
settings(key, value)                                      -- 例：預設手續費折扣
```

- 數量允許小數（零股、基金單位數）。金額用整數最小單位或 decimal 字串，**不要用 float 累加**。

## 6. 功能（v1）

1. **持股帳本**：每人一本（可含多個帳戶）；admin 另有全家合計頁。
2. **交易輸入**（admin）：買、賣、配息（現金/再投入，美股可填預扣稅）、分割（輸入比例，自動調整股數與成本）。
   手續費/稅可填實際金額，或依 `settings` 的預設折扣自動計算。
3. **期初餘額**：每檔一筆 `opening` 交易（截至期初日的股數、總成本原幣與 TWD）。
   期初日＝開始使用前最後一個交易日；走勢圖從期初日開始。之後允許把期初拆成逐筆歷史或用 CSV 補。
4. **報酬率**：價差報酬與含息總報酬分開顯示。
5. **定期定額範本**：誰/哪檔/每月幾號/金額。扣款日（遇假日順延至下一交易日）排程自動建立 `pending` 交易，
   以當日收盤或淨值估算數量；admin 一鍵確認或修正實際數量、價格、手續費。未確認前以估算值計入，標示「估」。
6. **關注清單**：每人各自一份；小孩可編輯自己的。
7. **走勢圖**：個股/基金（1M/6M/1Y/全部）、每人與全家資產走勢。
8. **CSV 匯出/匯入**：交易紀錄（admin）。
9. **PWA**：可加入主畫面、離線時顯示最後一次快取資料。

### v2（不在 v1 做）
- 到價提醒推播（iOS PWA 推播）
- 除權息自動偵測並提醒確認入帳金額
- 券商對帳單 CSV 匯入
- 小孩「可輸入需核准」UI

### 不做
- 下單、新聞、財報、技術指標。

## 7. 報價與資料源

### 更新策略（1 + 2）
- **每日排程（Cron Triggers）**：寫入 `prices_daily`、`fx_daily`、`portfolio_snapshots`。
  - 台股：收盤後（建議 14:30 後，台灣時間）
  - 美股：美股收盤後（台灣早上約 06:00 後，注意夏令/冬令時間）
  - 基金淨值：通常隔天公布，排程每天抓並補缺漏日
  - 匯率：每天
  - 排程要能**補抓缺漏日期**、可重跑（idempotent）。
- **盤中延遲報價**：App 開啟且在交易時段時才抓，快取 5 分鐘，畫面標示「盤中・延遲」；失敗則退回最近收盤價。

### 資料源候選（全部「待驗證」，請先實測可用性、格式、CORS 與限流）
| 類別 | 候選 |
|---|---|
| 台股收盤 | TWSE OpenAPI（上市，例：每日收盤行情 STOCK_DAY_ALL）、TPEx OpenAPI（上櫃） |
| 台股盤中 | TWSE 基本市況報導網站的非官方 JSON（可能變動，要容錯） |
| 美股 | Finnhub（免費 API key）或 Yahoo Finance 非官方端點；API key 存 Workers secret |
| 匯率 | 台灣銀行牌告匯率 CSV |
| 國內基金淨值 | 投信投顧公會或基金資訊平台公開頁面 |
| 境外基金淨值 | 境外基金資訊觀測站或基金平台公開頁面；**依級別**抓取 |

- 每個 instrument 記錄 `data_source` + `source_key`，抓取器做成可插拔 adapter。
- 基金/爬蟲抓不到時：admin 可**手動填淨值**，並在 UI 顯示「資料過期」警示（例如超過 3 個交易日沒更新）。

## 8. 安全

- 全站在 Cloudflare Access 之後；Worker 仍需驗證 Access JWT（防止繞過）。
- 所有寫入 API 檢查 admin；讀取 API 檢查「只能讀自己的 user_id」（admin 除外）。
- API key 用 `wrangler secret`，不進 repo。
- D1 定期備份：可設排程每週 export 或依賴 D1 Time Travel（免費 7 天）。

## 9. 一次性設定（需 Jay 操作，Claude Code 請寫成逐步說明）

1. Cloudflare 帳號；（選配）網域
2. GitHub 私有 repo，Cloudflare Pages 綁定自動部署
3. 建立 D1 資料庫、執行 migrations
4. Zero Trust → Access：建立 application、One-time PIN 登入方式、兩條 policy（Jay 1 週、小孩 1 個月）
5. 設定 secrets（美股 API key 等）、Cron Triggers
6. 首次輸入：建立 instruments、期初餘額、定期定額範本

## 10. 建議開發順序

1. 專案骨架（monorepo：`web/`、`worker/`、`shared/` types）、D1 schema 與 migrations、Access JWT 驗證 middleware
2. 交易 CRUD + 持倉/損益計算（**先寫單元測試**：移動平均、分割、配息、匯兌拆分）
3. 資料源 adapter + 每日排程（先台股、匯率，再美股，最後基金）
4. Admin UI：帳本、全家合計、交易輸入、期初餘額
5. 定期定額
6. 走勢圖、關注清單
7. 小孩簡化介面
8. PWA、CSV 匯入/匯出、部署文件

# 家庭股市帳本

自用家庭持股帳本 PWA。設計決策見 [SPEC.md](SPEC.md)，一次性雲端設定見 [docs/SETUP.md](docs/SETUP.md)。

## 結構

```
shared/   前後端共用 TypeScript 型別（不需建置，直接 import 原始碼）
worker/   Cloudflare Worker（Hono）：/api/*、每日排程；同時提供 web/dist 靜態檔
  migrations/   D1 schema migrations
  scripts/      seed SQL
web/      React + Vite 前端
```

部署形式：**單一 Cloudflare Worker + Static Assets**。`/api/*` 由 Worker 處理，
其他路徑由 `web/dist` 靜態檔提供（SPA fallback）。選這個而不是 Pages Functions，
是因為每日排程（Cron Triggers）只能掛在 Worker 上，一個 Worker 全包最簡單。

## 本機開發

需求：Node 22+。

> 如果 `npm install` 出現 `Cannot read properties of null (reading 'edgesOut')`，
> 那是 npm 10 的 bug，改用 `npm ci`（有 lockfile 時）或 `npx npm@11 install`。

```bash
npm ci
```

```bash
cp worker/.dev.vars.example worker/.dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run db:seed:local -w worker
```

開兩個終端機：

```bash
npm run dev:worker
```

```bash
npm run dev:web
```

打開 <http://localhost:5173>。本機用 `.dev.vars` 的 `DEV_AUTH_EMAIL` 模擬登入
（只在 `ENVIRONMENT=development` 且請求來自 localhost 時生效；正式環境 `wrangler.jsonc` 固定是 `production`）。
要切換身分，把 `DEV_AUTH_EMAIL` 改成 `kid1@example.com` 後重啟 `dev:worker`。

## 測試與檢查

```bash
npm test
```

```bash
npm run typecheck
```

Worker 測試跑在真正的 Workers runtime（`@cloudflare/vitest-plugin`），每個測試檔都會套用 D1 migrations。

## API

所有 `/api/*` 都要先通過 Cloudflare Access JWT 驗證並對應到 `users` 表，否則 401/403。
寫入一律限 admin；讀取時小孩只能看自己的資料（帶別人的 `user_id` → 403）。
金額、數量、匯率一律用十進位**字串**傳遞（也接受 JSON number）。

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/api/me` | 登入者 | 目前登入者 |
| GET | `/api/users` | admin | 使用者清單 |
| GET / PUT | `/api/settings` | admin | 手續費率、折扣、最低手續費、證交稅率 |
| GET | `/api/accounts?user_id=` | 自己／admin | 帳戶清單 |
| POST / PATCH / DELETE | `/api/accounts[/:id]` | admin | 有交易的帳戶不能刪（409） |
| GET | `/api/instruments?q=` | 登入者 | 標的清單／搜尋 |
| POST / PATCH | `/api/instruments[/:id]` | admin | 類型、代號、幣別建立後不可改 |
| GET | `/api/transactions?user_id=&account_id=&instrument_id=&status=&from=&to=` | 自己／admin | 新到舊 |
| GET | `/api/transactions/:id` | 自己／admin | |
| POST / PATCH / DELETE | `/api/transactions[/:id]` | admin | 見下方規則 |
| GET | `/api/portfolio?user_id=&live=1` | 自己／admin | 個人帳本：各持倉＋彙總；`live=1` 盤中用延遲報價 |
| GET | `/api/portfolio/family?live=1` | admin | 全家合計 |
| GET | `/api/portfolio/history?user_id=&from=&to=` | 自己／admin | 資產走勢（每日快照）；admin 省略 user_id＝全家 |
| GET | `/api/prices/:instrumentId?from=&to=` | 登入者 | 收盤價／淨值歷史 |
| PUT / DELETE | `/api/prices/:instrumentId/:date` | admin | 手動輸入淨值或收盤價 `{ "close": "12.34" }` |
| GET | `/api/fx/:currency?from=&to=` | 登入者 | 匯率歷史 |
| PUT | `/api/fx/:currency/:date` | admin | 手動輸入匯率 `{ "rate": "32.1" }` |
| POST | `/api/jobs/daily` | admin | 立即執行每日排程，回傳報告（第一次設定後回補、檢查資料源） |

### 交易規則

| type | 必填 | 說明 |
|---|---|---|
| `opening` | quantity、amount | amount＝期初總成本（原幣）；可填 amount_twd＝期初總成本 TWD |
| `buy` / `sell` | quantity、price | amount 預設 quantity × price |
| `dividend_cash` | amount | 淨額＝amount − withholding_tax − fee |
| `dividend_reinvest` | quantity，加上 amount 或 price | 股利同時計入單位數與成本，不算新投入本金 |
| `split` | split_ratio | 新股數／舊股數，例 1 拆 4 填 4 |

- **匯率**：TWD 計價固定 1；外幣沒填 `fx_rate` 時帶入交易日（含）以前最近的台銀匯率，查無則 400。
- **手續費／證交稅**：台股買賣沒填（或填 `"auto"`）時依 settings 估算（無條件捨去、最低 20 元、ETF 證交稅 0.1%）。
- 任何新增／修改／刪除如果會讓某個時間點賣超過持有，回 400 且不寫入。
- `PATCH` 不能改 `account_id`／`instrument_id`（刪除重建）。改交易日但沒給匯率時會依新日期重抓匯率。

### 報價與排程（`worker/src/jobs/daily.ts`、`worker/src/sources/`）

標的的 `data_source`（建立時省略則依類型預設）：

| data_source | 用於 | 來源 | 狀態 |
|---|---|---|---|
| `tw` | 台股上市櫃、ETF（預設） | TPEx 上櫃 + TWSE 上市「每日收盤行情」依日期查詢 | ✅ 已實測 |
| `yahoo` | 美股（預設） | Yahoo Finance chart（非官方），可回補歷史 | ⚠ 待驗證（開發環境被限流 429） |
| `finnhub` | 美股 | Finnhub quote，需 `FINNHUB_API_KEY`；免費方案無歷史 | ⚠ 待驗證（需 API key） |
| `manual` | 基金（預設） | admin 用 `PUT /api/prices/...` 手動輸入淨值 | — |
| 匯率 | | 台銀牌告即期賣出 CSV | ⚠ 待驗證（開發環境收到機器人驗證頁） |
| 盤中 | 台股 | TWSE 基本市況報導 `mis.twse.com.tw`（非官方） | ⚠ 待驗證（開發環境被擋） |

- 排程時間見 `worker/wrangler.jsonc` 的 `triggers.crons`；每次執行都會檢查缺什麼就補什麼，可重跑。
- 台股依日期新到舊回補（最多 800 天），每次最多 10 天、每天間隔 2.5 秒（TWSE 太密集會封鎖）；休市日記在 `fetch_log` 不再重抓。
- 手動輸入的價格與匯率（`source='manual'`）不會被排程覆寫。
- 收盤價超過 3 個交易日沒更新的持倉標 `price_stale`（UI 顯示「資料過期」）。
- 盤中報價只在交易時段抓（台股 09:00–13:35、美股美東 09:30–16:00），Cache API 快取 5 分鐘，不寫 D1；失敗就用最近收盤價。
- 每人每日資產快照（走勢圖）由排程補齊；缺報價的部位以成本計入。修改過去的交易、價格或匯率會刪掉之後的快照，下次排程重算。
- 基金淨值自動抓取還沒做：境外基金資訊觀測站等網站需另外實測（開發環境無法連線），目前先手動輸入。

### 計算方式（`shared/src/portfolio.ts`）

- 移動平均成本；買進成本含手續費與稅，賣出依平均成本沖銷（原幣與 TWD 各自沖銷）。
- 投資損益（原幣）＝市值 − 成本；匯兌損益（TWD）＝成本原幣 × 現匯率 − 成本 TWD；總損益＝市值 TWD − 成本 TWD。已實現以賣出匯率同樣拆分。
- 價差報酬＝未實現＋已實現；含息總報酬＝價差報酬＋股利淨額；報酬率分母＝投入本金（期初＋買進）。
- `pending`（定期定額估算）照估算值計入，持倉標 `has_pending`。

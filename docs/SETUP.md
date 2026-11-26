# 一次性設定（SPEC §9）

照順序做。需要在終端機執行的指令都在 repo 根目錄下執行，除非另外註明。
目前涵蓋開發第 1 步需要的部分（D1、Access、部署）；排程、API key 等之後的步驟會補上。

## 1. Cloudflare 帳號

1. 到 <https://dash.cloudflare.com/sign-up> 註冊（免費方案即可）。
2. 本機登入 wrangler：

```bash
npx wrangler login
```

（選配）網域：沒有網域也可以，用 `mystock.<你的子網域>.workers.dev`。

## 2. 建立 D1 資料庫並套用 migrations

```bash
cd worker && npx wrangler d1 create mystock
```

把輸出的 `database_id` 貼到 `worker/wrangler.jsonc` 的 `d1_databases[0].database_id`，commit。

```bash
npm run db:migrate:remote -w worker
```

建立使用者（email 必須和第 4 步 Access policy 允許的完全一致）：

```bash
cp worker/scripts/seed.prod.example.sql worker/scripts/seed.prod.sql
```

編輯 `worker/scripts/seed.prod.sql` 填入真實 email（這個檔案已 gitignore，不會進 repo），然後：

```bash
cd worker && npx wrangler d1 execute mystock --remote --file=scripts/seed.prod.sql
```

## 3. GitHub 自動部署（Workers Builds）

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → 選這個私有 repo。
2. 設定：
   - Project name：`mystock`（要和 `wrangler.jsonc` 的 `name` 一致）
   - Root directory：`/`（repo 根目錄）
   - Build command：`npm run build`
   - Deploy command：`cd worker && npx wrangler deploy`
   - Production branch：`main`
3. 部署完成後記下網址，例如 `https://mystock.<子網域>.workers.dev`。

手動部署（不靠 GitHub）也可以：

```bash
npm run deploy
```

## 4. Cloudflare Access（One-time PIN 登入）

1. Cloudflare dashboard → **Zero Trust**（第一次會要你選 team name 與方案，選 Free）。
   team name 決定 team domain，例如 `myfamily` → `https://myfamily.cloudflareaccess.com`。
2. **Settings → Authentication → Login methods** → Add new → **One-time PIN**。
3. **Access → Applications → Add an application → Self-hosted**：
   - Application domain：第 3 步的網址（workers.dev 網域也可以；若用 workers.dev，
     也可以在 Worker 的 **Settings → Domains & Routes** 直接按 workers.dev 旁的「Enable Cloudflare Access」）。
   - Identity providers：只勾 One-time PIN。
4. 建立兩條 **Allow** policy：

| Policy 名稱 | Include → Emails | Session duration |
|---|---|---|
| Jay | 你的 Gmail | 1 week |
| Kids | `你的帳號+kid1@gmail.com`、`你的帳號+kid2@gmail.com` | 1 month |

5. 存檔後到該 application 的 **Overview / Basic information** 複製 **Application Audience (AUD) Tag**。
6. 編輯 `worker/wrangler.jsonc` 的 `vars`：
   - `ACCESS_TEAM_DOMAIN`：`https://<team name>.cloudflareaccess.com`
   - `ACCESS_AUD`：剛剛複製的 AUD tag

   這兩個值不是機密，可以 commit。commit 後會自動重新部署。

> 重要：若要另外保留 `workers.dev` 與自訂網域兩個入口，**兩個都要**在 Access 之後；
> Worker 本身也會驗證 JWT，所以沒經過 Access 的請求一律 401。
> 另外記得到 Worker 的 **Settings → Domains & Routes** 關掉不用的 Preview URLs，避免多一個入口。

## 5. 報價排程與 API key

排程（Cron Triggers）寫在 `worker/wrangler.jsonc`，部署時自動生效，不需要到 dashboard 設定。
可在 Worker 的 **Settings → Triggers** 確認有 4 個 cron。

（選配）美股改用 Finnhub：到 <https://finnhub.io> 註冊免費 API key，然後：

```bash
cd worker && npx wrangler secret put FINNHUB_API_KEY
```

再把美股標的的 `data_source` 改成 `finnhub`。預設的 `yahoo` 不需要 key。

### 第一次回補歷史價格

輸入完期初交易後，用瀏覽器登入狀態打開開發者工具 Console 執行（或等排程自動慢慢補，每次 10 個交易日）：

```js
await (await fetch('/api/jobs/daily', { method: 'POST' })).json()
```

回傳的 `report.errors` 會列出抓不到的資料。重複執行直到 `report.tw.remaining` 為 0。

### 已知風險（請部署後回報給 Claude）

- **台銀匯率**：開發環境抓台銀時收到機器人驗證頁。如果正式環境也一樣，`report.errors` 會出現「匯率：…HTML…」，
  這時先用 `PUT /api/fx/USD/2026-11-26`（body `{"rate":"32.1"}`）手動輸入，再請 Claude 換資料源。
- **Yahoo / 台股盤中**：同樣無法在開發環境實測；失敗時盤中顯示最近收盤價，不影響帳本。

## 6. 驗證

1. 用手機瀏覽器打開網址 → 輸入 email → 收驗證碼登入。
2. 頁面應顯示「嗨，Jay（管理者）」。
3. 若顯示「此帳號未被授權使用」：email 沒在 `users` 表（第 2 步）。
4. 若顯示「登入憑證無效或已過期」：檢查 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`。

小孩裝置：在小孩的 iPad/手機上打開網址，輸入 `你的帳號+kid1@gmail.com`，驗證碼會寄到你的信箱。

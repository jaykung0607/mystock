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

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/me` | 目前登入者 |

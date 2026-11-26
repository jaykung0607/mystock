-- 0001_init: 初始 schema（SPEC §5）
-- 金額／數量／價格／匯率一律存 TEXT 十進位字串，避免 float 累加誤差。
-- 日期存 'YYYY-MM-DD'，時間戳記存 UTC ISO 字串。

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  email               TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT    NOT NULL,
  role                TEXT    NOT NULL CHECK (role IN ('admin', 'child')),
  -- 預留：小孩「可輸入、需核准」旗標（v1 無 UI）
  can_submit_pending  INTEGER NOT NULL DEFAULT 0 CHECK (can_submit_pending IN (0, 1)),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE accounts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  broker      TEXT,
  currency    TEXT    NOT NULL CHECK (length(currency) = 3),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

CREATE TABLE instruments (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('tw_stock', 'us_stock', 'tw_fund', 'offshore_fund')),
  symbol       TEXT NOT NULL,
  name         TEXT NOT NULL,
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
  share_class  TEXT NOT NULL DEFAULT '',   -- 基金級別；非基金為 ''
  data_source  TEXT NOT NULL,              -- adapter 名稱，例 'twse' / 'tpex' / 'finnhub' / 'manual'
  source_key   TEXT NOT NULL,              -- 給 adapter 的識別碼
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (type, symbol, share_class)
);

CREATE TABLE recurring_plans (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  instrument_id  INTEGER NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  day_of_month   INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  amount         TEXT    NOT NULL,          -- 每期扣款金額（原幣）
  currency       TEXT    NOT NULL CHECK (length(currency) = 3),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE transactions (
  id                 INTEGER PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  instrument_id      INTEGER NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  type               TEXT    NOT NULL CHECK (type IN ('opening', 'buy', 'sell', 'dividend_cash', 'dividend_reinvest', 'split')),
  trade_date         TEXT    NOT NULL,      -- YYYY-MM-DD
  quantity           TEXT,                  -- 股數／單位數（可小數）
  price              TEXT,                  -- 原幣單價
  amount             TEXT,                  -- 原幣總額（不含費用）；opening 為期初總成本原幣
  fee                TEXT    NOT NULL DEFAULT '0',
  tax                TEXT    NOT NULL DEFAULT '0',
  fx_rate            TEXT    NOT NULL DEFAULT '1',  -- 1 原幣 = ? TWD
  amount_twd         TEXT,                  -- 選填：實際 TWD 金額，有填時優先於 amount × fx_rate
  withholding_tax    TEXT    NOT NULL DEFAULT '0',  -- 美股配息預扣稅（原幣）
  split_ratio        TEXT,                  -- 新股數 / 舊股數
  note               TEXT,
  status             TEXT    NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending')),
  recurring_plan_id  INTEGER REFERENCES recurring_plans(id) ON DELETE SET NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tx_account_instrument_date ON transactions(account_id, instrument_id, trade_date);
CREATE INDEX idx_tx_instrument ON transactions(instrument_id);
CREATE INDEX idx_tx_status ON transactions(status);
-- 同一定期定額範本同一天只會有一筆，讓排程可重跑（idempotent）
CREATE UNIQUE INDEX idx_tx_recurring_once ON transactions(recurring_plan_id, trade_date)
  WHERE recurring_plan_id IS NOT NULL;

CREATE TABLE prices_daily (
  instrument_id  INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  date           TEXT    NOT NULL,
  close          TEXT    NOT NULL,
  source         TEXT    NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (instrument_id, date)
) WITHOUT ROWID;

CREATE TABLE fx_daily (
  currency    TEXT NOT NULL CHECK (length(currency) = 3),
  date        TEXT NOT NULL,
  rate        TEXT NOT NULL,                -- 台銀即期賣出，1 外幣 = ? TWD
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (currency, date)
) WITHOUT ROWID;

CREATE TABLE portfolio_snapshots (
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date              TEXT    NOT NULL,
  market_value_twd  TEXT    NOT NULL,
  cost_twd          TEXT    NOT NULL,
  PRIMARY KEY (user_id, date)
) WITHOUT ROWID;

CREATE TABLE watchlist (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id  INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  added_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, instrument_id)
) WITHOUT ROWID;

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) WITHOUT ROWID;

-- 預設值（可在 admin 設定頁修改）
INSERT INTO settings (key, value) VALUES
  ('tw_fee_rate', '0.001425'),      -- 台股手續費率
  ('tw_fee_discount', '1'),         -- 手續費折扣（例 0.28 = 2.8 折）
  ('tw_fee_min', '20'),             -- 台股手續費最低（TWD）
  ('tw_stock_tax_rate', '0.003'),   -- 台股證交稅（股票）
  ('tw_etf_tax_rate', '0.001');     -- 台股證交稅（ETF）

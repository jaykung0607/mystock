-- 0002: 資料抓取紀錄、匯率來源
-- fetch_log：依日期批次抓取的來源（台股 tw），記錄已處理的日期，避免重抓。
--   status 'ok'    = 有資料並已寫入
--   status 'empty' = 該日無資料（休市），不再重抓
-- 新增標的或改資料來源時會清掉該來源的紀錄，讓新標的的歷史價格補抓進來。
CREATE TABLE fetch_log (
  source      TEXT    NOT NULL,
  date        TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('ok', 'empty')),
  row_count   INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (source, date)
) WITHOUT ROWID;

ALTER TABLE fx_daily ADD COLUMN source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual'));

-- 新標的的預設來源依類型決定（見 routes/instruments.ts），既有的 'twse'/'tpex' 視同 'tw'
UPDATE instruments SET data_source = 'tw' WHERE data_source IN ('twse', 'tpex');

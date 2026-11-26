-- 正式環境建立使用者。複製成 seed.prod.sql（已 gitignore）並填入真實 email，再執行：
--   npx wrangler d1 execute mystock --remote --file=scripts/seed.prod.sql
-- email 必須與 Cloudflare Access policy 允許的 email 完全一致。
INSERT INTO users (email, display_name, role) VALUES
  ('YOUR_GMAIL@gmail.com',      'Jay',  'admin'),
  ('YOUR_GMAIL+kid1@gmail.com', '老大', 'child'),
  ('YOUR_GMAIL+kid2@gmail.com', '老二', 'child');

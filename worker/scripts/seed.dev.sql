-- 本機開發用假資料（不含真實 email）。執行：npm run db:seed:local -w worker
INSERT OR IGNORE INTO users (email, display_name, role) VALUES
  ('admin@example.com', '爸爸', 'admin'),
  ('kid1@example.com',  '老大', 'child'),
  ('kid2@example.com',  '老二', 'child');

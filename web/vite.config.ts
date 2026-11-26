import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // 本機開發：/api 轉給 `wrangler dev`（預設 8787）
    proxy: { '/api': 'http://localhost:8787' },
  },
});

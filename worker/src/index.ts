import { createApp } from './app';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  // 每日排程（SPEC §7）在第 3 步實作；先保留入口。
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<Env>;

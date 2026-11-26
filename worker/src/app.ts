import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApiError, MeResponse } from '@mystock/shared';
import type { AppEnv } from './env';
import { accessAuth, remoteJwks, type JwksResolver } from './middleware/auth';
import accounts from './routes/accounts';
import admin from './routes/admin';
import instruments from './routes/instruments';
import portfolio from './routes/portfolio';
import transactions from './routes/transactions';

export interface AppOptions {
  /** 測試時注入本地 JWKS。 */
  resolveJwks?: JwksResolver;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', accessAuth(options.resolveJwks ?? remoteJwks));

  app.get('/me', (c) => {
    const { id, email, display_name, role } = c.var.user;
    return c.json<MeResponse>({ user: { id, email, display_name, role } });
  });

  app.route('/', admin);
  app.route('/accounts', accounts);
  app.route('/instruments', instruments);
  app.route('/transactions', transactions);
  app.route('/portfolio', portfolio);

  app.notFound((c) => c.json<ApiError>({ error: 'not_found', message: '找不到此 API' }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const codes: Record<number, string> = {
        400: 'bad_request',
        401: 'unauthorized',
        403: 'forbidden',
        404: 'not_found',
        409: 'conflict',
      };
      const code = codes[err.status] ?? 'error';
      return c.json<ApiError>({ error: code, message: err.message }, err.status);
    }
    console.error(err);
    return c.json<ApiError>({ error: 'internal', message: '伺服器錯誤' }, 500);
  });

  return app;
}

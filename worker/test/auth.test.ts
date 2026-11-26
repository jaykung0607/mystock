import { env } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { assertCanReadUser, canReadUser, isDevBypassAllowed } from '../src/middleware/auth';
import type { Env } from '../src/env';

const ISSUER = 'https://test-team.cloudflareaccess.com';
const AUD = 'test-aud';

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, role) VALUES
        (1, 'admin@example.com', '爸爸', 'admin'),
        (2, 'kid1@example.com', '老大', 'child')`,
    ),
  ]);
});

function app() {
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return createApp({ resolveJwks: () => jwks });
}

async function sign(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; aud?: string; iss?: string; exp?: string | number } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(opts.key ?? privateKey);
}

function get(path: string, token?: string, e: Env = env, host = 'https://stock.example.com') {
  const headers = token ? { 'Cf-Access-Jwt-Assertion': token } : undefined;
  return app().request(`${host}${path}`, { headers }, e);
}

describe('Access JWT middleware', () => {
  it('有效 JWT → 回傳對應使用者', async () => {
    const res = await get('/api/me', await sign({ email: 'admin@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: 1, email: 'admin@example.com', display_name: '爸爸', role: 'admin' },
    });
  });

  it('email 大小寫不同仍可對應', async () => {
    const res = await get('/api/me', await sign({ email: 'Kid1@Example.com' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe('child');
  });

  it('沒有 header → 401', async () => {
    const res = await get('/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('簽章錯誤 → 401', async () => {
    const res = await get('/api/me', await sign({ email: 'admin@example.com' }, { key: otherPrivateKey }));
    expect(res.status).toBe(401);
  });

  it('aud 不符 → 401', async () => {
    const res = await get('/api/me', await sign({ email: 'admin@example.com' }, { aud: 'other-app' }));
    expect(res.status).toBe(401);
  });

  it('iss 不符 → 401', async () => {
    const res = await get(
      '/api/me',
      await sign({ email: 'admin@example.com' }, { iss: 'https://evil.cloudflareaccess.com' }),
    );
    expect(res.status).toBe(401);
  });

  it('過期 → 401', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const res = await get('/api/me', await sign({ email: 'admin@example.com' }, { exp: past }));
    expect(res.status).toBe(401);
  });

  it('JWT 沒有 email（例：service token）→ 401', async () => {
    const res = await get('/api/me', await sign({ common_name: 'svc' }));
    expect(res.status).toBe(401);
  });

  it('email 不在 users 表 → 403', async () => {
    const res = await get('/api/me', await sign({ email: 'stranger@example.com' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('未知 API → 404（需先通過登入）', async () => {
    expect((await get('/api/nope')).status).toBe(401);
    const res = await get('/api/nope', await sign({ email: 'admin@example.com' }));
    expect(res.status).toBe(404);
  });
});

describe('dev bypass', () => {
  const devEnv = (overrides: Partial<Env>): Env => ({
    ...env,
    ENVIRONMENT: 'development',
    DEV_AUTH_EMAIL: 'kid1@example.com',
    ...overrides,
  });

  it('development + localhost → 以 DEV_AUTH_EMAIL 登入', async () => {
    const res = await get('/api/me', undefined, devEnv({}), 'http://localhost:8787');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('kid1@example.com');
  });

  it('production 即使設了 DEV_AUTH_EMAIL 也不生效', async () => {
    const res = await get('/api/me', undefined, devEnv({ ENVIRONMENT: 'production' }), 'http://localhost:8787');
    expect(res.status).toBe(401);
  });

  it('development 但非 localhost → 不生效', async () => {
    const res = await get('/api/me', undefined, devEnv({}), 'https://stock.example.com');
    expect(res.status).toBe(401);
  });

  it('isDevBypassAllowed 規則', () => {
    expect(isDevBypassAllowed(devEnv({}), 'http://127.0.0.1:8787/api/me')).toBe(true);
    expect(isDevBypassAllowed(devEnv({ DEV_AUTH_EMAIL: '' }), 'http://localhost/api/me')).toBe(false);
  });
});

describe('讀取權限', () => {
  const admin = { id: 1, email: 'a', display_name: 'a', role: 'admin' as const };
  const kid = { id: 2, email: 'k', display_name: 'k', role: 'child' as const };

  it('admin 可讀任何人；小孩只能讀自己', () => {
    expect(canReadUser(admin, 2)).toBe(true);
    expect(canReadUser(kid, 2)).toBe(true);
    expect(canReadUser(kid, 1)).toBe(false);
    expect(() => assertCanReadUser(kid, 1)).toThrow();
  });
});

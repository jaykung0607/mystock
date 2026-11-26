import { env } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { createApp } from '../src/app';

const ISSUER = 'https://test-team.cloudflareaccess.com';
const AUD = 'test-aud';

let keyPromise: Promise<{ privateKey: CryptoKey; jwk: JWK }> | null = null;
function keys() {
  keyPromise ??= (async () => {
    const pair = await generateKeyPair('RS256');
    return { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' } };
  })();
  return keyPromise;
}

export const ADMIN = 'admin@example.com';
export const KID1 = 'kid1@example.com';
export const KID2 = 'kid2@example.com';

/** 清空資料並建立 3 位使用者（id 1 admin、2 kid1、3 kid2）。 */
export async function resetDb() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM transactions'),
    env.DB.prepare('DELETE FROM recurring_plans'),
    env.DB.prepare('DELETE FROM watchlist'),
    env.DB.prepare('DELETE FROM prices_daily'),
    env.DB.prepare('DELETE FROM fx_daily'),
    env.DB.prepare('DELETE FROM portfolio_snapshots'),
    env.DB.prepare('DELETE FROM accounts'),
    env.DB.prepare('DELETE FROM instruments'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare("UPDATE settings SET value = '1' WHERE key = 'tw_fee_discount'"),
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, role) VALUES
        (1, '${ADMIN}', '爸爸', 'admin'), (2, '${KID1}', '老大', 'child'), (3, '${KID2}', '老二', 'child')`,
    ),
  ]);
}

export async function client(email: string) {
  const { privateKey, jwk } = await keys();
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const app = createApp({ resolveJwks: () => jwks });

  async function call<T = any>(method: string, path: string, body?: unknown) {
    const res = await app.request(
      `https://stock.example.com/api${path}`,
      {
        method,
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      env,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  return {
    get: <T = any>(p: string) => call<T>('GET', p),
    post: <T = any>(p: string, b: unknown) => call<T>('POST', p, b),
    patch: <T = any>(p: string, b: unknown) => call<T>('PATCH', p, b),
    put: <T = any>(p: string, b: unknown) => call<T>('PUT', p, b),
    del: <T = any>(p: string) => call<T>('DELETE', p),
  };
}

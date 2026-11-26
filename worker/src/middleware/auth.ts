import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppEnv, AuthUser, Env } from '../env';

/**
 * Cloudflare Access JWT 驗證（SPEC §3、§8）。
 *
 * 1. 讀 `Cf-Access-Jwt-Assertion` header
 * 2. 用 team domain 的 JWKS 驗簽，並檢查 iss、aud、exp
 * 3. 取 email → 查 users 表 → 放到 c.var.user
 *
 * 本機開發：ENVIRONMENT=development 且設了 DEV_AUTH_EMAIL，並且請求來自 localhost，
 * 才會跳過 JWT 直接以該 email 登入。正式環境 wrangler.jsonc 的 ENVIRONMENT 是 production。
 */

export type JwksResolver = (teamDomain: string) => JWTVerifyGetKey;

const jwksCache = new Map<string, JWTVerifyGetKey>();

export const remoteJwks: JwksResolver = (teamDomain) => {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isDevBypassAllowed(env: Env, url: string): boolean {
  if (env.ENVIRONMENT !== 'development' || !env.DEV_AUTH_EMAIL) return false;
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

function normalizeTeamDomain(domain: string): string {
  const withScheme = domain.startsWith('https://') ? domain : `https://${domain}`;
  return withScheme.replace(/\/+$/, '');
}

async function verifyAccessJwt(token: string, env: Env, resolveJwks: JwksResolver): Promise<string> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HTTPException(500, { message: 'Access 設定缺少 ACCESS_TEAM_DOMAIN 或 ACCESS_AUD' });
  }
  const issuer = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  try {
    const { payload } = await jwtVerify(token, resolveJwks(issuer), {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
    });
    const email = payload.email;
    if (typeof email !== 'string' || email === '') {
      throw new Error('JWT 沒有 email');
    }
    return email;
  } catch {
    throw new HTTPException(401, { message: '登入憑證無效或已過期' });
  }
}

async function findUserByEmail(db: D1Database, email: string): Promise<AuthUser | null> {
  return db
    .prepare('SELECT id, email, display_name, role FROM users WHERE email = ?1 COLLATE NOCASE')
    .bind(email)
    .first<AuthUser>();
}

export function accessAuth(resolveJwks: JwksResolver = remoteJwks) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let email: string;
    if (isDevBypassAllowed(c.env, c.req.url)) {
      email = c.env.DEV_AUTH_EMAIL!;
    } else {
      const token = c.req.header('Cf-Access-Jwt-Assertion');
      if (!token) throw new HTTPException(401, { message: '未登入' });
      email = await verifyAccessJwt(token, c.env, resolveJwks);
    }

    const user = await findUserByEmail(c.env.DB, email);
    if (!user) throw new HTTPException(403, { message: '此帳號未被授權使用' });

    c.set('user', user);
    await next();
  });
}

/** 只允許 admin。所有寫入 API 都要掛（SPEC §8）。 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.user.role !== 'admin') throw new HTTPException(403, { message: '需要管理者權限' });
  await next();
});

/** 讀取權限：admin 可讀任何人；其他人只能讀自己的 user_id。 */
export function canReadUser(user: AuthUser, targetUserId: number): boolean {
  return user.role === 'admin' || user.id === targetUserId;
}

export function assertCanReadUser(user: AuthUser, targetUserId: number): void {
  if (!canReadUser(user, targetUserId)) throw new HTTPException(403, { message: '無權查看此帳本' });
}

import type { Role } from '@mystock/shared';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** 'production' | 'development'。只有 development 才允許 dev bypass。 */
  ENVIRONMENT: string;
  /** 例：https://myteam.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application 的 Audience (AUD) tag */
  ACCESS_AUD: string;
  /** 本機開發模擬登入的 email（只在 ENVIRONMENT=development 生效） */
  DEV_AUTH_EMAIL?: string;
}

/** 已登入並對應到 users 表的身分。 */
export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  role: Role;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
  };
};

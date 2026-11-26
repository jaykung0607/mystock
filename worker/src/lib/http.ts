import { zValidator } from '@hono/zod-validator';
import { HTTPException } from 'hono/http-exception';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';

export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

export function notFound(message = '找不到資料'): never {
  throw new HTTPException(404, { message });
}

export function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

/** zod 驗證；失敗回 400，訊息列出欄位。 */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`)
        .join('; ');
      badRequest(`輸入格式錯誤 — ${msg}`);
    }
  });
}

export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) badRequest('id 格式錯誤');
  return id;
}

/** D1 FK RESTRICT 失敗的錯誤訊息判斷。 */
export function isForeignKeyError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message);
}

export function isUniqueError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

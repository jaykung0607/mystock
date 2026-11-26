/** 抓價 adapter 共用。 */

export type Fetch = typeof fetch;

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    /** 對方限流或封鎖（回 HTML 安全頁、307/403/429）：這次執行應停止再打同一來源 */
    readonly blocked = false,
  ) {
    super(`[${source}] ${message}`);
    this.name = 'SourceError';
  }
}

/** 台股收盤價字串 "2,230.00" → "2230"；"--"、"----"、空白、0 → null（當日無成交）。 */
export function parsePrice(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replaceAll(',', '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  if (Number(s) === 0) return null;
  // 去掉多餘的 0："2230.00" → "2230"、"95.70" → "95.7"
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const TIMEOUT_MS = 20_000;

export async function getJson(fetcher: Fetch, source: string, url: string, init?: RequestInit): Promise<unknown> {
  const text = await getText(fetcher, source, url, init);
  try {
    return JSON.parse(text);
  } catch {
    // TWSE 限流時回 200 + HTML「因為安全性考量，您所執行的頁面無法呈現」
    const html = /^\s*</.test(text);
    throw new SourceError(source, html ? '回應 HTML（可能被限流或封鎖）' : `回應不是 JSON：${text.slice(0, 80)}`, html);
  }
}

export async function getText(fetcher: Fetch, source: string, url: string, init?: RequestInit): Promise<string> {
  let res: Response;
  try {
    res = await fetcher(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new SourceError(source, `連線失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new SourceError(source, `HTTP ${res.status}`, [307, 403, 429, 502].includes(res.status));
  return res.text();
}

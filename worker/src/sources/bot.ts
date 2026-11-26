import { type Fetch, getText, parsePrice, SourceError } from './common';

/**
 * 台灣銀行牌告匯率 CSV：https://rate.bot.com.tw/xrt/flcsv/0/day
 *
 * ⚠ 待驗證：開發環境抓取時台銀回傳機器人驗證頁（HTML），無法確認實際格式。
 * 依公開說明，每列為：
 *   幣別, 本行買入, 現金, 即期, 遠期10天…遠期180天, 本行賣出, 現金, 即期, 遠期…
 * 解析時不依固定欄位位置，而是找「本行賣出」之後第 2 欄（即期賣出）。
 * 若收到 HTML（驗證頁）就丟錯，讓排程回報並由 admin 手動補匯率。
 */
export function parseBotDayCsv(text: string): Map<string, string> {
  const body = text.replace(/^﻿/, '');
  if (/^\s*</.test(body)) throw new SourceError('bot', '收到 HTML（可能是機器人驗證頁），不是 CSV');
  const rates = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim());
    const currency = cols[0] ?? '';
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    const sellIdx = cols.indexOf('本行賣出');
    if (sellIdx < 0) continue;
    const spotSell = parsePrice(cols[sellIdx + 2]);
    if (spotSell) rates.set(currency, spotSell);
  }
  if (rates.size === 0) throw new SourceError('bot', `CSV 格式無法解析：${body.slice(0, 80)}`);
  return rates;
}

export async function fetchBotSpotSell(fetcher: Fetch): Promise<Map<string, string>> {
  return parseBotDayCsv(await getText(fetcher, 'bot', 'https://rate.bot.com.tw/xrt/flcsv/0/day'));
}

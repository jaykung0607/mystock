/** 日期工具。日期字串一律 YYYY-MM-DD。台灣 UTC+8 無夏令時間；美東用 Intl 處理夏令。 */

const DAY_MS = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parse(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** 台灣時間的日期與分鐘（0–1439）。 */
export function taipeiNow(now: Date): { date: string; minutes: number; weekday: number } {
  const t = new Date(now.getTime() + 8 * 3_600_000);
  return { date: ymd(t), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday: t.getUTCDay() };
}

const nyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

/** 美東時間的日期與分鐘。 */
export function newYorkNow(now: Date): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(nyFormat.formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parse(date).getUTCDay(),
  };
}

/** Unix 秒 → 美東日期。 */
export function newYorkDateOf(unixSeconds: number): string {
  return newYorkNow(new Date(unixSeconds * 1000)).date;
}

export function addDays(date: string, days: number): string {
  return ymd(new Date(parse(date).getTime() + days * DAY_MS));
}

export function isWeekend(date: string): boolean {
  const d = parse(date).getUTCDay();
  return d === 0 || d === 6;
}

/** from..to（含）之間的平日，由新到舊。 */
export function weekdaysDesc(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = to; d >= from; d = addDays(d, -1)) if (!isWeekend(d)) out.push(d);
  return out;
}

/** a 之後到 b（含）之間有幾個平日。a >= b 時為 0。 */
export function weekdaysAfter(a: string, b: string): number {
  let n = 0;
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

/** 民國日期 "115/11/24" 或 "1151124" → "2026-11-24"。 */
export function rocToIso(roc: string): string | null {
  const m = roc.trim().match(/^(\d{2,3})\/?(\d{2})\/?(\d{2})$/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
}

export function compact(date: string): string {
  return date.replaceAll('-', '');
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

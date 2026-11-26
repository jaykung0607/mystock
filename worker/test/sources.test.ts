import { describe, expect, it } from 'vitest';
import { addDays, newYorkNow, rocToIso, taipeiNow, weekdaysAfter, weekdaysDesc } from '../src/lib/dates';
import { lastClosedUsSession } from '../src/jobs/daily';
import { parseBotDayCsv } from '../src/sources/bot';
import { parsePrice, SourceError } from '../src/sources/common';
import { parseMis } from '../src/sources/mis';
import { parseTpex, parseTwse } from '../src/sources/tw';
import { parseFinnhubQuote, parseYahooDaily, parseYahooQuote } from '../src/sources/us';
import tpexDay from './fixtures/tpex_otc_20261124.json';
import tpexHoliday from './fixtures/tpex_otc_holiday.json';
import twseDay from './fixtures/twse_mi_index_20261124.json';
import twseHoliday from './fixtures/twse_mi_index_holiday.json';

describe('parsePrice', () => {
  it.each([
    ['2,230.00', '2230'],
    ['95.70', '95.7'],
    ['26.47', '26.47'],
    ['10', '10'],
    ['--', null],
    ['----', null],
    ['0.00', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (raw, expected) => expect(parsePrice(raw)).toBe(expected));
});

describe('日期工具', () => {
  it('台灣時間', () => {
    expect(taipeiNow(new Date('2026-11-24T16:30:00Z'))).toEqual({ date: '2026-11-25', minutes: 30, weekday: 3 });
  });
  it('美東時間（含夏令）', () => {
    expect(newYorkNow(new Date('2026-07-01T20:30:00Z')).minutes).toBe(16 * 60 + 30); // EDT UTC-4
    expect(newYorkNow(new Date('2026-12-01T21:30:00Z')).minutes).toBe(16 * 60 + 30); // EST UTC-5
  });
  it('最近已收盤的美股交易日', () => {
    expect(lastClosedUsSession(new Date('2026-11-24T22:30:00Z'))).toBe('2026-11-24'); // 週二收盤後
    expect(lastClosedUsSession(new Date('2026-11-24T15:00:00Z'))).toBe('2026-11-23'); // 週二盤中
    expect(lastClosedUsSession(new Date('2026-11-23T10:00:00Z'))).toBe('2026-11-20'); // 週一開盤前 → 上週五
  });
  it('民國日期', () => {
    expect(rocToIso('115/11/24')).toBe('2026-11-24');
    expect(rocToIso('1151124')).toBe('2026-11-24');
    expect(rocToIso('x')).toBeNull();
  });
  it('平日', () => {
    expect(weekdaysDesc('2026-11-20', '2026-11-24')).toEqual(['2026-11-24', '2026-11-23', '2026-11-20']);
    expect(weekdaysAfter('2026-11-20', '2026-11-24')).toBe(2);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('TWSE（實際回應）', () => {
  it('解析收盤價，略過無成交', () => {
    const r = parseTwse(twseDay, '2026-11-24');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.closes.get('2330')).toBe('2230');
    expect(r.closes.get('006208')).toBe('215.1');
    expect(r.closes.get('0050')).toBe('95.7');
    expect(r.closes.has('00625K')).toBe(false);
  });
  it('休市 → empty', () => {
    expect(parseTwse(twseHoliday, '2026-11-22')).toEqual({ status: 'empty' });
    expect(parseTwse({ stat: '查詢日期大於今日，請重新查詢!' }, '2026-12-01')).toEqual({ status: 'empty' });
  });
  it('日期不符或格式異常 → 錯誤', () => {
    expect(() => parseTwse(twseDay, '2026-11-25')).toThrow(SourceError);
    expect(() => parseTwse({ stat: '系統忙碌' }, '2026-11-24')).toThrow(SourceError);
  });
});

describe('TPEx（實際回應）', () => {
  it('解析收盤價，略過無成交', () => {
    const r = parseTpex(tpexDay, '2026-11-24');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.closes.get('6488')).toBe('506');
    expect(r.closes.get('00679B')).toBe('26.47');
    expect(r.closes.has('00734B')).toBe(false);
  });
  it('休市 → empty', () => {
    expect(parseTpex(tpexHoliday, '2026-11-22')).toEqual({ status: 'empty' });
  });
});

describe('台銀匯率 CSV（格式待驗證）', () => {
  const csv = [
    '﻿幣別,匯率,現金,即期,遠期10天,遠期30天,遠期60天,遠期90天,遠期120天,遠期150天,遠期180天,匯率,現金,即期,遠期10天,遠期30天,遠期60天,遠期90天,遠期120天,遠期150天,遠期180天',
    'USD        ,本行買入,31.89,32.215,32.18,32.13,32.06,31.99,31.92,31.85,31.78,本行賣出,32.56,32.365,32.33,32.28,32.21,32.14,32.07,32.00,31.93',
    'JPY        ,本行買入,0.2005,0.2075,0.2079,0.2085,0.2094,0.2103,0.2111,0.212,0.2129,本行賣出,0.2133,0.2125,0.2131,0.2138,0.2148,0.2157,0.2166,0.2175,0.2184',
  ].join('\r\n');

  it('取即期賣出', () => {
    const r = parseBotDayCsv(csv);
    expect(r.get('USD')).toBe('32.365');
    expect(r.get('JPY')).toBe('0.2125');
  });
  it('收到驗證頁 HTML → 錯誤', () => {
    expect(() => parseBotDayCsv('<!DOCTYPE html><html><title>Challenge Validation</title>')).toThrow(/HTML/);
  });
  it('無法解析 → 錯誤', () => {
    expect(() => parseBotDayCsv('a,b,c')).toThrow(SourceError);
  });
});

describe('美股（格式待驗證）', () => {
  const chart = {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: 231.456, regularMarketTime: 1764018000 },
          timestamp: [1763735400, 1763994600, 1764081000],
          indicators: { quote: [{ close: [228.1, null, 231.456] }] },
        },
      ],
      error: null,
    },
  };
  it('Yahoo 日線：時間轉美東日期、略過 null', () => {
    expect(parseYahooDaily(chart)).toEqual([
      { date: '2025-11-21', close: '228.1' },
      { date: '2025-11-25', close: '231.456' },
    ]);
  });
  it('Yahoo 即時', () => {
    expect(parseYahooQuote(chart)).toEqual({ price: '231.456', time: 1764018000 });
  });
  it('Yahoo 錯誤', () => {
    expect(() => parseYahooDaily({ chart: { result: null, error: { description: 'No data found' } } })).toThrow(
      /No data/,
    );
  });
  it('Finnhub quote', () => {
    expect(parseFinnhubQuote({ c: 231.5, pc: 230, t: 1764018000 })).toEqual({ price: '231.5', time: 1764018000 });
    expect(parseFinnhubQuote({ c: 0, t: 0 })).toBeNull();
    expect(() => parseFinnhubQuote({ error: 'Invalid API key' })).toThrow(/Invalid/);
  });
});

describe('台股盤中（格式待驗證）', () => {
  it('取最近成交價，無成交略過，格式不對回空', () => {
    const r = parseMis({
      msgArray: [
        { c: '2330', z: '2235.0000', tlong: '1764122400000' },
        { c: '6488', z: '-', tlong: '1764122400000' },
      ],
    });
    expect(r.get('2330')).toEqual({ price: '2235', time: 1764122400 });
    expect(r.has('6488')).toBe(false);
    expect(parseMis('oops').size).toBe(0);
  });
});

import { TtlCache } from './cache';
import { getJson, UpstreamError } from './http';

// Yahoo's chart endpoint needs no key, covers stocks, ETFs and mutual funds, and returns the
// intraday series in the same call. It's unofficial, so everything here degrades to cached data.
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36' };

export type MarketState = 'pre' | 'open' | 'post' | 'closed' | 'nav';

export interface Quote {
  symbol: string;
  name: string;
  kind: 'equity' | 'fund';
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  /** ms epoch of the last trade, or of the NAV for a fund */
  asOf: number;
  market: MarketState;
  /** regular session bounds (ms), so the client can place the intraday line on a full-day axis */
  session?: { start: number; end: number };
  series: { t: number; v: number }[];
}

interface Period { start: number; end: number }
interface TradingPeriods { pre?: Period; regular?: Period; post?: Period }

interface ChartResult {
  meta: {
    symbol?: string;
    longName?: string;
    shortName?: string;
    instrumentType?: string;
    regularMarketPrice: number;
    regularMarketTime: number;
    chartPreviousClose?: number;
    previousClose?: number;
    currentTradingPeriod?: TradingPeriods;
  };
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
}

const inside = (s: number, p?: Period) => Boolean(p && s >= p.start && s < p.end);

export function marketState(nowMs: number, periods?: TradingPeriods): MarketState {
  const s = nowMs / 1000;
  if (inside(s, periods?.regular)) return 'open';
  if (inside(s, periods?.pre)) return 'pre';
  if (inside(s, periods?.post)) return 'post';
  return 'closed';
}

export function seriesFrom(r: ChartResult): { t: number; v: number }[] {
  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  return ts
    .map((t, i) => ({ t: t * 1000, v: closes[i] }))
    .filter((p): p is { t: number; v: number } => typeof p.v === 'number');
}

async function chart(symbol: string, range: string, interval: string): Promise<ChartResult> {
  const url = `${YAHOO}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  let data: { chart?: { result?: ChartResult[] } };
  try {
    data = await getJson(url, HEADERS);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) throw new UpstreamError(`No symbol called ${symbol}`, 404);
    throw err;
  }
  const result = data.chart?.result?.[0];
  if (!result?.meta?.regularMarketPrice) throw new UpstreamError(`No symbol called ${symbol}`, 404);
  return result;
}

const cache = new TtlCache<Quote>(60_000);

export function getQuote(symbol: string): Promise<Quote> {
  return cache.get(symbol, async () => {
    const day = await chart(symbol, '1d', '5m');
    const m = day.meta;
    const fund = m.instrumentType === 'MUTUALFUND';
    const price = m.regularMarketPrice;
    const prev = m.chartPreviousClose ?? m.previousClose ?? price;
    const quote: Quote = {
      symbol: m.symbol ?? symbol,
      name: m.longName ?? m.shortName ?? symbol,
      kind: fund ? 'fund' : 'equity',
      price,
      prevClose: prev,
      change: price - prev,
      changePct: prev ? ((price - prev) / prev) * 100 : 0,
      asOf: m.regularMarketTime * 1000,
      market: fund ? 'nav' : marketState(Date.now(), m.currentTradingPeriod),
      series: [],
    };
    if (fund) {
      // A fund prices once a day, so an intraday line would be flat. Show 30 days instead.
      quote.series = seriesFrom(await chart(symbol, '1mo', '1d'));
    } else {
      quote.series = seriesFrom(day);
      const reg = m.currentTradingPeriod?.regular;
      if (reg) quote.session = { start: reg.start * 1000, end: reg.end * 1000 };
    }
    return quote;
  });
}

export const INDEXES = [
  { label: 'S&P', symbol: '^GSPC' },
  { label: 'Nasdaq', symbol: '^IXIC' },
  { label: 'Dow', symbol: '^DJI' },
];

export async function getQuotes(symbols: string[], withIndexes: boolean) {
  const settled = await Promise.allSettled(symbols.map(getQuote));
  const quotes = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { symbol: symbols[i], error: (r.reason as Error).message },
  );
  let indexes: { label: string; changePct: number }[] = [];
  if (withIndexes) {
    const idx = await Promise.allSettled(INDEXES.map((x) => getQuote(x.symbol)));
    indexes = INDEXES.flatMap((x, i) => {
      const r = idx[i];
      return r.status === 'fulfilled' ? [{ label: x.label, changePct: r.value.changePct }] : [];
    });
  }
  return { quotes, indexes };
}

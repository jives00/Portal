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
  kind: 'equity' | 'fund' | 'index';
  /** short display name for an index (S&P 500), since ^GSPC means nothing at a glance */
  label?: string;
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
    const index = m.instrumentType === 'INDEX';
    const sym = m.symbol ?? symbol;
    const price = m.regularMarketPrice;
    const prev = m.chartPreviousClose ?? m.previousClose ?? price;
    const quote: Quote = {
      symbol: sym,
      name: m.longName ?? m.shortName ?? symbol,
      kind: fund ? 'fund' : index ? 'index' : 'equity',
      label: index ? INDEX_LABELS[sym] ?? m.shortName ?? sym : undefined,
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

const INDEX_LABELS: Record<string, string> = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'Nasdaq',
  '^DJI': 'Dow',
  '^RUT': 'Russell 2000',
  '^VIX': 'VIX',
};

/** The main US indexes, offered as one-tap adds in Settings → Stocks. */
export const INDEXES = Object.entries(INDEX_LABELS).map(([symbol, label]) => ({ symbol, label }));

// Index symbols start with ^, which nobody types. Map the names people do type.
const ALIASES: Record<string, string> = {
  SPX: '^GSPC', 'S&P': '^GSPC', 'S&P500': '^GSPC', SP500: '^GSPC', GSPC: '^GSPC',
  NASDAQ: '^IXIC', COMP: '^IXIC', IXIC: '^IXIC',
  DOW: '^DJI', DJIA: '^DJI', DJI: '^DJI',
  RUSSELL: '^RUT', RUSSELL2000: '^RUT', RUT: '^RUT',
  VIX: '^VIX',
};
export const resolveSymbol = (input: string) => {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  return ALIASES[s] ?? s;
};

export async function getQuotes(symbols: string[]) {
  const settled = await Promise.allSettled(symbols.map(getQuote));
  return {
    quotes: settled.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { symbol: symbols[i], error: (r.reason as Error).message },
    ),
  };
}

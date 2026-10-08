import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { marketState, resolveSymbol, seriesFrom } from '../src/quotes';
import { DEFAULTS, SettingsStore } from '../src/settings';
import { probeUrl } from '../src/status';

describe('SettingsStore', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-set-')), 'settings.json');
  const quiet = { warn: () => {} };

  it('starts from defaults and persists changes', () => {
    const file = tmp();
    const store = new SettingsStore(file, quiet);
    expect(store.get().tickers).toEqual(['VBIAX', 'VOO', 'AMZN']);
    store.set({ ...store.get(), tickers: ['MSFT'] });
    expect(new SettingsStore(file, quiet).get().tickers).toEqual(['MSFT']);
  });

  it('fills in fields missing from an older settings file', () => {
    const file = tmp();
    const { weather: _w, ...old } = DEFAULTS;
    fs.writeFileSync(file, JSON.stringify(old));
    expect(new SettingsStore(file, quiet).get().weather.unit).toBe('F');
  });

  it('turns the old index row into watchlist rows', () => {
    const file = tmp();
    fs.writeFileSync(file, JSON.stringify({ ...DEFAULTS, tickers: ['VOO', '^DJI'], showIndexes: true }));
    const s = new SettingsStore(file, quiet).get();
    expect(s.tickers).toEqual(['VOO', '^DJI', '^GSPC', '^IXIC']);
    expect(s).not.toHaveProperty('showIndexes');
  });

  it('rejects invalid settings without changing what is saved', () => {
    const store = new SettingsStore(tmp(), quiet);
    expect(() => store.set({ ...store.get(), tickers: ['not a symbol'] })).toThrow();
    expect(() => store.set({ ...store.get(), cards: [{ id: 'scores', on: true }, { id: 'scores', on: true }, { id: 'camera', on: true }] })).toThrow();
    expect(store.get().tickers).toEqual(DEFAULTS.tickers);
  });
});

describe('resolveSymbol', () => {
  it.each([
    ['spx', '^GSPC'],
    ['S&P 500', '^GSPC'],
    ['Dow', '^DJI'],
    ['nasdaq', '^IXIC'],
    [' msft ', 'MSFT'],
    ['^RUT', '^RUT'],
  ])('%s → %s', (input, expected) => {
    expect(resolveSymbol(input)).toBe(expected);
  });
});

describe('marketState', () => {
  const periods = {
    pre: { start: 100, end: 200 },
    regular: { start: 200, end: 300 },
    post: { start: 300, end: 400 },
  };
  it.each([
    [150, 'pre'],
    [250, 'open'],
    [350, 'post'],
    [450, 'closed'],
  ])('at %ss it is %s', (s, expected) => {
    expect(marketState(s * 1000, periods)).toBe(expected);
  });
  it('is closed without trading periods', () => {
    expect(marketState(Date.now())).toBe('closed');
  });
});

describe('seriesFrom', () => {
  it('drops gaps in the close series', () => {
    expect(seriesFrom({ meta: {} as never, timestamp: [1, 2, 3], indicators: { quote: [{ close: [10, null, 12] }] } })).toEqual([
      { t: 1000, v: 10 },
      { t: 3000, v: 12 },
    ]);
  });
});

describe('probeUrl', () => {
  it('swaps the Tailscale name for the NAS LAN address', () => {
    expect(probeUrl('http://synology:3006/x', '192.168.0.105')).toBe('http://192.168.0.105:3006/x');
    expect(probeUrl('https://example.com/', '192.168.0.105')).toBe('https://example.com/');
  });
});

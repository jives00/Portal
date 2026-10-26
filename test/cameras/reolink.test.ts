import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverPrefixes, measure, parseReolink, reolinkDay, reolinkDays, sweepShare } from '../../src/cameras/reolink';
import { SettingsStore } from '../../src/cameras/settings';

let root: string;
let cache: string;
const OLD = Date.now() - 3600_000;

/** Writes a file under the share with an mtime an hour ago, so it counts as settled. */
function put(rel: string, body = 'x', mtime = OLD) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  fs.utimesSync(full, mtime / 1000, mtime / 1000);
}
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-share-'));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cache-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

describe('parseReolink', () => {
  it('reads the prefix, date and time from an upload', () => {
    expect(parseReolink('Driveway_00_20261024053509.mp4')).toEqual({ prefix: 'Driveway', date: '2026-10-24', t: 5 * 3600 + 35 * 60 + 9, ext: 'mp4' });
    expect(parseReolink('Back_Yard_01_20261024235959.jpg')).toMatchObject({ prefix: 'Back_Yard', t: 86399, ext: 'jpg' });
  });

  it('ignores everything else', () => {
    for (const name of ['Daily_Summary_2026-10-24.mp4', 'Driveway_00_20261324053509.mp4', 'Driveway_00_2026102405350.mp4', 'notes.txt']) {
      expect(parseReolink(name)).toBeNull();
    }
  });
});

describe('reolinkDay', () => {
  it('lists clips with probed lengths and stills, placed by their own timestamps', async () => {
    put('2026/10/24/Driveway_00_20261024053509.mp4');
    put('2026/10/24/Driveway_00_20261024053514.jpg');
    put('2026/10/24/Other_00_20261024060000.mp4');
    put('2026/10/24/Daily_Summary_2026-10-23.mp4');
    // Started before midnight, uploaded after: lives in the next day's folder.
    put('2026/10/25/Driveway_00_20261024235950.mp4');
    put('2026/10/25/Driveway_00_20261025000500.mp4');
    const probe = vi.fn(async () => 8.32);

    const day = await reolinkDay(root, 'Driveway', '2026-10-24', probe, cache);
    expect(day.events).toEqual([
      { t: 20109, kind: 'motion', duration: 8, file: '2026/10/24/Driveway_00_20261024053509.mp4' },
      { t: 86390, kind: 'motion', duration: 8, file: '2026/10/25/Driveway_00_20261024235950.mp4' },
    ]);
    expect(day.snapshots).toEqual([{ t: 20114, file: '2026/10/24/Driveway_00_20261024053514.jpg' }]);
    expect(probe).toHaveBeenCalledTimes(2);

    // Lengths are cached, so a second look doesn't probe again.
    await reolinkDay(root, 'Driveway', '2026-10-24', probe, cache);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('skips uploads still being written', async () => {
    put('2026/10/24/Driveway_00_20261024053509.mp4', 'x', Date.now());
    const day = await reolinkDay(root, 'Driveway', '2026-10-24', async () => 5, cache);
    expect(day.events).toEqual([]);
  });

  it('finds prefixes and the days each camera has footage', () => {
    put('2026/10/23/Driveway_00_20261023100000.mp4');
    put('2026/10/24/Driveway_00_20261024100000.jpg');
    put('2026/10/24/Garage_00_20261024100000.mp4');
    put('Sentry/front-door/2026/10/24/events/10-00-00_motion_60s.mp4');
    expect(discoverPrefixes(root)).toEqual(['Driveway', 'Garage']);
    expect(reolinkDays(root, 'Driveway')).toEqual(['2026-10-24', '2026-10-23']);
  });
});

describe('sweepShare', () => {
  const now = new Date(2026, 9, 25, 12);

  it('deletes only old uploads from known cameras and old summaries', () => {
    put('2026/10/20/Driveway_00_20261020100000.mp4');
    put('2026/10/20/Driveway_00_20261020100005.jpg');
    put('2026/10/20/Unknown_00_20261020100000.mp4');
    put('2026/10/20/keep-me.txt');
    put('2026/10/20/Daily_Summary_2026-10-20.mp4');
    put('2026/10/24/Driveway_00_20261024100000.mp4');
    put('2026/10/24/Daily_Summary_2026-10-24.mp4');
    put('Sentry/front-door/2026/10/01/events/10-00-00_motion_60s.mp4');

    const n = sweepShare(root, ['Driveway'], { clipDays: 2, summaryDays: 3 }, now);
    expect(n).toBe(3);
    expect(exists('2026/10/20/Driveway_00_20261020100000.mp4')).toBe(false);
    expect(exists('2026/10/20/Driveway_00_20261020100005.jpg')).toBe(false);
    expect(exists('2026/10/20/Daily_Summary_2026-10-20.mp4')).toBe(false);
    expect(exists('2026/10/20/Unknown_00_20261020100000.mp4')).toBe(true);
    expect(exists('2026/10/20/keep-me.txt')).toBe(true);
    expect(exists('2026/10/24/Driveway_00_20261024100000.mp4')).toBe(true);
    expect(exists('2026/10/24/Daily_Summary_2026-10-24.mp4')).toBe(true);
    expect(exists('Sentry/front-door/2026/10/01/events/10-00-00_motion_60s.mp4')).toBe(true);
  });

  it('never keeps less than yesterday, whatever it is told', () => {
    put('2026/10/24/Driveway_00_20261024100000.mp4');
    put('2026/10/23/Driveway_00_20261023100000.mp4');
    sweepShare(root, ['Driveway'], { clipDays: 0, summaryDays: 0 }, now);
    expect(exists('2026/10/24/Driveway_00_20261024100000.mp4')).toBe(true);
    expect(exists('2026/10/23')).toBe(false);
  });

  it('removes day, month and year folders it empties', () => {
    put('2025/12/31/Driveway_00_20251231100000.mp4');
    put('2026/10/24/Driveway_00_20261024100000.mp4');
    sweepShare(root, ['Driveway'], { clipDays: 30, summaryDays: 30 }, now);
    expect(exists('2025')).toBe(false);
    expect(exists('2026/10/24')).toBe(true);
  });
});

describe('measure', () => {
  it('adds up bytes per camera and type', async () => {
    put('2026/10/24/Driveway_00_20261024100000.mp4', 'a'.repeat(100));
    put('2026/10/24/Driveway_00_20261024100005.jpg', 'a'.repeat(10));
    put('2026/10/24/Daily_Summary_2026-10-24.mp4', 'a'.repeat(1000));
    put('Sentry/front-door/2026/10/24/events/10-00-00_motion_60s.mp4', 'a'.repeat(50));
    put('Sentry/front-door/2026/10/24/snapshots/10-00-00.jpg', 'a'.repeat(5));
    const u = await measure(root, path.join(root, 'Sentry'), [{ slug: 'front-door' }], { Driveway: { slug: 'driveway' } });
    expect(u.cameras).toEqual({ 'front-door': { clips: 50, snapshots: 5 }, driveway: { clips: 100, snapshots: 10 } });
    expect(u.summaries).toBe(1000);
  });
});

describe('camera settings', () => {
  it('reads an old Sentry settings file and gives Reolink cameras slugs that do not clash', () => {
    const file = path.join(cache, 'cameras.json');
    const ring = { name: 'Driveway', slug: 'driveway', location: 'loc', enabled: true };
    fs.writeFileSync(file, JSON.stringify({ snapshotDays: 30, eventDays: 90, snapshotInterval: 30, clipLength: 60, cameras: { abc: ring } }));
    const store = new SettingsStore(file, { warn: () => {} });
    expect(store.get().reolink).toEqual({ clipDays: 90, summaryDays: 14, cameras: {} });
    expect(store.addReolink('Driveway', 'driveway')).toEqual({ name: 'Driveway', slug: 'driveway-2' });

    const next = structuredClone(store.get());
    next.reolink.cameras.Driveway = { name: 'Drive', slug: 'hacked' };
    next.reolink.clipDays = 1;
    expect(() => store.set(next)).toThrow();
    next.reolink.clipDays = 30;
    expect(store.set(next).reolink.cameras.Driveway).toEqual({ name: 'Drive', slug: 'driveway-2' });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverPrefixes, measure, parseReolink, reolinkDay, reolinkDays, sweepShare, uploadFolders } from '../../src/cameras/reolink';
import { SettingsStore, maskRtsp, publicSettings } from '../../src/cameras/settings';

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
const hevc = async () => ({ duration: 8.32, codec: 'hevc' });

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
    for (const name of ['Daily_Summary_2026-10-24.mp4', 'Driveway_00_20261324053509.mp4', 'Driveway_00_2026102405350.mp4', 'FrontDoor_00_20261118120031.txt']) {
      expect(parseReolink(name)).toBeNull();
    }
  });
});

describe('reolinkDay', () => {
  it('lists clips with probed lengths and codecs and stills, placed by their own timestamps', async () => {
    const dir = path.join(root, 'Driveway');
    put('Driveway/2026/10/24/Driveway_00_20261024053509.mp4');
    put('Driveway/2026/10/24/Driveway_00_20261024053514.jpg');
    put('Driveway/2026/10/24/Other_00_20261024060000.mp4');
    // Started before midnight, uploaded after: lives in the next day's folder.
    put('Driveway/2026/10/25/Driveway_00_20261024235950.mp4');
    put('Driveway/2026/10/25/Driveway_00_20261025000500.mp4');
    const probe = vi.fn(hevc);

    const day = await reolinkDay(dir, 'Driveway', '2026-10-24', probe, cache);
    expect(day.events).toEqual([
      { t: 20109, kind: 'motion', duration: 8, file: '2026/10/24/Driveway_00_20261024053509.mp4', hevc: true },
      { t: 86390, kind: 'motion', duration: 8, file: '2026/10/25/Driveway_00_20261024235950.mp4', hevc: true },
    ]);
    expect(day.snapshots).toEqual([{ t: 20114, file: '2026/10/24/Driveway_00_20261024053514.jpg' }]);
    expect(probe).toHaveBeenCalledTimes(2);

    // Cached, so a second look doesn't probe again.
    await reolinkDay(dir, 'Driveway', '2026-10-24', probe, cache);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('re-probes cache entries from before codecs were recorded', async () => {
    put('2026/10/24/FrontDoor_00_20261024100000.mp4');
    fs.writeFileSync(path.join(cache, 'FrontDoor-2026-10-24.json'), JSON.stringify({ 'FrontDoor_00_20261024100000.mp4': { size: 1, duration: 52 } }));
    const day = await reolinkDay(root, 'FrontDoor', '2026-10-24', async () => ({ duration: 52, codec: 'h264' }), cache);
    expect(day.events[0]).toMatchObject({ duration: 52, hevc: false });
  });

  it('skips uploads still being written', async () => {
    put('2026/10/24/Driveway_00_20261024053509.mp4', 'x', Date.now());
    const day = await reolinkDay(root, 'Driveway', '2026-10-24', hevc, cache);
    expect(day.events).toEqual([]);
  });

  it('finds prefixes and the days each camera has footage', () => {
    put('2026/10/23/Driveway_00_20261023100000.mp4');
    put('2026/10/24/Driveway_00_20261024100000.jpg');
    put('2026/10/24/Garage_00_20261024100000.mp4');
    expect(discoverPrefixes(root)).toEqual(['Driveway', 'Garage']);
    expect(reolinkDays(root, 'Driveway')).toEqual(['2026-10-24', '2026-10-23']);
  });
});

describe('camera folders', () => {
  it('finds folders with a day tree, but not year folders, Sentry or other folders', () => {
    put('2026/10/24/Driveway_00_20261024100000.mp4');
    put('FrontDoor/2026/10/24/FrontDoor_00_20261024100000.mp4');
    put('Driveway/2026/10/24/Driveway_00_20261024100000.mp4');
    put('Sentry/front-door/2026/10/24/events/10-00-00_motion_60s.mp4');
    put('#recycle/2026/10/24/x.mp4');
    put('Notes/readme.txt');
    expect(uploadFolders(root, ['Sentry'])).toEqual(['Driveway', 'FrontDoor']);
  });
});

describe('sweepShare', () => {
  const now = new Date(2026, 9, 25, 12);

  it("deletes only old uploads from the folder's own cameras, then empty folders", () => {
    put('Driveway/2026/10/20/Driveway_00_20261020100000.mp4');
    put('Driveway/2026/10/20/Driveway_00_20261020100005.jpg');
    put('Driveway/2026/10/20/Unknown_00_20261020100000.mp4');
    put('Driveway/2026/10/21/Driveway_00_20261021100000.mp4');
    put('Driveway/2026/10/21/keep-me.txt');
    put('Driveway/2026/10/24/Driveway_00_20261024100000.mp4');
    put('Driveway/Summary/Driveway_2026-10-01.json');

    const n = sweepShare(path.join(root, 'Driveway'), ['Driveway'], 2, now);
    expect(n).toBe(3);
    expect(exists('Driveway/2026/10/20/Unknown_00_20261020100000.mp4')).toBe(true);
    expect(exists('Driveway/2026/10/21')).toBe(true); // keep-me.txt
    expect(exists('Driveway/2026/10/21/Driveway_00_20261021100000.mp4')).toBe(false);
    expect(exists('Driveway/2026/10/24/Driveway_00_20261024100000.mp4')).toBe(true);
    expect(exists('Driveway/Summary/Driveway_2026-10-01.json')).toBe(true); // summaries.ts's job
  });

  it('never keeps under two days', () => {
    put('Driveway/2026/10/24/Driveway_00_20261024100000.mp4');
    sweepShare(path.join(root, 'Driveway'), ['Driveway'], 0, now);
    expect(exists('Driveway/2026/10/24/Driveway_00_20261024100000.mp4')).toBe(true);
  });
});

describe('measure', () => {
  it('adds up bytes per camera: clips, stills and summaries, each in its own folder', async () => {
    put('Driveway/2026/10/24/Driveway_00_20261024100000.mp4', 'a'.repeat(100));
    put('Driveway/2026/10/24/Driveway_00_20261024100005.jpg', 'a'.repeat(10));
    put('Driveway/Summary/Driveway_2026-10-24_abc.mp4', 'a'.repeat(1000));
    put('FrontDoor/2026/10/24/FrontDoor_00_20261024100000.mp4', 'a'.repeat(40));
    // a stray Driveway file in the doorbell's folder isn't the driveway's
    put('FrontDoor/2026/10/24/Driveway_00_20261024100000.mp4', 'a'.repeat(7));
    const u = await measure(root, {
      Driveway: { slug: 'driveway', folder: 'Driveway' },
      FrontDoor: { slug: 'frontdoor', folder: 'FrontDoor' },
    });
    expect(u.cameras).toEqual({
      driveway: { clips: 100, snapshots: 10, summaries: 1000 },
      frontdoor: { clips: 40, snapshots: 0, summaries: 0 },
    });
  });
});

describe('camera settings', () => {
  const file = () => path.join(cache, 'cameras.json');

  it("migrates the old file (Ring settings plus a `reolink` block) and drops Ring's", () => {
    const ring = { name: 'Front Door', slug: 'front-door', location: 'loc', enabled: true };
    const reolink = { clipDays: 30, summaryDays: 7, cameras: { Driveway: { name: 'Driveway', slug: 'driveway' } } };
    fs.writeFileSync(file(), JSON.stringify({ snapshotDays: 30, eventDays: 90, snapshotInterval: 15, clipLength: 30, cameras: { abc: ring }, reolink }));
    const store = new SettingsStore(file(), { warn: () => {} });
    expect(store.get()).toEqual({ clipDays: 30, summaryDays: 7, cameras: { Driveway: { name: 'Driveway', slug: 'driveway', folder: '', rtsp: '' } } });
  });

  it('keeps slugs and folders fixed, and drops cameras it never saw', () => {
    const store = new SettingsStore(file(), { warn: () => {} });
    expect(store.addCamera('FrontDoor', 'frontdoor', 'FrontDoor')).toEqual({ name: 'FrontDoor', slug: 'frontdoor', folder: 'FrontDoor', rtsp: '' });
    expect(store.addCamera('Front_Door', 'frontdoor').slug).toBe('frontdoor-2');
    const next = structuredClone(store.get());
    next.cameras.FrontDoor = { name: 'Front Door', slug: 'hacked', folder: '', rtsp: '' };
    (next.cameras as Record<string, unknown>).Ghost = { name: 'Ghost', slug: 'ghost', folder: '', rtsp: '' };
    next.clipDays = 1;
    expect(() => store.set(next)).toThrow();
    next.clipDays = 30;
    const saved = store.set(next);
    expect(saved.cameras.FrontDoor).toEqual({ name: 'Front Door', slug: 'frontdoor', folder: 'FrontDoor', rtsp: '' });
    expect(saved.cameras.Ghost).toBeUndefined();
    expect(store.moveCamera('FrontDoor', 'Porch')?.folder).toBe('Porch');
  });

  it('masks the RTSP password in the API and keeps it when the masked value comes back', () => {
    const store = new SettingsStore(file(), { warn: () => {} });
    store.addCamera('FrontDoor', 'frontdoor', 'FrontDoor');
    const url = 'rtsp://admin:s3cr@t:x@192.168.0.50:554/h264Preview_01_main';
    store.set({ ...store.get(), cameras: { FrontDoor: { ...store.get().cameras.FrontDoor, rtsp: url } } });
    const shown = publicSettings(store.get());
    expect(shown.cameras.FrontDoor.rtsp).toBe('rtsp://admin:••••@192.168.0.50:554/h264Preview_01_main');
    expect(store.set(shown).cameras.FrontDoor.rtsp).toBe(url);
    expect(maskRtsp('rtsp://192.168.0.50/live')).toBe('rtsp://192.168.0.50/live');
    expect(() => store.set({ ...shown, cameras: { FrontDoor: { ...shown.cameras.FrontDoor, rtsp: 'http://x' } } })).toThrow();
  });
});

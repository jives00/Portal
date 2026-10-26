import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dayIndex, expired, listDays, sweep } from '../../src/cameras/library';
import { eventName, parseEvent, parseSnapshot, slugify } from '../../src/cameras/paths';

describe('filenames', () => {
  it('round-trips an event name', () => {
    const name = eventName(new Date(2026, 9, 24, 14, 3, 12), 'ding', 46.6);
    expect(name).toBe('14-03-12_ding_47s.mp4');
    expect(parseEvent(name)).toEqual({ t: 14 * 3600 + 3 * 60 + 12, kind: 'ding', duration: 47 });
  });

  it('ignores in-progress and foreign files', () => {
    expect(parseEvent('14-03-12_motion_0s.mp4.part')).toBeNull();
    expect(parseEvent('Daily_Summary_2026-10-24.mp4')).toBeNull();
    expect(parseSnapshot('08-00-30-1.jpg')).toBe(8 * 3600 + 30);
    expect(parseSnapshot('08-00-30.jpg.part')).toBeNull();
  });

  it('slugifies camera names', () => {
    expect(slugify('Front Door')).toBe('front-door');
    expect(slugify("  Mom's   Porch!! ")).toBe('mom-s-porch');
    expect(slugify('***')).toBe('camera');
  });
});

describe('footage tree', () => {
  let root: string;
  beforeEach(() => (root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-'))));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const put = (rel: string) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  };

  it('lists days newest first and indexes one', () => {
    put('front-door/2026/10/23/snapshots/23-59-30.jpg');
    put('front-door/2026/10/24/snapshots/00-00-30.jpg');
    put('front-door/2026/10/24/snapshots/00-00-00.jpg');
    put('front-door/2026/10/24/events/00-00-10_motion_25s.mp4');
    put('front-door/2026/10/24/events/00-05-00_motion_0s.mp4.part');

    expect(listDays(root, 'front-door')).toEqual(['2026-10-24', '2026-10-23']);
    const day = dayIndex(root, 'front-door', '2026-10-24');
    expect(day.snapshots).toEqual([
      { t: 0, file: 'front-door/2026/10/24/snapshots/00-00-00.jpg' },
      { t: 30, file: 'front-door/2026/10/24/snapshots/00-00-30.jpg' },
    ]);
    expect(day.events).toEqual([{ t: 10, kind: 'motion', duration: 25, file: 'front-door/2026/10/24/events/00-00-10_motion_25s.mp4' }]);
  });

  it('rejects a malformed date', () => {
    expect(() => dayIndex(root, 'front-door', '../../etc')).toThrow();
  });

  it('keeps today plus keepDays-1 days', () => {
    const now = new Date(2026, 9, 24, 12);
    expect(expired(['2026-10-24', '2026-10-23', '2026-10-22', '2026-09-30'], 2, now)).toEqual(['2026-10-22', '2026-09-30']);
  });

  it('sweeps snapshots and events on their own schedules and prunes empty folders', () => {
    put('front-door/2026/08/01/snapshots/12-00-00.jpg');
    put('front-door/2026/08/01/events/12-00-00_motion_10s.mp4');
    put('front-door/2026/09/20/snapshots/12-00-00.jpg');
    put('front-door/2026/09/20/events/12-00-00_motion_10s.mp4');
    put('front-door/2026/10/24/snapshots/12-00-00.jpg');

    sweep(root, 'front-door', { snapshotDays: 30, eventDays: 40 }, new Date(2026, 9, 24, 12));

    expect(fs.existsSync(path.join(root, 'front-door/2026/08'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'front-door/2026/09/20/snapshots'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'front-door/2026/09/20/events/12-00-00_motion_10s.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'front-door/2026/10/24/snapshots/12-00-00.jpg'))).toBe(true);
  });
});

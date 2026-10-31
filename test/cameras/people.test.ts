import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoDay } from '../../src/cameras/paths';
import { MODEL_VERSION, PeopleCounter, clipPeople, countPeople, dayPeople, smooth } from '../../src/cameras/people';

/** A YOLOX output with one row per anchor; `put` writes a raw prediction into a grid cell. */
function output(size = 416) {
  const anchors = [8, 16, 32].reduce((n, s) => n + (size / s) ** 2, 0);
  const out = new Float32Array(anchors * 85);
  const put = (stride: number, gx: number, gy: number, o: { h: number; obj?: number; person?: number; w?: number }) => {
    let i = 0;
    for (const s of [8, 16, 32]) {
      if (s === stride) break;
      i += (size / s) ** 2;
    }
    const r = (i + gy * (size / stride) + gx) * 85;
    out[r + 2] = Math.log((o.w ?? o.h / 2) / stride);
    out[r + 3] = Math.log(o.h / stride);
    out[r + 4] = o.obj ?? 0.9;
    out[r + 5] = o.person ?? 0.9;
  };
  return { out, put };
}

describe('countPeople', () => {
  it('counts confident, close people', () => {
    const { out, put } = output();
    put(32, 3, 4, { h: 150 });
    put(32, 8, 4, { h: 120 });
    expect(countPeople(out, 234)).toBe(2);
  });

  it('drops low scores and people out by the street', () => {
    const { out, put } = output();
    put(32, 3, 4, { h: 150, person: 0.3 });
    put(8, 20, 10, { h: 20 });
    expect(countPeople(out, 234)).toBe(0);
  });

  it('merges overlapping boxes for one person', () => {
    const { out, put } = output();
    put(16, 10, 8, { h: 150 });
    put(32, 5, 4, { h: 150 });
    expect(countPeople(out, 234)).toBe(1);
  });
});

describe('arrivals', () => {
  it('ignores single-frame flicker', () => {
    expect(smooth([1, 1, 0, 1, 1, 2, 1, 1])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('counts each rise as new people', () => {
    // One at the door, two more walk up, everyone leaves, then a pair.
    const counts = [1, 1, 1, 1, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2];
    expect(clipPeople(counts)).toEqual({ people: 5, first: 1, last: 2 });
  });

  it('is zero for an empty clip', () => {
    expect(clipPeople([])).toEqual({ people: 0, first: 0, last: 0 });
    expect(clipPeople([0, 0, 0])).toEqual({ people: 0, first: 0, last: 0 });
  });

  it("doesn't count people twice across back-to-back clips", () => {
    const a = { t: 1000, duration: 60, people: 3, first: 1, last: 2 };
    const b = { t: 1070, duration: 60, people: 4, first: 2, last: 0 };
    expect(dayPeople([b, a])).toBe(5);
    expect(dayPeople([a, { ...b, t: 2000 }])).toBe(7);
  });
});

describe('PeopleCounter', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const counter = () =>
    new PeopleCounter({ footageRoot: dir, dir: path.join(dir, 'people'), model: 'none', slugs: () => [], log: { info() {}, warn() {} } });

  it('reports saved counts per clip and pending ones as null', () => {
    const today = isoDay(new Date());
    const day = path.join(dir, 'people', 'front-door');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, `${today}.json`),
      JSON.stringify({
        '18-00-00_motion_60s.mp4': { version: MODEL_VERSION, fps: 2, counts: [0, 2, 2, 2, 2, 0, 0, 0] },
        '18-05-00_ding_60s.mp4': { version: MODEL_VERSION, fps: 2, error: 'bad clip' },
      }),
    );
    const ev = (t: number, name: string) => ({ t, duration: 60, file: `front-door/2026/10/31/events/${name}` });
    const events = [ev(64800, '18-00-00_motion_60s.mp4'), ev(65100, '18-05-00_ding_60s.mp4'), ev(65400, '18-10-00_motion_60s.mp4')];
    const r = counter().forDay('front-door', today, events);
    expect(Object.values(r.byFile)).toEqual([2, null, null]);
    expect(r.total).toBe(2);
    expect(r.pending).toBe(true);
    expect(counter().forDay('front-door', '2020-01-01', events).pending).toBe(false);
  });

  it('drops counts past retention', () => {
    const day = path.join(dir, 'people', 'front-door');
    fs.mkdirSync(day, { recursive: true });
    for (const d of ['2026-01-01', '2026-10-31']) fs.writeFileSync(path.join(day, `${d}.json`), '{}');
    counter().sweep((days) => days.filter((d) => d < '2026-06-01'));
    expect(fs.readdirSync(day)).toEqual(['2026-10-31.json']);
  });
});

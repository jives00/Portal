import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLatest, summaryDate } from '../src/camera';

const folder = new Date(2026, 9, 8);

describe('summaryDate', () => {
  it.each([
    ['Daily_Summary_20261007.mp4', '2026-10-07'],
    ['Daily_Summary_2026-10-07.mp4', '2026-10-07'],
    ['Daily_Summary_10-07-2026.mp4', '2026-10-07'],
    ['Daily_Summary_10072026.mp4', '2026-10-07'],
  ])('reads %s', (name, expected) => {
    expect(summaryDate(name, folder)).toBe(expected);
  });

  it('falls back to the day before the folder date', () => {
    expect(summaryDate('Daily_Summary_yesterday.mp4', folder)).toBe('2026-10-07');
  });
});

describe('findLatest', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function put(day: Date, name: string, ageMs = 10 * 60_000) {
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
    return file;
  }

  it('picks the newest summary and ignores motion clips', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cam-'));
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400_000);
    put(yesterday, 'Daily_Summary_older.mp4');
    const latest = put(now, 'Daily_Summary_newest.mp4');
    put(now, 'Driveway_00_20261008091910.mp4');

    const found = findLatest(root, now.getTime());
    expect(found?.path).toBe(latest);
  });

  it('skips a summary that is still being written', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cam-'));
    const now = new Date();
    put(now, 'Daily_Summary_20991231.mp4', 10_000);
    expect(findLatest(root, now.getTime())).toBeNull();
  });

  it('returns null when the share has nothing yet', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cam-'));
    expect(findLatest(root)).toBeNull();
  });
});

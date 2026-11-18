import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SummaryBuilder, concatList, dueDays, findSummary } from '../../src/cameras/summaries';

let root: string;
let data: string;
const quiet = { info: () => {}, warn: () => {} };
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-sum-'));
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-data-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

const OLD = Date.now() - 3600_000;
/** A 1 s test clip (picture and tone) at `rel`, settled. */
function clip(rel: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', full]);
  fs.utimesSync(full, OLD / 1000, OLD / 1000);
}
const probe = async (file: string) => {
  const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString();
  return { duration: Number(d), codec: 'h264' };
};
const builder = () => new SummaryBuilder({ cameras: () => [], probe, cacheDir: path.join(data, 'cache'), tmpDir: path.join(data, 'tmp'), log: quiet });
const cam = () => ({ prefix: 'FrontDoor', slug: 'frontdoor', root });

describe('dueDays', () => {
  it('is the last three finished days, once the night has settled', () => {
    expect(dueDays(new Date(2026, 10, 18, 0, 10))).toEqual(['2026-11-16', '2026-11-15', '2026-11-14']);
    expect(dueDays(new Date(2026, 10, 18, 0, 40))).toEqual(['2026-11-17', '2026-11-16', '2026-11-15']);
  });
});

describe('concatList', () => {
  it("quotes paths for ffmpeg's concat demuxer", () => {
    expect(concatList(['/a/b.mp4', "/c/it's.mp4"])).toBe("file '/a/b.mp4'\nfile '/c/it'\\''s.mp4'\n");
  });
});

describe.skipIf(!hasFfmpeg)('building', () => {
  it('joins a day of clips, then rebuilds only when the clips change', async () => {
    clip('2026/11/17/FrontDoor_00_20261117100000.mp4');
    clip('2026/11/17/FrontDoor_00_20261117110000.mp4');
    const b = builder();
    expect(await b.ensure(cam(), '2026-11-17')).toBe(true);
    const first = findSummary(cam(), '2026-11-17')!;
    expect(first.clips).toEqual(['2026/11/17/FrontDoor_00_20261117100000.mp4', '2026/11/17/FrontDoor_00_20261117110000.mp4']);
    expect(first.duration).toBe(2);
    expect(fs.existsSync(path.join(root, first.video))).toBe(true);
    expect(fs.existsSync(path.join(root, first.poster))).toBe(true);

    expect(await b.ensure(cam(), '2026-11-17')).toBe(false);

    // A late upload (just before midnight, landed in the next day's folder) is added.
    clip('2026/11/18/FrontDoor_00_20261117235900.mp4');
    expect(await b.ensure(cam(), '2026-11-17')).toBe(true);
    const second = findSummary(cam(), '2026-11-17')!;
    expect(second.clips).toHaveLength(3);
    expect(second.video).not.toBe(first.video);
    expect(fs.existsSync(path.join(root, first.video))).toBe(false);
  }, 60_000);

  it('builds nothing for a day without clips', async () => {
    expect(await builder().ensure(cam(), '2026-11-17')).toBe(false);
    expect(fs.existsSync(path.join(root, 'Summary'))).toBe(false);
  });
});

describe('sweep', () => {
  it('drops old summaries and files nothing points at, but not current ones', () => {
    const dir = path.join(root, 'Summary');
    fs.mkdirSync(dir);
    const meta = (date: string, stamp: string) => {
      fs.writeFileSync(path.join(dir, `FrontDoor_${date}_${stamp}.mp4`), 'v');
      fs.writeFileSync(path.join(dir, `FrontDoor_${date}_${stamp}.jpg`), 'p');
      fs.writeFileSync(path.join(dir, `FrontDoor_${date}.json`), JSON.stringify({
        format: 1, clips: [], duration: 1, video: `Summary/FrontDoor_${date}_${stamp}.mp4`, poster: `Summary/FrontDoor_${date}_${stamp}.jpg`,
      }));
    };
    meta('2026-11-01', 'a');
    meta('2026-11-17', 'b');
    fs.writeFileSync(path.join(dir, 'FrontDoor_2026-11-17_old.mp4'), 'stale build');
    fs.writeFileSync(path.join(dir, 'Driveway_2026-11-01.json'), 'another camera');

    const n = builder().sweep(cam(), 14, new Date(2026, 10, 18, 12));
    expect(n).toBe(4);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'Driveway_2026-11-01.json', 'FrontDoor_2026-11-17.json', 'FrontDoor_2026-11-17_b.jpg', 'FrontDoor_2026-11-17_b.mp4',
    ]);
  });
});

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dayIndex } from './library';
import { isoDay } from './paths';

/**
 * Counts the people who come to the door in each Ring clip. A worker process (people-worker.ts)
 * samples the clip at `FPS`, runs YOLOX-nano on each frame, and returns how many people were in
 * view each time; this module turns those per-frame counts into "people who arrived".
 *
 * Arrivals rather than a peak: one clip can hold a parent at the door, then two kids walking up
 * behind them. The counts are median-smoothed so a person who flickers out of detection for a
 * frame isn't counted again, then every rise counts as that many new people. People far away (the
 * sidewalk, the street) are dropped by box height, so only the walk and porch count.
 *
 * Raw counts are kept per clip in `$DATA_DIR/people/<slug>/YYYY-MM-DD.json`, so the counting
 * rules can change without running the detector again. Only today's and yesterday's clips are
 * processed; the worker runs one at a time under nice.
 */

/**
 * Frames sampled per second of video. 2 fell behind real time on the NAS once continuous clips
 * arrived back to back; a visitor at the door is in view far longer than a second.
 */
export const FPS = 1;
/** Detector input size; the YOLOX-nano release model is 416×416. */
export const SIZE = 416;
/** Bump when the detector or its inputs change so saved counts are redone. */
export const MODEL_VERSION = 1;

const MIN_SCORE = 0.4;
const NMS_IOU = 0.45;
/** Shorter than this share of the frame is someone out on the sidewalk or street. */
const MIN_HEIGHT = 0.15;
/** Median window, in frames, for a clip sampled at `fps`: about 2.5 s, odd, at least 3. */
const smoothWindow = (fps: number) => Math.max(3, Math.round(2.5 * fps) | 1);
/** A clip starting this soon after the last one ended may still show the same people. */
const CARRY_S = 20;

const STRIDES = [8, 16, 32];
const CLASSES = 80;
const ROW = 5 + CLASSES;

type Box = [x1: number, y1: number, x2: number, y2: number, score: number];

function iou(a: Box, b: Box) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/**
 * People in one frame, from YOLOX's raw [1, anchors, 85] output (the release ONNX leaves the grid
 * decoding to the caller). `imageHeight` is the picture's height inside the letterboxed input.
 */
export function countPeople(out: Float32Array, imageHeight: number, size = SIZE): number {
  const boxes: Box[] = [];
  let i = 0;
  for (const stride of STRIDES) {
    const n = size / stride;
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++, i++) {
        const r = i * ROW;
        // Class 0 is "person".
        const score = out[r + 4] * out[r + 5];
        if (score < MIN_SCORE) continue;
        const h = Math.exp(out[r + 3]) * stride;
        if (h < MIN_HEIGHT * imageHeight) continue;
        const cx = (out[r] + gx) * stride;
        const cy = (out[r + 1] + gy) * stride;
        const w = Math.exp(out[r + 2]) * stride;
        boxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, score]);
      }
    }
  }
  boxes.sort((a, b) => b[4] - a[4]);
  const kept: Box[] = [];
  for (const b of boxes) if (kept.every((k) => iou(k, b) < NMS_IOU)) kept.push(b);
  return kept.length;
}

/** Running median, so one missed or doubled frame doesn't look like someone coming or going. */
export function smooth(counts: number[], window = smoothWindow(FPS)): number[] {
  const half = Math.floor(window / 2);
  return counts.map((_, i) => {
    const w = counts.slice(Math.max(0, i - half), i + half + 1).sort((a, b) => a - b);
    return w[Math.floor((w.length - 1) / 2)];
  });
}

export interface ClipPeople {
  /** people who arrived during the clip */
  people: number;
  /** in view at the start and end, for joining back-to-back clips */
  first: number;
  last: number;
}

/** `fps` is the rate the counts were sampled at; older saved counts were taken at 2. */
export function clipPeople(counts: number[], fps = FPS): ClipPeople {
  const s = smooth(counts, smoothWindow(fps));
  let people = s[0] ?? 0;
  for (let i = 1; i < s.length; i++) people += Math.max(0, s[i] - s[i - 1]);
  return { people, first: s[0] ?? 0, last: s.at(-1) ?? 0 };
}

/**
 * The day's total. When a clip starts right as the previous one ended, whoever was still there
 * is the same people, so they aren't counted twice.
 */
export function dayPeople(clips: (ClipPeople & { t: number; duration: number })[]): number {
  let total = 0;
  let prev: (typeof clips)[number] | null = null;
  for (const c of [...clips].sort((a, b) => a.t - b.t)) {
    total += c.people;
    if (prev && c.t - (prev.t + prev.duration) <= CARRY_S) total -= Math.min(prev.last, c.first);
    prev = c;
  }
  return total;
}

/** Yesterday and today, oldest first: the days whose clips get counted. */
function workDays(now = new Date()) {
  return [new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1), now].map(isoDay);
}

interface Saved {
  version: number;
  fps: number;
  /** people in view at each sample */
  counts?: number[];
  error?: string;
}
type DayFile = Record<string, Saved>;

export class PeopleCounter {
  private busy = false;
  private timer?: NodeJS.Timeout;
  /** the clip being counted, for status */
  current: string | null = null;

  constructor(
    private opts: {
      footageRoot: string;
      dir: string;
      model: string;
      slugs: () => string[];
      log: { info: (msg: string) => void; warn: (msg: string) => void };
    },
  ) {}

  get available() {
    return fs.existsSync(this.opts.model);
  }

  start(everyMs = 60_000) {
    if (!this.available) {
      this.opts.log.warn(`People counting is off: no model at ${this.opts.model}`);
      return;
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private file(slug: string, date: string) {
    return path.join(this.opts.dir, slug, `${date}.json`);
  }

  private read(slug: string, date: string): DayFile {
    try {
      return JSON.parse(fs.readFileSync(this.file(slug, date), 'utf8'));
    } catch {
      return {};
    }
  }

  private write(slug: string, date: string, data: DayFile) {
    const file = this.file(slug, date);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.part`, JSON.stringify(data));
    fs.renameSync(`${file}.part`, file);
  }

  /** People per clip (keyed by filename; null while not yet counted) and the day's total. */
  forDay(slug: string, date: string, events: { t: number; duration: number; file: string }[]) {
    const saved = this.read(slug, date);
    const clips: (ClipPeople & { t: number; duration: number })[] = [];
    const byFile: Record<string, number | null> = {};
    let pending = false;
    for (const e of events) {
      const s = saved[path.basename(e.file)];
      if (s?.version !== MODEL_VERSION) pending = true;
      if (s?.counts && s.version === MODEL_VERSION) {
        const c = clipPeople(s.counts, s.fps);
        clips.push({ ...c, t: e.t, duration: e.duration });
        byFile[e.file] = c.people;
      } else {
        byFile[e.file] = null;
      }
    }
    // Older days are never counted, so nothing there is waiting.
    return { byFile, total: clips.length ? dayPeople(clips) : null, pending: pending && workDays().includes(date) };
  }

  /** Counts every clip from today and yesterday that hasn't been counted yet, oldest first. */
  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const slug of this.opts.slugs()) {
        for (const date of workDays()) {
          for (const ev of dayIndex(this.opts.footageRoot, slug, date).events) {
            const name = path.basename(ev.file);
            if (this.read(slug, date)[name]?.version === MODEL_VERSION) continue;
            const clip = path.join(this.opts.footageRoot, ...ev.file.split('/'));
            this.current = `${slug}/${date}/${name}`;
            let result: Saved;
            try {
              result = { version: MODEL_VERSION, fps: FPS, counts: await this.detect(clip) };
            } catch (err) {
              // Saved so a clip that can't be read isn't retried every minute.
              result = { version: MODEL_VERSION, fps: FPS, error: (err as Error).message };
              this.opts.log.warn(`${slug}: couldn't count people in ${name}: ${result.error}`);
            }
            this.write(slug, date, { ...this.read(slug, date), [name]: result });
          }
        }
      }
    } catch (err) {
      this.opts.log.warn(`People counting failed: ${(err as Error).message}`);
    } finally {
      this.current = null;
      this.busy = false;
    }
  }

  /** Drops saved counts for days past retention. */
  sweep(expired: (days: string[]) => string[]) {
    for (const slug of fs.existsSync(this.opts.dir) ? fs.readdirSync(this.opts.dir) : []) {
      const dir = path.join(this.opts.dir, slug);
      const days = fs.readdirSync(dir).map((n) => n.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter((d) => d !== undefined);
      for (const day of expired(days)) fs.rmSync(path.join(dir, `${day}.json`), { force: true });
    }
  }

  /** Runs the worker in its own process: inference is CPU-bound and would stall the server. */
  private detect(clip: string): Promise<number[]> {
    const worker = path.join(__dirname, `people-worker${path.extname(__filename)}`);
    const node = [process.execPath, ...process.execArgv, worker, this.opts.model, clip, String(FPS)];
    // nice: the NAS is a 4-core Atom that is also recording.
    const [cmd, ...args] = process.platform === 'win32' ? node : ['nice', '-n', '15', ...node];
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`worker exited ${code}: ${err.trim().split('\n').pop()}`));
        try {
          resolve(JSON.parse(out).counts);
        } catch {
          reject(new Error('worker returned no counts'));
        }
      });
    });
  }
}

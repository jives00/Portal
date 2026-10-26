import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventKind, clock, dayPath, eventName } from './paths';

/**
 * Records one camera's event clips. Ring stops sending motion while a live stream is open, so the
 * stream is opened only on an event and the first few seconds of each event are lost while it
 * starts; that's the trade for leaving the Ring app's own alerts working.
 *
 * Clips run a fixed `clipLength` from the event. Motion "off" can't be used to end them: ring-mqtt
 * holds motion on for ~3 minutes regardless, and Ring sends nothing new while the stream is open.
 * A ding during a clip extends it. Once the stream closes, Ring detects again and a new event
 * starts a new clip.
 *
 * ffmpeg writes MPEG-TS (`.ts.part`), which survives being killed. When the clip ends it's remuxed
 * to a faststart MP4, dropping the stream's first GOP: ring-mqtt's opening keyframe arrives
 * truncated and smears everything up to the next one (~2 s).
 */

/** Ring ends live streams around 10 minutes; never run longer than this. */
export const MAX_CLIP_MS = 5 * 60_000;
/** Start the saved clip at the first keyframe at least this far in. */
const SKIP_START_S = 1;
/** Shorter than this is a stream that never really started. */
const MIN_BYTES = 32 * 1024;

export type Spawn = (cmd: string, args: string[]) => ChildProcess;
/** Turns the raw recording into the final MP4; resolves to the seconds trimmed off the start. */
export type Finalize = (src: string, dst: string) => Promise<number>;

interface Clip {
  proc: ChildProcess;
  start: Date;
  kind: EventKind;
  dir: string;
  tmp: string;
  stopAt: number;
  done: Promise<void>;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').pop()}`)),
    );
  });
}

/** Keyframe times (seconds from the first packet) in `ffprobe -show_entries packet=pts_time,flags -of csv=p=0` output. */
export function keyframeOffsets(csv: string): number[] {
  const packets = csv
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .map(([t, flags]) => ({ t: Number(t), key: (flags ?? '').startsWith('K') }))
    .filter((p) => Number.isFinite(p.t));
  if (!packets.length) return [];
  const base = packets[0].t;
  return packets.filter((p) => p.key).map((p) => p.t - base);
}

export const remuxClip: Finalize = async (src, dst) => {
  const probe = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags',
    '-read_intervals', '%+8', '-of', 'csv=p=0', src,
  ]);
  const skip = keyframeOffsets(probe).find((t) => t >= SKIP_START_S) ?? 0;
  // Output-side -ss on an exact keyframe time cuts both streams there without re-encoding.
  const cut = skip > 0 ? ['-ss', skip.toFixed(3)] : [];
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', src, ...cut, '-map', '0', '-c', 'copy',
    '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', dst,
  ]);
  return skip;
};

export class ClipRecorder {
  private clip: Clip | null = null;
  private stopTimer?: NodeJS.Timeout;
  lastEvent: { at: number; kind: EventKind } | null = null;
  lastError: string | null = null;

  constructor(
    private opts: {
      root: string;
      slug: () => string;
      rtspUrl: string;
      /** seconds a clip runs after its latest event */
      clipLength: () => number;
      log: { info: (msg: string) => void; warn: (msg: string) => void };
      spawn?: Spawn;
      finalize?: Finalize;
      now?: () => Date;
    },
  ) {}

  get recording() {
    return this.clip !== null;
  }

  /** Only "on" matters; see the note at the top about ring-mqtt's motion timer. */
  motion(on: boolean) {
    if (on) this.trigger('motion');
  }

  ding(on: boolean) {
    if (on) this.trigger('ding');
  }

  async shutdown() {
    await this.finish();
  }

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  private trigger(kind: EventKind) {
    const now = this.now();
    this.lastEvent = { at: now.getTime(), kind };
    if (!this.clip) this.begin(kind, now);
    else if (kind === 'ding') this.clip.kind = 'ding';

    const clip = this.clip!;
    const until = Math.min(clip.start.getTime() + MAX_CLIP_MS, now.getTime() + this.opts.clipLength() * 1000);
    if (until > clip.stopAt) {
      clip.stopAt = until;
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => void this.finish(), until - now.getTime());
    }
  }

  private begin(kind: EventKind, start: Date) {
    const dir = path.join(this.opts.root, dayPath(this.opts.slug(), start), 'events');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${clock(start)}.ts.part`);
    const args = [
      '-hide_banner', '-v', 'error', '-y',
      '-rtsp_transport', 'tcp', '-i', this.opts.rtspUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      // ring-mqtt's "Compatible" video mode is H.264, which browsers play as-is.
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
      '-f', 'mpegts', tmp,
    ];
    const proc = (this.opts.spawn ?? spawn)('ffmpeg', args);
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-1000)));
    const done = new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        if (code && this.clip?.proc === proc) {
          // ffmpeg quit on its own: the stream failed or Ring ended it.
          this.lastError = `ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`;
          this.opts.log.warn(`${this.opts.slug()}: ${this.lastError}`);
          void this.finish();
        }
        resolve();
      });
      proc.on('error', (err) => {
        this.lastError = `Couldn't start ffmpeg: ${err.message}`;
        this.opts.log.warn(this.lastError);
        resolve();
      });
    });

    this.clip = { proc, start, kind, dir, tmp, stopAt: 0, done };
    this.opts.log.info(`${this.opts.slug()}: recording ${kind}`);
  }

  private async finish() {
    const clip = this.clip;
    if (!clip) return;
    this.clip = null;
    clearTimeout(this.stopTimer);

    if (clip.proc.exitCode === null) {
      // 'q' lets ffmpeg flush and close the file; kill it if it doesn't go.
      clip.proc.stdin?.write('q');
      clip.proc.stdin?.end();
      const kill = setTimeout(() => clip.proc.kill('SIGKILL'), 5000);
      await clip.done;
      clearTimeout(kill);
    }

    const seconds = (this.now().getTime() - clip.start.getTime()) / 1000;
    let size = 0;
    try {
      size = fs.statSync(clip.tmp).size;
    } catch {
      /* never written */
    }
    if (size < MIN_BYTES) {
      fs.rmSync(clip.tmp, { force: true });
      this.opts.log.warn(`${this.opts.slug()}: dropped an empty ${clip.kind} clip`);
      return;
    }

    const out = path.join(clip.dir, `${clock(clip.start)}.mp4.part`);
    try {
      const skipped = await (this.opts.finalize ?? remuxClip)(clip.tmp, out);
      const start = new Date(clip.start.getTime() + skipped * 1000);
      const final = path.join(clip.dir, eventName(start, clip.kind, seconds - skipped));
      fs.renameSync(out, final);
      fs.rmSync(clip.tmp, { force: true });
      this.lastError = null;
      this.opts.log.info(`${this.opts.slug()}: saved ${path.basename(final)}`);
    } catch (err) {
      // Keep the raw recording (as .ts, which the viewer ignores) so nothing is lost.
      fs.rmSync(out, { force: true });
      const kept = clip.tmp.replace(/\.part$/, '');
      fs.renameSync(clip.tmp, kept);
      this.lastError = `Couldn't finish ${path.basename(kept)}: ${(err as Error).message}`;
      this.opts.log.warn(`${this.opts.slug()}: ${this.lastError}`);
    }
  }
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The NAS camera script writes `Daily_Summary_<yesterday>.mp4` into
 * `SecurityCameras/yyyy/mm/dd/`. Portal keeps exactly one browser-friendly copy of the newest
 * summary and deletes its previous copy when a new one arrives. It only ever reads the camera
 * share (mounted read-only), so the originals stay under the camera system's own retention.
 */

const SUMMARY_RE = /^daily_summary_.*\.mp4$/i;
const SETTLE_MS = 2 * 60_000; // skip files modified in the last 2 min; the script may still be writing
const DAY = 24 * 3600_000;

export interface SummaryFile {
  path: string;
  /** the day the footage covers, YYYY-MM-DD */
  date: string;
  mtime: number;
}

export interface CameraState {
  source: string;
  date: string;
  video: string;
  poster: string;
  duration: number;
  /** FORMAT the copy was made with; an older copy is re-converted */
  format?: number;
}

/** Bump when the conversion changes so the current copy is redone. 2: keeps audio. */
const FORMAT = 2;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function validDay(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Reads the footage date from the filename. Handles YYYYMMDD, YYYY-MM-DD and MM-DD-YYYY styles.
 * Falls back to the day before the folder's date, since the script runs the morning after.
 */
export function summaryDate(file: string, folderDay: Date): string {
  const ymd = file.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/);
  if (ymd) {
    const day = validDay(+ymd[1], +ymd[2], +ymd[3]);
    if (day) return day;
  }
  const mdy = file.match(/(\d{2})[-_.]?(\d{2})[-_.]?(\d{4})/);
  if (mdy) {
    const day = validDay(+mdy[3], +mdy[1], +mdy[2]);
    if (day) return day;
  }
  return isoDay(new Date(folderDay.getTime() - DAY));
}

/** Looks through the last few day folders for the newest finished daily summary. */
export function findLatest(root: string, now = Date.now()): SummaryFile | null {
  const found: SummaryFile[] = [];
  for (let back = 0; back <= 3; back++) {
    const day = new Date(now - back * DAY);
    const dir = path.join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => SUMMARY_RE.test(n))) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < SETTLE_MS) continue;
      found.push({ path: full, date: summaryDate(name, day), mtime: stat.mtimeMs });
    }
  }
  found.sort((a, b) => a.date.localeCompare(b.date) || a.mtime - b.mtime);
  return found.at(-1) ?? null;
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

export class CameraService {
  private state: CameraState | null = null;
  private busy = false;
  private lastError: string | null = null;
  private timer?: NodeJS.Timeout;
  private stateFile: string;

  constructor(
    private root: string,
    readonly outDir: string,
    private log: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    fs.mkdirSync(outDir, { recursive: true });
    this.stateFile = path.join(outDir, 'state.json');
    try {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      this.state = null;
    }
  }

  start(everyMs = 10 * 60_000) {
    void this.check();
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref();
  }

  status() {
    return { state: this.state, processing: this.busy, error: this.lastError };
  }

  async check() {
    if (this.busy) return;
    let latest: SummaryFile | null;
    try {
      latest = findLatest(this.root);
    } catch (err) {
      this.lastError = `Can't read the camera folder: ${(err as Error).message}`;
      return;
    }
    if (!latest || (latest.path === this.state?.source && this.state?.format === FORMAT)) return;

    this.busy = true;
    this.log.info(`Converting daily summary ${latest.path}`);
    try {
      this.state = await this.convert(latest);
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
      this.cleanup();
      this.lastError = null;
      this.log.info(`Daily summary for ${latest.date} ready`);
    } catch (err) {
      this.lastError = `Couldn't convert ${path.basename(latest.path)}: ${(err as Error).message}`;
      this.log.warn(this.lastError);
    } finally {
      this.busy = false;
    }
  }

  private async convert(src: SummaryFile): Promise<CameraState> {
    const probe = JSON.parse(
      await run('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width:format=duration', '-of', 'json', src.path,
      ]),
    );
    const codec = probe.streams?.[0]?.codec_name;
    const width = probe.streams?.[0]?.width ?? 0;
    const duration = Math.round(Number(probe.format?.duration) || 0);

    const stamp = `${src.date}-${Date.now().toString(36)}`;
    const video = `summary-${stamp}.mp4`;
    const poster = `poster-${stamp}.jpg`;
    const tmp = path.join(this.outDir, `${video}.part`);

    // Browsers can't reliably play the camera's 4K HEVC, so re-encode unless it's already small H.264.
    const encode =
      codec === 'h264' && width <= 1920
        ? ['-c', 'copy']
        : ['-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'];
    // nice keeps the conversion from starving the NAS's other containers; it's a 4-core Atom.
    const ffmpeg = ['ffmpeg', '-v', 'error', '-y', '-i', src.path, ...encode, '-movflags', '+faststart', '-f', 'mp4', tmp];
    await (process.platform === 'win32' ? run(ffmpeg[0], ffmpeg.slice(1)) : run('nice', ['-n', '15', ...ffmpeg]));
    fs.renameSync(tmp, path.join(this.outDir, video));

    const at = Math.min(5, Math.max(0, duration / 2));
    await run('ffmpeg', [
      '-v', 'error', '-y', '-ss', String(at), '-i', path.join(this.outDir, video),
      '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', path.join(this.outDir, poster),
    ]);

    return { source: src.path, date: src.date, video, poster, duration, format: FORMAT };
  }

  /** Keep only the current copy: one video, one poster, and the state file. */
  private cleanup() {
    const keep = new Set([this.state?.video, this.state?.poster, 'state.json']);
    for (const name of fs.readdirSync(this.outDir)) {
      if (!keep.has(name)) fs.rmSync(path.join(this.outDir, name), { force: true });
    }
  }
}

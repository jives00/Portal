import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * On-demand live view. Browsers can't play RTSP, so while someone is watching, ffmpeg repackages
 * ring-mqtt's stream as a rolling HLS playlist (stream copy, no re-encode) under
 * `<dir>/<slug>/index.m3u8`. The page pings every few seconds; a session nobody has pinged for
 * IDLE_MS is stopped, and none runs past MAX_MS (Ring ends streams around 10 minutes).
 *
 * Ring sends no motion events while the stream is open, so recording pauses during live view.
 */

const IDLE_MS = 30_000;
export const MAX_MS = 9 * 60_000;

interface Session {
  proc: ChildProcess;
  started: number;
  lastPing: number;
  timer: NodeJS.Timeout;
}

export class LiveView {
  private sessions = new Map<string, Session>();

  constructor(
    readonly dir: string,
    private log: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  isLive(slug: string) {
    return this.sessions.has(slug);
  }

  /** Starts a session (or keeps one alive). Returns the playlist path under `dir`. */
  ping(slug: string, rtspUrl: string): { playlist: string; ready: boolean; endsAt: number } {
    const out = path.join(this.dir, slug);
    let s = this.sessions.get(slug);
    if (!s) {
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      const proc = spawn('ffmpeg', [
        '-hide_banner', '-v', 'error',
        '-rtsp_transport', 'tcp', '-i', rtspUrl,
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+omit_endlist', path.join(out, 'index.m3u8'),
      ]);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-1000)));
      proc.on('error', (err) => this.log.warn(`${slug}: live view couldn't start ffmpeg: ${err.message}`));
      proc.on('close', (code) => {
        if (this.sessions.get(slug)?.proc === proc) {
          if (code) this.log.warn(`${slug}: live view ended: ${stderr.trim().split('\n').pop() ?? code}`);
          this.end(slug);
        }
      });
      const now = Date.now();
      s = { proc, started: now, lastPing: now, timer: setInterval(() => this.check(slug), 5000) };
      this.sessions.set(slug, s);
      this.log.info(`${slug}: live view started`);
    }
    s.lastPing = Date.now();
    return {
      playlist: `${slug}/index.m3u8`,
      ready: fs.existsSync(path.join(out, 'index.m3u8')),
      endsAt: s.started + MAX_MS,
    };
  }

  stop(slug: string) {
    this.end(slug);
  }

  stopAll() {
    for (const slug of [...this.sessions.keys()]) this.end(slug);
  }

  private check(slug: string) {
    const s = this.sessions.get(slug);
    if (!s) return;
    const now = Date.now();
    if (now - s.lastPing > IDLE_MS || now - s.started > MAX_MS) this.end(slug);
  }

  private end(slug: string) {
    const s = this.sessions.get(slug);
    if (!s) return;
    this.sessions.delete(slug);
    clearInterval(s.timer);
    if (s.proc.exitCode === null) {
      s.proc.stdin?.write('q');
      setTimeout(() => s.proc.exitCode === null && s.proc.kill('SIGKILL'), 3000).unref();
    }
    setTimeout(() => fs.rmSync(path.join(this.dir, slug), { recursive: true, force: true }), 5000).unref();
    this.log.info(`${slug}: live view stopped`);
  }
}

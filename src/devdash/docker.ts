import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';

/**
 * A minimal Docker Engine API client over the mounted socket (read-only calls only: list,
 * inspect, logs). No dockerode: these four GETs are all the DevDash tab needs.
 */

export interface ContainerSummary {
  Id: string;
  Names: string[];
  State: string;
}

export interface ContainerInspect {
  Id: string;
  RestartCount: number;
  Config: { Tty: boolean };
  State: {
    Status: string;
    Running: boolean;
    Restarting: boolean;
    StartedAt: string;
    FinishedAt: string;
    ExitCode: number;
  };
}

export interface LogLine {
  text: string;
  /** Written to stderr. */
  err: boolean;
}

/**
 * Turns Docker's log stream into lines. Without a TTY, Docker multiplexes stdout and stderr into
 * frames: [stream, 0, 0, 0, size (uint32 BE)] then `size` bytes. A frame can split across chunks,
 * and a line (or a UTF-8 character) across frames, so both are buffered.
 */
export class LogDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private partial = ['', ''];
  private decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];

  constructor(private tty: boolean) {}

  push(chunk: Buffer): LogLine[] {
    const out: LogLine[] = [];
    if (this.tty) {
      this.text(0, this.decoders[0].write(chunk), out);
      return out;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(4);
      if (this.pending.length < 8 + size) break;
      const stream = this.pending[0] === 2 ? 1 : 0;
      this.text(stream, this.decoders[stream].write(this.pending.subarray(8, 8 + size)), out);
      this.pending = this.pending.subarray(8 + size);
    }
    return out;
  }

  /** Lines still waiting for a newline when the stream ends. */
  end(): LogLine[] {
    const out: LogLine[] = [];
    for (const s of [0, 1]) {
      const rest = (this.partial[s] + this.decoders[s].end()).replace(/\r$/, '');
      if (rest.trim()) out.push({ text: rest, err: s === 1 });
      this.partial[s] = '';
    }
    return out;
  }

  private text(stream: number, s: string, out: LogLine[]) {
    const parts = (this.partial[stream] + s).split('\n');
    this.partial[stream] = parts.pop() ?? '';
    for (const p of parts) {
      const line = p.replace(/\r$/, '');
      if (line.trim()) out.push({ text: line, err: stream === 1 });
    }
  }
}

export class Docker {
  constructor(private socketPath = '/var/run/docker.sock', private timeoutMs = 10_000) {}

  /** `timeoutMs` 0 means none (a followed log stream can sit idle for hours). */
  private request(path: string, timeoutMs = this.timeoutMs): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path, headers: { Host: 'docker' } }, (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          reject(new Error(`Docker ${path.split('?')[0]} returned ${res.statusCode}`));
          return;
        }
        resolve(res);
      });
      req.on('error', (err) => reject(new Error(`Docker socket: ${err.message}`)));
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
      req.end();
    });
  }

  private async read(path: string): Promise<Buffer> {
    const res = await this.request(path);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async json<T>(path: string): Promise<T> {
    return JSON.parse((await this.read(path)).toString('utf8')) as T;
  }

  list(): Promise<ContainerSummary[]> {
    return this.json('/containers/json?all=1');
  }

  inspect(id: string): Promise<ContainerInspect> {
    return this.json(`/containers/${encodeURIComponent(id)}/json`);
  }

  private logsPath(id: string, q: Record<string, string | number | undefined>) {
    const params = new URLSearchParams({ stdout: '1', stderr: '1' });
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    return `/containers/${encodeURIComponent(id)}/logs?${params}`;
  }

  /** The last `tail` lines, optionally only those since a Unix time. */
  async logs(id: string, tty: boolean, opts: { tail?: number; since?: number } = {}): Promise<LogLine[]> {
    const d = new LogDecoder(tty);
    return [...d.push(await this.read(this.logsPath(id, opts))), ...d.end()];
  }

  /** Streams lines since a Unix time, then new ones as they're written. Destroy the result to stop. */
  async follow(id: string, tty: boolean, since: number, onLine: (l: LogLine) => void): Promise<http.IncomingMessage> {
    const res = await this.request(this.logsPath(id, { follow: 1, since }), 0);
    const d = new LogDecoder(tty);
    res.on('data', (c: Buffer) => d.push(c).forEach(onLine));
    res.on('end', () => d.end().forEach(onLine));
    return res;
  }
}

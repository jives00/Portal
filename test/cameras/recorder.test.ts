import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipRecorder, Finalize, MAX_CLIP_MS, keyframeOffsets } from '../../src/cameras/recorder';

/** A stand-in for ffmpeg: writes some bytes to its output path and exits 0 on 'q'. */
function fakeFfmpeg(bytes = 64 * 1024) {
  const spawned: string[][] = [];
  const spawn = (_cmd: string, args: string[]) => {
    spawned.push(args);
    const proc = new EventEmitter() as any;
    proc.exitCode = null;
    proc.stdin = new PassThrough();
    proc.stderr = new PassThrough();
    fs.writeFileSync(args.at(-1)!, Buffer.alloc(bytes));
    proc.stdin.on('data', (d: Buffer) => {
      if (d.toString() === 'q') {
        proc.exitCode = 0;
        proc.emit('close', 0);
      }
    });
    proc.kill = () => {
      proc.exitCode = 137;
      proc.emit('close', null);
    };
    return proc;
  };
  return { spawn, spawned };
}

/** Stands in for the remux: copies the file and reports 2 s trimmed off the start. */
const fakeFinalize: Finalize = async (src, dst) => {
  fs.copyFileSync(src, dst);
  return 2;
};

const log = { info: () => {}, warn: () => {} };

describe('keyframeOffsets', () => {
  it('measures keyframes from the first packet', () => {
    const csv = '1.400000,K__\n1.467000,K__\n1.535000,___\n3.466000,K__\n';
    expect(keyframeOffsets(csv).map((t) => +t.toFixed(3))).toEqual([0, 0.067, 2.066]);
    expect(keyframeOffsets('')).toEqual([]);
  });
});

describe('ClipRecorder', () => {
  let root: string;
  let clock: number;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-rec-'));
    clock = new Date(2026, 9, 24, 14, 3, 12).getTime();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const events = () => fs.readdirSync(path.join(root, 'front-door/2026/10/24/events'));
  const make = (ff = fakeFfmpeg(), finalize = fakeFinalize) =>
    new ClipRecorder({
      root,
      slug: () => 'front-door',
      rtspUrl: 'rtsp://ring/abc_live',
      clipLength: () => 60,
      log,
      spawn: ff.spawn as any,
      finalize,
      now: () => new Date(clock),
    });
  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('records a fixed length from motion, ignoring motion off', async () => {
    const ff = fakeFfmpeg();
    const rec = make(ff);
    rec.motion(true);
    expect(rec.recording).toBe(true);
    expect(ff.spawned[0]).toContain('rtsp://ring/abc_live');
    rec.motion(false);
    await advance(59_000);
    expect(rec.recording).toBe(true);
    await advance(1_000);
    expect(rec.recording).toBe(false);
    // Named from the trimmed start (+2 s), length minus the trim.
    expect(events()).toEqual(['14-03-14_motion_58s.mp4']);
  });

  it('extends on a ding and relabels the clip', async () => {
    const ff = fakeFfmpeg();
    const rec = make(ff);
    rec.motion(true);
    await advance(30_000);
    rec.ding(true);
    await advance(59_000);
    expect(rec.recording).toBe(true);
    await advance(1_000);
    expect(ff.spawned).toHaveLength(1);
    expect(events()).toEqual(['14-03-14_ding_88s.mp4']);
  });

  it('never runs past the cap', async () => {
    const rec = make();
    rec.motion(true);
    for (let i = 0; i < 5; i++) {
      await advance(50_000);
      rec.ding(true);
    }
    await advance(50_000); // to the 5-minute mark
    expect(rec.recording).toBe(false);
    expect(events()).toEqual([`14-03-14_ding_${MAX_CLIP_MS / 1000 - 2}s.mp4`]);
  });

  it('records back to back in the continuous window', async () => {
    const ff = fakeFfmpeg();
    const rec = make(ff);
    const tick = async (ms: number) => {
      for (let t = 0; t < ms; t += 2000) {
        rec.hold();
        await advance(2000);
      }
    };
    await tick(MAX_CLIP_MS + 4000);
    // The first clip is saved and the next is already recording.
    expect(ff.spawned).toHaveLength(2);
    expect(rec.recording).toBe(true);
    expect(events().filter((n) => n.endsWith('.mp4'))).toEqual([`14-03-14_continuous_${MAX_CLIP_MS / 1000 - 2}s.mp4`]);
    expect(rec.lastEvent).toBeNull();
  });

  it('backs off when the stream fails in the continuous window', async () => {
    const spawned: string[][] = [];
    const failing = (_cmd: string, args: string[]) => {
      spawned.push(args);
      const proc = new EventEmitter() as any;
      proc.exitCode = null;
      proc.stdin = new PassThrough();
      proc.stderr = new PassThrough();
      setTimeout(() => {
        proc.exitCode = 1;
        proc.emit('close', 1);
      }, 500);
      return proc;
    };
    const rec = make({ spawn: failing, spawned } as any);
    const tick = async (ms: number) => {
      for (let t = 0; t < ms; t += 1000) {
        rec.hold();
        await advance(1000);
      }
    };
    // Fails at 0.5 s; retries 3 s later, then 10 s, then every 30 s.
    await tick(1000);
    expect(spawned).toHaveLength(1);
    await tick(4000);
    expect(spawned).toHaveLength(2);
    await tick(9000);
    expect(spawned).toHaveLength(2);
    await tick(2000);
    expect(spawned).toHaveLength(3);
    await tick(29_000);
    expect(spawned).toHaveLength(3);
    await tick(2000);
    expect(spawned).toHaveLength(4);
    expect(rec.lastError).toMatch(/exited 1/);
  });

  it('drops a clip that never got data', async () => {
    const rec = make(fakeFfmpeg(100));
    rec.motion(true);
    await advance(60_000);
    expect(events()).toEqual([]);
  });

  it('keeps the raw recording if the remux fails', async () => {
    const rec = make(fakeFfmpeg(), async () => {
      throw new Error('boom');
    });
    rec.motion(true);
    await advance(60_000);
    expect(events()).toEqual(['14-03-12.ts']);
    expect(rec.lastError).toMatch(/boom/);
  });
});

import { spawn } from 'node:child_process';
import * as ort from 'onnxruntime-web';
import { SIZE, countPeople } from './people';
import { run } from './summary';

/**
 * `node people-worker.js <model.onnx> <clip.mp4> <fps>` prints `{"counts":[…]}`: the people in
 * view at each sampled frame. Run by PeopleCounter in its own process so inference never blocks
 * the server. onnxruntime-web (WASM) because onnxruntime-node has no musl build for Alpine.
 */

async function main() {
  const [model, clip, fps] = process.argv.slice(2);
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });

  const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', clip]))
    .trim()
    .split(',')
    .map(Number);
  // Letterboxed into the top-left corner with YOLOX's grey, as it was trained.
  const imageHeight = Math.round((SIZE * h) / Math.max(w, h));

  const ff = spawn('ffmpeg', [
    '-v', 'error', '-i', clip, '-an',
    '-vf', `fps=${fps},scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,pad=${SIZE}:${SIZE}:0:0:0x727272`,
    '-pix_fmt', 'bgr24', '-f', 'rawvideo', '-',
  ]);
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-1000)));
  const exited = new Promise<number | null>((resolve) => ff.on('close', resolve));

  const plane = SIZE * SIZE;
  const frameBytes = plane * 3;
  const input = new Float32Array(3 * plane);
  const counts: number[] = [];
  let pending = Buffer.alloc(0);
  // Reading one chunk at a time holds ffmpeg back while a frame is being checked.
  for await (const chunk of ff.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= frameBytes) {
      // HWC bytes → CHW floats; YOLOX takes raw 0–255 BGR with no normalizing.
      for (let i = 0; i < plane; i++) {
        input[i] = pending[i * 3];
        input[plane + i] = pending[i * 3 + 1];
        input[2 * plane + i] = pending[i * 3 + 2];
      }
      pending = pending.subarray(frameBytes);
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
      counts.push(countPeople(out[session.outputNames[0]].data as Float32Array, imageHeight));
    }
  }
  // ffmpeg logs and carries on past the odd broken frame (ring-mqtt's first GOP); only a hard
  // failure with nothing decoded counts as an error.
  const code = await exited;
  if (code !== 0 && !counts.length) throw new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').pop()}`);
  process.stdout.write(JSON.stringify({ counts }));
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

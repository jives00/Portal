import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clock, dayPath } from './paths';

/**
 * Writes Ring's snapshots as `<camera>/YYYY/MM/DD/snapshots/HH-MM-SS.jpg`, untouched. ring-mqtt
 * republishes the last image on reconnect, so repeats of the previous image are skipped.
 */
export class SnapshotWriter {
  private lastHash = new Map<string, string>();
  lastAt = new Map<string, number>();

  constructor(private root: string) {}

  save(slug: string, jpeg: Buffer, when = new Date()): string | null {
    const hash = crypto.createHash('sha1').update(jpeg).digest('hex');
    if (this.lastHash.get(slug) === hash) return null;
    this.lastHash.set(slug, hash);

    const dir = path.join(this.root, dayPath(slug, when), 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, `${clock(when)}.jpg`);
    for (let n = 1; fs.existsSync(file); n++) file = path.join(dir, `${clock(when)}-${n}.jpg`);
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, jpeg);
    fs.renameSync(tmp, file);
    this.lastAt.set(slug, when.getTime());
    return file;
  }
}

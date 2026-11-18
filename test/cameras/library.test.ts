import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expired, listDays } from '../../src/cameras/library';
import { slugify } from '../../src/cameras/paths';

describe('slugify', () => {
  it('slugifies camera names', () => {
    expect(slugify('Front Door')).toBe('front-door');
    expect(slugify('FrontDoor')).toBe('frontdoor');
    expect(slugify("  Mom's   Porch!! ")).toBe('mom-s-porch');
    expect(slugify('***')).toBe('camera');
  });
});

describe('day folders', () => {
  let root: string;
  beforeEach(() => (root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-days-'))));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists YYYY/MM/DD folders newest first, ignoring anything else', () => {
    for (const d of ['Driveway/2026/10/23', 'Driveway/2026/10/24', 'Driveway/Summary', 'Driveway/2026/xx/01']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'Driveway/2026/10/25'), 'a file, not a day');
    expect(listDays(root, 'Driveway')).toEqual(['2026-10-24', '2026-10-23']);
    expect(listDays(root, 'Nope')).toEqual([]);
  });

  it('keeps today and the N-1 days before it', () => {
    const now = new Date(2026, 9, 25, 12);
    expect(expired(['2026-10-25', '2026-10-24', '2026-10-23', '2026-10-01'], 2, now)).toEqual(['2026-10-23', '2026-10-01']);
  });
});

describe('liveError', () => {
  it('turns ffmpeg errors into something to act on', async () => {
    const { liveError } = await import('../../src/cameras/live');
    expect(liveError('Error opening input files: Server returned 401 Unauthorized (authorization failed)')).toMatch(/rejected the login/);
    expect(liveError('Connection to tcp://192.168.0.57:554 failed: Connection refused')).toMatch(/Can't reach/);
    expect(liveError('Server returned 404 Not Found')).toMatch(/no stream at that path/);
  });
});

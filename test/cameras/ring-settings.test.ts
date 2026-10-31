import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCameraTopic, parseDiscovery } from '../../src/cameras/ring';
import { SettingsStore, inWindow } from '../../src/cameras/settings';

describe('ring topics', () => {
  it('parses entity and device-level topics', () => {
    expect(parseCameraTopic('ring/loc1/camera/abc123/motion/state')).toEqual({ location: 'loc1', device: 'abc123', entity: 'motion', leaf: 'state' });
    expect(parseCameraTopic('ring/loc1/camera/abc123/status')).toEqual({ location: 'loc1', device: 'abc123', entity: 'status', leaf: '' });
    expect(parseCameraTopic('ring/loc1/alarm/abc123/status')).toBeNull();
    expect(parseCameraTopic('other/loc1/camera/abc123/motion/state')).toBeNull();
  });

  it('reads a camera name from a discovery config', () => {
    const payload = JSON.stringify({ state_topic: 'ring/loc1/camera/abc123/motion/state', device: { name: 'Front Door' } });
    expect(parseDiscovery('homeassistant/binary_sensor/loc1/abc123_motion/config', payload)).toEqual({ device: 'abc123', location: 'loc1', name: 'Front Door' });
    expect(parseDiscovery('homeassistant/x/y/z/config', '{"device":{"name":"Panel"},"state_topic":"ring/loc1/alarm/p1/state"}')).toBeNull();
    expect(parseDiscovery('homeassistant/x/y/z/config', 'not json')).toBeNull();
  });
});

describe('inWindow', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 31, h, m);
  it('covers start up to but not including end', () => {
    const w = { start: '15:00', end: '23:00' };
    expect(inWindow(w, at(14, 59))).toBe(false);
    expect(inWindow(w, at(15))).toBe(true);
    expect(inWindow(w, at(22, 59))).toBe(true);
    expect(inWindow(w, at(23))).toBe(false);
  });

  it('crosses midnight, and equal times mean all day', () => {
    const w = { start: '22:00', end: '06:00' };
    expect(inWindow(w, at(23))).toBe(true);
    expect(inWindow(w, at(5, 59))).toBe(true);
    expect(inWindow(w, at(12))).toBe(false);
    expect(inWindow({ start: '00:00', end: '00:00' }, at(12))).toBe(true);
  });
});

describe('SettingsStore', () => {
  it('gives an older settings file the default continuous window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-old-'));
    const file = path.join(dir, 'cameras.json');
    fs.writeFileSync(file, JSON.stringify({ snapshotDays: 30, eventDays: 90, snapshotInterval: 30, clipLength: 300, cameras: {} }));
    expect(new SettingsStore(file).get()).toMatchObject({ clipLength: 300, continuous: { enabled: true, start: '15:00', end: '23:00' } });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-set-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('starts with the agreed retention and keeps slugs fixed', () => {
    const store = new SettingsStore(path.join(dir, 'settings.json'));
    expect(store.get()).toMatchObject({ snapshotDays: 30, eventDays: 90 });

    store.addCamera('abc', { name: 'Front Door', slug: 'front-door', location: 'loc1' });
    const second = store.addCamera('def', { name: 'Front Door', slug: 'front-door', location: 'loc1' });
    expect(second.slug).toBe('front-door-2');

    const next = structuredClone(store.get());
    next.cameras.abc.name = 'Porch';
    next.cameras.abc.slug = 'hacked';
    (next.cameras as any).ghost = { name: 'x', slug: 'x', location: 'l', enabled: true };
    store.set(next);
    expect(store.get().cameras.abc).toMatchObject({ name: 'Porch', slug: 'front-door' });
    expect(store.get().cameras).not.toHaveProperty('ghost');

    expect(new SettingsStore(path.join(dir, 'settings.json')).get().cameras.abc.name).toBe('Porch');
  });
});

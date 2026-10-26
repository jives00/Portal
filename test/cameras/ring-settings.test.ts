import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCameraTopic, parseDiscovery } from '../../src/cameras/ring';
import { SettingsStore } from '../../src/cameras/settings';

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

describe('SettingsStore', () => {
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

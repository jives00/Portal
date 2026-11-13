import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countErrors, formatUptime } from '../src/devdash';
import { Docker, LogDecoder } from '../src/devdash/docker';
import { DEFAULTS, RegistryStore } from '../src/devdash/registry';

/** One multiplexed Docker log frame. */
const frame = (stream: 1 | 2, text: string | Buffer) => {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe('LogDecoder', () => {
  it('splits multiplexed frames into stdout and stderr lines', () => {
    const d = new LogDecoder(false);
    const out = d.push(Buffer.concat([frame(1, 'one\ntwo\n'), frame(2, 'boom\n')]));
    expect(out).toEqual([
      { text: 'one', err: false },
      { text: 'two', err: false },
      { text: 'boom', err: true },
    ]);
  });

  it('waits for frames and lines that split across chunks', () => {
    const d = new LogDecoder(false);
    const all = Buffer.concat([frame(1, 'hel'), frame(1, 'lo\r\nwor'), frame(1, 'ld')]);
    const got = [...d.push(all.subarray(0, 5)), ...d.push(all.subarray(5, 14)), ...d.push(all.subarray(14))];
    expect(got).toEqual([{ text: 'hello', err: false }]);
    expect(d.end()).toEqual([{ text: 'world', err: false }]);
  });

  it('keeps a UTF-8 character split between frames intact', () => {
    const bytes = Buffer.from('café ✓\n');
    const d = new LogDecoder(false);
    const out = [...d.push(frame(1, bytes.subarray(0, 4))), ...d.push(frame(1, bytes.subarray(4)))];
    expect(out).toEqual([{ text: 'café ✓', err: false }]);
  });

  it('reads raw text from a TTY container and skips blank lines', () => {
    const d = new LogDecoder(true);
    expect(d.push(Buffer.from('a\n\n  \nb\n'))).toEqual([
      { text: 'a', err: false },
      { text: 'b', err: false },
    ]);
  });
});

describe('countErrors', () => {
  it('counts the same words the old DevDash did and keeps the last one', () => {
    const lines = ['ok', 'Error: bad', 'TypeError at x', 'warn: rate limit hit', 'Traceback (most recent call last)'].map((text) => ({ text, err: false }));
    expect(countErrors(lines)).toEqual({ count: 3, last: 'Traceback (most recent call last)' });
    expect(countErrors([{ text: 'Xbox library poll (account 4): OpenXBL rate limit hit, retrying next poll', err: false }]).count).toBe(0);
  });
});

describe('formatUptime', () => {
  it('reads like DevDash did', () => {
    expect(formatUptime(42_000)).toBe('42s');
    expect(formatUptime(3 * 3600e3 + 5 * 60e3)).toBe('3h 5m');
    expect(formatUptime(6 * 86400e3 + 11 * 3600e3)).toBe('6d 11h');
  });
});

describe('RegistryStore', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dd-')), 'devdash.json');
  const quiet = { warn: () => {} };

  it('starts from the list DevDash had, with the Discord bots as bots', () => {
    const store = new RegistryStore(tmp(), quiet);
    const bots = store.get().services.filter((s) => s.kind === 'bot').map((s) => s.name);
    expect(bots).toEqual(['AlpacaBot', 'BSNSFWBot']);
    expect(store.get().services.length).toBe(DEFAULTS.services.length);
    expect(store.containers().has('pulse-scripts')).toBe(true);
  });

  it('adds, edits, renames and removes, and persists', () => {
    const file = tmp();
    const store = new RegistryStore(file, quiet);
    store.put('Demo', { name: 'Demo', kind: 'app', containers: ['demo'], webUrl: 'http://synology:3999' });
    expect(new RegistryStore(file, quiet).get().services.find((s) => s.name === 'Demo')?.healthUrl).toBeNull();

    store.put('demo', { name: 'Demo2', kind: 'bot', containers: ['demo', 'demo-worker'] });
    const names = new RegistryStore(file, quiet).get().services.map((s) => s.name);
    expect(names).toContain('Demo2');
    expect(names).not.toContain('Demo');

    expect(store.remove('AlpacaBot')).toBe(true);
    expect(store.remove('AlpacaBot')).toBe(false);
    expect(new RegistryStore(file, quiet).get().services.some((s) => s.name === 'AlpacaBot')).toBe(false);
  });

  it('rejects bad input and duplicate names', () => {
    const store = new RegistryStore(tmp(), quiet);
    expect(() => store.add({ name: 'quest', kind: 'app', containers: ['x'] })).toThrow(/already tracked/);
    expect(() => store.put('X', { name: 'X', kind: 'app', containers: [] })).toThrow();
    expect(() => store.put('X', { name: 'X', kind: 'app', containers: ['bad name'] })).toThrow();
    expect(() => store.put('X', { name: 'X', kind: 'app', containers: ['x'], healthUrl: 'ftp://x' })).toThrow();
    // Renaming Quest to Trakt would list Trakt twice.
    expect(() => store.put('Quest', { name: 'Trakt', kind: 'app', containers: ['x'] })).toThrow(/twice/);
    expect(store.get().services.some((s) => s.name === 'Quest')).toBe(true);
  });

  it('falls back to the defaults when the file is corrupt', () => {
    const file = tmp();
    fs.writeFileSync(file, '{"services": [{"name": ""}]}');
    expect(new RegistryStore(file, quiet).get()).toEqual(DEFAULTS);
  });
});

describe('Docker client', () => {
  // A fake Engine API on a Unix socket (a named pipe on Windows).
  const sock = process.platform === 'win32'
    ? `\\\\.\\pipe\\portal-dd-${process.pid}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-sock-')), 'docker.sock');
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    if (req.url === '/containers/json?all=1') {
      res.end(JSON.stringify([{ Id: 'abc', Names: ['/quest-api'], State: 'running' }]));
    } else if (req.url?.startsWith('/containers/abc/logs')) {
      res.end(Buffer.concat([frame(1, 'started\n'), frame(2, 'Error: oops\n')]));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  beforeAll(() => new Promise<void>((r) => server.listen(sock, r)));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('lists containers and reads demultiplexed logs', async () => {
    const docker = new Docker(sock);
    expect((await docker.list())[0].Names).toEqual(['/quest-api']);
    expect(await docker.logs('abc', false, { tail: 10, since: 123 })).toEqual([
      { text: 'started', err: false },
      { text: 'Error: oops', err: true },
    ]);
    expect(seen.at(-1)).toBe('/containers/abc/logs?stdout=1&stderr=1&tail=10&since=123');
  });

  it('reports a missing container as an error', async () => {
    await expect(new Docker(sock).inspect('nope')).rejects.toThrow(/404/);
  });

  it('fails cleanly when there is no socket', async () => {
    const missing = process.platform === 'win32' ? '\\\\.\\pipe\\portal-dd-none' : '/nonexistent/docker.sock';
    await expect(new Docker(missing).list()).rejects.toThrow(/Docker socket/);
  });
});

import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { CameraService } from './camera';
import { UpstreamError } from './http';
import { PhotoService } from './photos';
import { getQuote, getQuotes, resolveSymbol } from './quotes';
import { LEAGUES, League, SettingsStore } from './settings';
import { getScores, getTeams } from './sports';
import { linkStatuses } from './status';

const PORT = Number(process.env.PORT ?? 3012);
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const CAMERA_ROOT = process.env.CAMERA_ROOT ?? '/cameras';
const NAS_HOST = process.env.NAS_HOST ?? '192.168.0.105';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const log = {
  info: (m: string) => app.log.info(m),
  warn: (m: string) => app.log.warn(m),
};

const settings = new SettingsStore(path.join(DATA_DIR, 'settings.json'), log);
const photos = new PhotoService(process.env.UNSPLASH_ACCESS_KEY || undefined, log);
const camera = new CameraService(CAMERA_ROOT, path.join(DATA_DIR, 'camera'), log);

if (!photos.configured) app.log.warn('UNSPLASH_ACCESS_KEY is not set; using the built-in photo set');

app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public'), prefix: '/' });
// Converted camera files are named per conversion, so they can be cached for good.
app.register(fastifyStatic, {
  root: camera.outDir,
  prefix: '/media/',
  decorateReply: false,
  maxAge: '7d',
  immutable: true,
});

app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return reply.status(400).send({ error: `${first.path.join('.') || 'settings'}: ${first.message}` });
  }
  if (err instanceof UpstreamError) {
    return reply.status(err.status === 404 ? 404 : 502).send({ error: err.message });
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  return reply.status(status).send({ error: err.message });
});

app.get('/health', async () => ({ ok: true }));

app.get('/api/settings', async () => settings.get());
app.put('/api/settings', async (req) => settings.set(req.body));

app.get<{ Querystring: { last?: string } }>('/api/photo', async (req) => photos.next(settings.get(), req.query.last));

app.get('/api/quotes', async () => getQuotes(settings.get().tickers));

app.get<{ Querystring: { symbol?: string } }>('/api/quotes/lookup', async (req, reply) => {
  const symbol = resolveSymbol(req.query.symbol ?? '');
  if (!/^[A-Z0-9.^=-]{1,12}$/.test(symbol)) return reply.status(400).send({ error: 'Enter a ticker symbol, like MSFT or SPX' });
  const q = await getQuote(symbol);
  return { symbol: q.symbol, name: q.label ?? q.name, kind: q.kind };
});

app.get('/api/scores', async () => ({ games: await getScores(settings.get().teams) }));

app.get<{ Querystring: { league?: string } }>('/api/sports/teams', async (req, reply) => {
  const league = req.query.league as League;
  if (!LEAGUES.includes(league)) return reply.status(400).send({ error: `league must be one of ${LEAGUES.join(', ')}` });
  return { teams: await getTeams(league) };
});

app.get('/api/status', async () => linkStatuses(settings.get().links.map((l) => l.url), NAS_HOST));

app.get('/api/camera', async () => {
  const { state, processing, error } = camera.status();
  const label = settings.get().camera.label;
  if (!state) return { label, none: true, processing, error };
  return {
    label,
    date: state.date,
    duration: state.duration,
    video: `media/${state.video}`,
    poster: `media/${state.poster}`,
    processing,
    error,
  };
});

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => camera.start())
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

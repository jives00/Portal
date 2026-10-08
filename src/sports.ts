import { TtlCache } from './cache';
import { getJson } from './http';
import type { League } from './settings';

// ESPN's public site API: no key, covers every league we need, and the scoreboard carries live state.
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const PATHS: Record<League, { api: string; web: string; scoreboardExtra?: string }> = {
  NFL: { api: 'football/nfl', web: 'nfl' },
  NBA: { api: 'basketball/nba', web: 'nba' },
  // groups=50 is all of Division I; without it the scoreboard only lists featured games.
  NCAAB: { api: 'basketball/mens-college-basketball', web: 'mens-college-basketball', scoreboardExtra: '&groups=50&limit=400' },
  MLB: { api: 'baseball/mlb', web: 'mlb' },
};

export interface Team {
  id: string;
  name: string;
  abbr: string;
  color: string;
  logo?: string;
}

export interface Side {
  id: string;
  name: string;
  abbr: string;
  color: string;
  score?: number;
  winner?: boolean;
  home: boolean;
}

export interface GameEvent {
  id: string;
  date: number;
  state: 'pre' | 'in' | 'post';
  detail: string;
  note?: string;
  tv?: string;
  link: string;
  sides: Side[];
}

export type GameState = 'live' | 'today' | 'final' | 'next' | 'none';

export interface TeamGame {
  league: League;
  team: Team;
  rank: number;
  state: GameState;
  event?: GameEvent;
}

const HOUR = 3600_000;

/* ---------------- pure helpers (tested) ---------------- */

function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

const validHex = (h?: string | null): h is string => Boolean(h && /^#?[0-9a-f]{6}$/i.test(h));
const withHash = (h: string) => (h.startsWith('#') ? h : `#${h}`).toLowerCase();

/**
 * Team marks sit on dark glass, so navy or black primaries vanish. Prefer whichever team color is
 * light enough; otherwise lighten the primary toward white.
 */
export function readableColor(primary?: string | null, alternate?: string | null): string {
  const candidates = [primary, alternate].filter(validHex).map(withHash);
  const light = candidates.find((c) => luminance(c) >= 0.12);
  if (light) return light;
  if (!candidates.length) return '#9aa3ad';
  const n = parseInt(candidates[0].slice(1), 16);
  const mix = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * 0.5));
  return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Chooses what a team's row shows, in plan order: live > later today > final in the last day >
 * next scheduled > nothing.
 */
export function pickGame(teamId: string, events: GameEvent[], next: GameEvent | undefined, now: number) {
  const mine = [...events, ...(next ? [next] : [])]
    .filter((e) => e.sides.some((s) => s.id === teamId))
    .sort((a, b) => a.date - b.date);

  const live = mine.find((e) => e.state === 'in');
  if (live) return { rank: 0, state: 'live' as const, event: live };

  const today = mine.find((e) => e.state === 'pre' && e.date > now - 4 * HOUR && e.date - now < 16 * HOUR);
  if (today) return { rank: 1, state: 'today' as const, event: today };

  // Event dates are start times, so "within a day of the final" is roughly 27h after first pitch.
  const finals = mine.filter((e) => e.state === 'post' && now - e.date < 27 * HOUR);
  if (finals.length) return { rank: 2, state: 'final' as const, event: finals[finals.length - 1] };

  const upcoming = mine.find((e) => e.state === 'pre' && e.date > now - 4 * HOUR);
  if (upcoming) return { rank: 3, state: 'next' as const, event: upcoming };

  return { rank: 4, state: 'none' as const, event: undefined };
}

/* ---------------- ESPN plumbing ---------------- */

export function normalizeEvent(e: any, league: League): GameEvent | null {
  const c = e?.competitions?.[0];
  if (!c) return null;
  const status = c.status ?? e.status;
  const state = status?.type?.state;
  if (state !== 'pre' && state !== 'in' && state !== 'post') return null;
  const b = c.broadcasts?.[0];
  const note: string | undefined =
    c.notes?.[0]?.headline ??
    (e.seasonType?.type === 1 || e.season?.type === 1 ? 'Preseason' : undefined) ??
    (e.week?.number && league === 'NFL' ? `Week ${e.week.number}` : undefined);
  return {
    id: String(e.id),
    date: Date.parse(e.date),
    state,
    detail: status.type.shortDetail ?? status.type.detail ?? '',
    note,
    tv: b?.names?.[0] ?? b?.media?.shortName,
    link: `https://www.espn.com/${PATHS[league].web}/game/_/gameId/${e.id}`,
    sides: (c.competitors ?? []).map((x: any) => {
      const raw = x.score;
      // ESPN reports 0-0 for games that haven't started; only show scores once play begins.
      const score = state === 'pre' || raw == null || raw === '' ? undefined : Number(typeof raw === 'object' ? raw.value : raw);
      return {
        id: String(x.team?.id ?? x.id),
        name: x.team?.displayName ?? x.team?.abbreviation ?? '?',
        abbr: x.team?.abbreviation ?? '?',
        color: readableColor(x.team?.color, x.team?.alternateColor),
        score: Number.isFinite(score) ? score : undefined,
        winner: x.winner,
        home: x.homeAway === 'home',
      };
    }),
  };
}

const teamsCache = new TtlCache<Team[]>(24 * HOUR);
const boardCache = new TtlCache<GameEvent[]>(30_000);
const nextCache = new TtlCache<GameEvent | undefined>(10 * 60_000);

export function getTeams(league: League): Promise<Team[]> {
  return teamsCache.get(league, async () => {
    const d = await getJson<any>(`${ESPN}/${PATHS[league].api}/teams?limit=500`);
    const list: any[] = d?.sports?.[0]?.leagues?.[0]?.teams ?? [];
    return list
      .map(({ team: t }) => ({
        id: String(t.id),
        name: t.displayName,
        abbr: t.abbreviation,
        color: readableColor(t.color, t.alternateColor),
        logo: t.logos?.[0]?.href,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

function scoreboard(league: League, day: string, ttlMs: number): Promise<GameEvent[]> {
  return boardCache.get(
    `${league}:${day}`,
    async () => {
      const p = PATHS[league];
      const d = await getJson<any>(`${ESPN}/${p.api}/scoreboard?dates=${day}${p.scoreboardExtra ?? ''}`);
      return (d?.events ?? []).map((e: any) => normalizeEvent(e, league)).filter(Boolean) as GameEvent[];
    },
    ttlMs,
  );
}

function teamNext(league: League, id: string): Promise<GameEvent | undefined> {
  return nextCache.get(`${league}:${id}`, async () => {
    const d = await getJson<any>(`${ESPN}/${PATHS[league].api}/teams/${id}`);
    return normalizeEvent(d?.team?.nextEvent?.[0], league) ?? undefined;
  });
}

/** YYYYMMDD in the server's timezone (TZ is set to America/Chicago in the container). */
export function dayKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))
    .replace(/-/g, '');
}

export async function getScores(teams: { league: League; id: string }[]): Promise<TeamGame[]> {
  const now = Date.now();
  const leagues = [...new Set(teams.map((t) => t.league))];
  const today = dayKey(now);
  const yesterday = dayKey(now - 24 * HOUR);

  const perLeague = new Map<League, { events: GameEvent[]; teams: Team[] }>();
  await Promise.all(
    leagues.map(async (league) => {
      const [t, y, list] = await Promise.allSettled([
        scoreboard(league, today, 30_000),
        scoreboard(league, yesterday, 10 * 60_000),
        getTeams(league),
      ]);
      perLeague.set(league, {
        events: [...(t.status === 'fulfilled' ? t.value : []), ...(y.status === 'fulfilled' ? y.value : [])],
        teams: list.status === 'fulfilled' ? list.value : [],
      });
    }),
  );

  const rows = await Promise.all(
    teams.map(async ({ league, id }): Promise<TeamGame> => {
      const ctx = perLeague.get(league)!;
      const team = ctx.teams.find((t) => t.id === id) ?? { id, name: `Team ${id}`, abbr: '?', color: '#9aa3ad' };
      const next = await teamNext(league, id).catch(() => undefined);
      const picked = pickGame(id, ctx.events, next, now);
      // nextEvent comes from a different endpoint without team colors; borrow them from the team list.
      picked.event?.sides.forEach((s) => {
        const known = ctx.teams.find((t) => t.id === s.id);
        if (known) {
          s.color = known.color;
          s.name = known.name;
        }
      });
      return { league, team, ...picked };
    }),
  );

  // A game between two followed teams should show once.
  const seen = new Set<string>();
  return rows
    .sort((a, b) => a.rank - b.rank || (a.event?.date ?? Infinity) - (b.event?.date ?? Infinity))
    .filter((r) => {
      if (!r.event) return true;
      if (seen.has(r.event.id)) return false;
      seen.add(r.event.id);
      return true;
    });
}

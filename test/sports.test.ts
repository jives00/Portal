import { describe, expect, it } from 'vitest';
import { GameEvent, normalizeEvent, pickGame, readableColor } from '../src/sports';

const H = 3600_000;
const NOW = Date.parse('2026-10-08T15:00:00Z');

function ev(id: string, state: GameEvent['state'], date: number, teams = ['16', '8']): GameEvent {
  return {
    id,
    state,
    date,
    detail: '',
    link: '',
    sides: teams.map((t, i) => ({ id: t, abbr: t, color: '#fff', home: i === 0 })),
  };
}

describe('readableColor', () => {
  it('keeps a primary that reads on dark glass', () => {
    expect(readableColor('e64100', '0b1c3a')).toBe('#e64100');
  });
  it('falls back to the alternate when the primary is navy', () => {
    expect(readableColor('0b1c3a', 'e64100')).toBe('#e64100');
  });
  it('lightens when both colors are dark', () => {
    expect(readableColor('000000', '0b1c3a')).toBe('#808080');
  });
  it('handles missing colors', () => {
    expect(readableColor(undefined, null)).toBe('#9aa3ad');
  });
});

describe('pickGame', () => {
  it('prefers a live game over everything else', () => {
    const r = pickGame('16', [ev('a', 'post', NOW - 20 * H), ev('b', 'in', NOW - H)], ev('c', 'pre', NOW + 48 * H), NOW);
    expect(r).toMatchObject({ rank: 0, state: 'live' });
    expect(r.event?.id).toBe('b');
  });

  it('shows a game later today before last night’s final', () => {
    const r = pickGame('16', [ev('a', 'post', NOW - 18 * H), ev('b', 'pre', NOW + 4 * H)], undefined, NOW);
    expect(r).toMatchObject({ rank: 1, state: 'today' });
  });

  it('keeps a final for about a day, then moves on to the next game', () => {
    const final = ev('a', 'post', NOW - 20 * H);
    const next = ev('c', 'pre', NOW + 72 * H);
    expect(pickGame('16', [final], next, NOW)).toMatchObject({ state: 'final' });
    expect(pickGame('16', [final], next, NOW + 10 * H)).toMatchObject({ state: 'next', event: { id: 'c' } });
  });

  it('treats a completed nextEvent as a final', () => {
    expect(pickGame('16', [], ev('a', 'post', NOW - 5 * H), NOW)).toMatchObject({ state: 'final' });
  });

  it('ignores games for other teams', () => {
    expect(pickGame('16', [ev('x', 'in', NOW, ['4', '5'])], undefined, NOW)).toMatchObject({ rank: 4, state: 'none' });
  });
});

describe('normalizeEvent', () => {
  it('reads an ESPN scoreboard event', () => {
    const e = normalizeEvent(
      {
        id: '401',
        date: '2026-10-08T00:08Z',
        competitions: [
          {
            status: { type: { state: 'in', shortDetail: 'Bot 6th' } },
            notes: [{ headline: 'NLDS - Game 3' }],
            broadcasts: [{ names: ['TBS'] }],
            competitors: [
              { homeAway: 'home', score: '2', team: { id: '8', abbreviation: 'MIL', color: '13294b', alternateColor: 'ffc52f' } },
              { homeAway: 'away', score: '4', team: { id: '16', abbreviation: 'CHC', color: '0e3386', alternateColor: 'cc3433' } },
            ],
          },
        ],
      },
      'MLB',
    );
    expect(e).toMatchObject({
      id: '401',
      state: 'in',
      detail: 'Bot 6th',
      note: 'NLDS - Game 3',
      tv: 'TBS',
      link: 'https://www.espn.com/mlb/game/_/gameId/401',
    });
    expect(e?.sides.map((s) => [s.abbr, s.score, s.home])).toEqual([
      ['MIL', 2, true],
      ['CHC', 4, false],
    ]);
  });

  it('reads a team nextEvent with object scores and media broadcasts', () => {
    const e = normalizeEvent(
      {
        id: '9',
        date: '2026-10-11T17:00Z',
        week: { number: 6 },
        competitions: [
          {
            status: { type: { state: 'pre', shortDetail: '10/11 - 1:00 PM EDT' } },
            broadcasts: [{ media: { shortName: 'Fox' } }],
            competitors: [{ homeAway: 'home', score: { value: 0 }, team: { id: '9', abbreviation: 'GB' } }],
          },
        ],
      },
      'NFL',
    );
    expect(e).toMatchObject({ tv: 'Fox', note: 'Week 6' });
    expect(e?.sides[0].score).toBeUndefined();
    expect(e?.sides[0].color).toBe('#9aa3ad');
  });

  it('skips events without a usable state', () => {
    expect(normalizeEvent({ id: '1', competitions: [{ status: { type: { state: 'postponed' } } }] }, 'NBA')).toBeNull();
  });
});

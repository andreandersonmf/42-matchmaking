import type { Rank, VipTier } from './types.js';

function tier(name: string, color: string, start: number, divisions: string[]): Rank[] {
  return divisions.map((numeral, index) => ({ name: `${name} ${numeral}`, tier: name, min: start + index * 100, color }));
}

export const RANKS: Rank[] = [
  ...tier('Bronze', '#c78a62', 0, ['I', 'II', 'III']),
  ...tier('Silver', '#b4c4d6', 300, ['I', 'II', 'III']),
  ...tier('Gold', '#f4c566', 600, ['I', 'II', 'III', 'IV']),
  ...tier('Platinum', '#70d5c3', 1000, ['I', 'II', 'III', 'IV']),
  ...tier('Emerald', '#4cc38a', 1400, ['I', 'II', 'III', 'IV']),
  ...tier('Diamond', '#8ca9ff', 1800, ['I', 'II', 'III', 'IV']),
  { name: 'Master', tier: 'Master', min: 2200, color: '#bc8af5' },
  { name: 'Grandmaster', tier: 'Grandmaster', min: 2500, color: '#f05267' },
  { name: 'Challenger', tier: 'Challenger', min: 2800, color: '#ff8a5c' },
];

export function rankFor(elo: number) {
  const index = RANKS.findLastIndex(rank => elo >= rank.min);
  const rank = RANKS[Math.max(index, 0)];
  const nextRank = RANKS[index + 1] ?? null;
  const progress = nextRank ? Math.max(0, Math.min(100, (elo - rank.min) / (nextRank.min - rank.min) * 100)) : 100;
  return { rank, nextRank, progress };
}

/** Elo inicial de todo jogador novo (e de todos no reset de temporada). */
export const START_ELO = 200;

/**
 * Elo simétrico: num jogo equilibrado a vitória dá ~+16 e a derrota tira ~-16, então ninguém sobe só por jogar.
 * A força de cada jogador mistura o próprio Elo com a média do time; vencer time mais forte vale mais.
 * Nas 5 primeiras partidas (calibração) tudo vale o dobro.
 */
export function calculateElo(input: {
  elo: number;
  teamAverage: number;
  opponentAverage: number;
  won: boolean;
  mvp: boolean;
  vip: VipTier;
  calibrating?: boolean;
}) {
  const strength = (input.elo + input.teamAverage) / 2;
  const expected = 1 / (1 + 10 ** ((input.opponentAverage - strength) / 400));
  const k = input.calibrating ? 64 : 32;
  const base = Math.round(k * ((input.won ? 1 : 0) - expected));
  const vipBonus = input.won ? Math.round(base * (input.vip === 'vip_plus' ? 0.15 : input.vip === 'vip' ? 0.1 : 0)) : 0;
  const mvpBonus = input.mvp ? 4 : 0;
  const delta = Math.max(0, input.elo + base + vipBonus) - input.elo + mvpBonus;
  return { delta, base, vipBonus, mvpBonus, expected };
}

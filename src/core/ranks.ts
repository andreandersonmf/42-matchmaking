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

export function calculateElo(input: {
  elo: number;
  teamAverage: number;
  opponentAverage: number;
  won: boolean;
  mvp: boolean;
  vip: VipTier;
}) {
  const expected = 1 / (1 + 10 ** ((input.opponentAverage - input.teamAverage) / 400));
  const base = input.won ? Math.round(24 + 16 * (1 - expected)) : -Math.round(12 + 12 * expected);
  const protectedBase = !input.won && input.elo < 300 ? Math.max(base, -10) : base;
  const vipBonus = input.won ? Math.round(base * (input.vip === 'vip_plus' ? 0.15 : input.vip === 'vip' ? 0.1 : 0)) : 0;
  const mvpBonus = input.mvp ? 4 : 0;
  const delta = Math.max(0, input.elo + protectedBase + vipBonus) - input.elo + mvpBonus;
  return { delta, base: protectedBase, vipBonus, mvpBonus, expected };
}

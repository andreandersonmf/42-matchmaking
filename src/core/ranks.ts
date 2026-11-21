import type { Rank, VipTier } from './types.js';

/** Divisões de 100 PDL, da mais baixa para a mais alta (como no LoL: Ouro IV → Ouro I). */
function tier(name: string, color: string, start: number, divisions: string[]): Rank[] {
  return divisions.map((numeral, index) => ({ name: `${name} ${numeral}`, tier: name, min: start + index * 100, color }));
}

/** Elo do jogador = pontos da escada: cada divisão vale 100 PDL; no Mestre os PDL continuam subindo. */
export const MASTER_MIN = 2200;
/** Vagas do topo, recalculadas a cada leitura do ranking: Desafiante = 10 primeiros, Grão-Mestre = os 20 seguintes. */
export const APEX = { challenger: { slots: 10, minLp: 300 }, grandmaster: { slots: 20, minLp: 100 } };

const GRANDMASTER: Rank = { name: 'Grandmaster', tier: 'Grandmaster', min: MASTER_MIN + APEX.grandmaster.minLp, color: '#f05267' };
const CHALLENGER: Rank = { name: 'Challenger', tier: 'Challenger', min: MASTER_MIN + APEX.challenger.minLp, color: '#ff8a5c' };
const LADDER: Rank[] = [
  ...tier('Bronze', '#c78a62', 0, ['III', 'II', 'I']),
  ...tier('Silver', '#b4c4d6', 300, ['III', 'II', 'I']),
  ...tier('Gold', '#f4c566', 600, ['IV', 'III', 'II', 'I']),
  ...tier('Platinum', '#70d5c3', 1000, ['IV', 'III', 'II', 'I']),
  ...tier('Emerald', '#4cc38a', 1400, ['IV', 'III', 'II', 'I']),
  ...tier('Diamond', '#8ca9ff', 1800, ['IV', 'III', 'II', 'I']),
  { name: 'Master', tier: 'Master', min: MASTER_MIN, color: '#bc8af5' },
];
/** Para exibir: Grão-Mestre e Desafiante mostram em `min` o PDL mínimo no Mestre para disputar a vaga. */
export const RANKS: Rank[] = [...LADDER, GRANDMASTER, CHALLENGER];

/** Rank pela escada (sem as vagas do topo; essas vêm de `ladderRanks`). `lp` é o PDL dentro da divisão. */
export function rankFor(elo: number) {
  const index = LADDER.findLastIndex(rank => elo >= rank.min);
  const rank = LADDER[Math.max(index, 0)];
  const lp = Math.max(0, elo - rank.min);
  const nextRank = LADDER[index + 1] ?? null;
  return { rank, nextRank, progress: nextRank ? Math.min(100, lp) : 100, lp };
}

/** Recebe jogadores já ordenados pelo Elo e coloca Desafiante/Grão-Mestre em quem é Mestre com PDL mínimo. */
export function ladderRanks(sorted: { elo: number }[]) {
  let challengers = 0;
  let grandmasters = 0;
  return sorted.map(player => {
    const info = rankFor(player.elo);
    if (info.rank.name !== 'Master') return info;
    if (challengers < APEX.challenger.slots && info.lp >= APEX.challenger.minLp) {
      challengers++;
      return { ...info, rank: CHALLENGER };
    }
    if (grandmasters < APEX.grandmaster.slots && info.lp >= APEX.grandmaster.minLp) {
      grandmasters++;
      return { ...info, rank: GRANDMASTER };
    }
    return info;
  });
}

/** Elo inicial de todo jogador novo (e de todos no reset de temporada): Bronze I com 0 PDL. */
export const START_ELO = 200;

/**
 * Perda com PDL acima de 0 para no 0 da divisão; com 0 PDL a derrota rebaixa (sem proteção).
 * No Mestre o piso é o 0 PDL do Mestre. Nunca abaixo de 0 no total.
 */
export function applyLp(elo: number, delta: number): number {
  if (delta >= 0) return elo + delta;
  const floor = rankFor(elo).rank.min;
  return elo > floor ? Math.max(floor, elo + delta) : Math.max(0, elo + delta);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * PDL estilo LoL. O MMR (oculto) segue Elo simétrico K=32 com a força `(MMR + média do time) / 2`.
 * O PDL parte de ±20 num jogo parelho; vencer time mais forte vale mais, e quem tem MMR acima do rank
 * ganha mais e perde menos (até ±50% com 100 de diferença), o contrário quando o MMR está abaixo.
 * Nas 5 primeiras partidas (calibração) PDL e MMR valem o dobro. VIP: +10%/+15% do PDL da vitória. MVP: +4 PDL.
 */
export function calculateElo(input: {
  elo: number;
  mmr: number;
  teamAverage: number;
  opponentAverage: number;
  won: boolean;
  mvp: boolean;
  vip: VipTier;
  calibrating?: boolean;
}) {
  const strength = (input.mmr + input.teamAverage) / 2;
  const expected = 1 / (1 + 10 ** ((input.opponentAverage - strength) / 400));
  const scale = input.calibrating ? 2 : 1;
  const mmrDelta = Math.round(32 * scale * ((input.won ? 1 : 0) - expected));
  const surprise = clamp(2 * (input.won ? 1 - expected : expected), 0.5, 1.5);
  const gap = clamp((input.mmr - input.elo) / 200, -0.5, 0.5);
  const lp = Math.round(20 * scale * surprise * (1 + (input.won ? gap : -gap)));
  const base = input.won ? lp : -lp;
  const vipBonus = input.won ? Math.round(base * (input.vip === 'vip_plus' ? 0.15 : input.vip === 'vip' ? 0.1 : 0)) : 0;
  const mvpBonus = input.mvp ? 4 : 0;
  return { delta: base + vipBonus + mvpBonus, base, vipBonus, mvpBonus, mmrDelta, expected };
}

/** O MMR é oculto: o site nunca recebe `mmr` nem `mmrDelta` (replacer de JSON.stringify). */
export const hideMmr = (key: string, value: unknown) => key === 'mmr' || key === 'mmrDelta' ? undefined : value;

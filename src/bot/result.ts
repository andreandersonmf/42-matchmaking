import sharp from 'sharp';
import type { Match, MatchPlayer, Team } from '../core/types.js';
import { rankFor } from '../core/ranks.js';
import { modeNames, rankNamePt } from './presentation.js';
import { escapeXml, normalizeAvatar } from './profile.js';
import { drawable, FONT_STACK, svgToPng } from './render.js';
import { fetchAvatar } from './roblox.js';

export const RESULT_WIDTH = 1100;
export const RESULT_HEIGHT = 650;
// Primeira linha de jogadores. Os títulos das equipes ficam acima dela, sem sobreposição.
const ROW_TOP = 300;
const ROW_STEP = 50;

const label = (value: string, length = 40) => escapeXml(Array.from(drawable(value) || '—').slice(0, length).join(''));
const number = (value: number) => Math.round(Number.isFinite(value) ? value : 0).toLocaleString('pt-BR');
const rankColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : '#ef4053';

const datePt = (value: number | null) => value === null || !Number.isFinite(value)
  ? '—' : new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function teamRows(players: MatchPlayer[], team: Team, x0: number, mvpId: string | null): string {
  const teamPlayers = players.filter(player => player.team === team).slice(0, 6);
  if (!teamPlayers.length) return `<text x="${x0 + 56}" y="${ROW_TOP + 32}" fill="#65687b" font-size="14">Aguardando jogadores.</text>`;
  return teamPlayers.map((player, index) => {
    const y = ROW_TOP + index * ROW_STEP;
    const color = rankColor(rankFor(player.elo).rank.color);
    const isMvp = player.discordId === mvpId;
    const delta = player.eloDelta === null ? '<tspan fill="#797c91">—</tspan>'
      : `<tspan fill="${player.eloDelta >= 0 ? '#4cc38a' : '#f04455'}">${player.eloDelta >= 0 ? '+' : ''}${number(player.eloDelta)} PDL</tspan>`;
    return `<g>
      <circle cx="${x0 + 26}" cy="${y + 12}" r="20" fill="#21232e" stroke="${isMvp ? '#ffd166' : '#30313d'}" stroke-width="2"/>
      <text x="${x0 + 56}" y="${y + 16}" fill="${isMvp ? '#ffd166' : '#f6f6f8'}" font-size="15" font-weight="700">${label(player.robloxName, 20)}${player.isCaptain ? '<tspan dx="6" fill="#ef4053">[C]</tspan>' : ''}</text>
      <text x="${x0 + 56}" y="${y + 33}" fill="${color}" font-size="11" font-weight="650">${player.position === 'spiker' ? 'SPIKER' : 'SETTER'} · ${label(rankNamePt(rankFor(player.elo).rank.name), 24)}</text>
      <text x="${x0 + 472}" y="${y + 16}" fill="#ffffff" font-size="16" font-weight="800" text-anchor="end">${number(rankFor(player.elo).lp)} PDL</text>
      <text x="${x0 + 472}" y="${y + 33}" font-size="11" text-anchor="end">${delta}</text>
    </g>`;
  }).join('');
}

export function resultSvg(match: Match): string {
  const code = String(match.id).padStart(4, '0');
  const finished = match.status === 'completed' && match.winner;
  const mvp = match.players.find(player => player.discordId === match.mvpId);
  const verdict = finished
    ? `<rect x="380" y="136" width="340" height="54" rx="12" fill="#331921" stroke="#73303d"/>
      <text x="550" y="172" fill="#ffffff" font-size="26" font-weight="800" text-anchor="middle">EQUIPE ${match.winner} VENCEU</text>
      <text x="550" y="216" fill="#9294a8" font-size="13" text-anchor="middle">${match.mode ? label(modeNames[match.mode].toUpperCase()) : 'MODO EM VOTAÇÃO'} · ${label(datePt(match.finishedAt))}</text>
      <text x="550" y="244" fill="${mvp ? '#ffd166' : '#65687b'}" font-size="15" font-weight="700" text-anchor="middle">${mvp ? `MVP · ${label(mvp.robloxName, 24)} (+4 ELO)` : 'SEM MVP'}</text>`
    : `<rect x="380" y="136" width="340" height="54" rx="12" fill="#24252f" stroke="#3a3b47"/>
      <text x="550" y="172" fill="#f6f6f8" font-size="24" font-weight="800" text-anchor="middle">PARTIDA CANCELADA</text>
      <text x="550" y="216" fill="#9294a8" font-size="13" text-anchor="middle">Nenhum Elo foi contabilizado.</text>`;
  const headerY = ROW_TOP - 26;
  const winnerHeader = (team: Team) => match.winner === team
    ? `<text x="${team === 'A' ? 60 : 572}" y="${headerY}" fill="#ffffff" font-size="16" font-weight="800">EQUIPE ${team} · VENCEDORA</text>
       <rect x="${team === 'A' ? 60 : 572}" y="${headerY + 9}" width="190" height="3" rx="1.5" fill="url(#accent)"/>`
    : `<text x="${team === 'A' ? 60 : 572}" y="${headerY}" fill="#9294a8" font-size="16" font-weight="800">EQUIPE ${team}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RESULT_WIDTH}" height="${RESULT_HEIGHT}" viewBox="0 0 ${RESULT_WIDTH} ${RESULT_HEIGHT}">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#181a23"/><stop offset="1" stop-color="#0a0b10"/></linearGradient>
    <linearGradient id="accent"><stop stop-color="#b32239"/><stop offset="1" stop-color="#ef4053"/></linearGradient>
  </defs>
  <rect width="${RESULT_WIDTH}" height="${RESULT_HEIGHT}" rx="26" fill="url(#bg)"/>
  <rect x="1" y="1" width="${RESULT_WIDTH - 2}" height="${RESULT_HEIGHT - 2}" rx="25" fill="none" stroke="#30313d"/>
  <path d="M860 0H1100V295L1018 252Z" fill="#ef4053" opacity=".07"/>
  <path d="M930 0H960L1100 203V247Z" fill="#ef4053" opacity=".12"/>
  <rect x="0" y="34" width="5" height="55" fill="#ef4053"/>
  <g font-family="${FONT_STACK}">
    <text x="52" y="67" fill="#f6f6f8" font-size="29" font-weight="800">4.2 <tspan fill="#ef4053">MATCHMAKING</tspan></text>
    <text x="53" y="91" fill="#9294a8" font-size="11" letter-spacing="3">RESULTADO FINAL / PARTIDA #${code} / 6v6</text>
    <rect x="54" y="114" width="${RESULT_WIDTH - 108}" height="2" fill="url(#accent)"/>
    ${verdict}
    ${winnerHeader('A')}
    <text x="526" y="${ROW_TOP - 26}" fill="#797c91" font-size="10" letter-spacing="2" text-anchor="end">ELO ±</text>
    ${winnerHeader('B')}
    <text x="1038" y="${ROW_TOP - 26}" fill="#797c91" font-size="10" letter-spacing="2" text-anchor="end">ELO ±</text>
    ${teamRows(match.players, 'A', 54, match.mvpId)}
    ${teamRows(match.players, 'B', 566, match.mvpId)}
    <path d="M54 ${RESULT_HEIGHT - 54}H1046" stroke="#282a36"/>
    <text x="54" y="${RESULT_HEIGHT - 27}" fill="#696d81" font-size="10" letter-spacing="1.4">4 SPIKERS + 2 SETTERS. UMA EQUIPE.</text>
    <text x="1046" y="${RESULT_HEIGHT - 27}" fill="#696d81" font-size="10" text-anchor="end">/profile · /ranking</text>
  </g>
</svg>`;
}

export async function renderResult(match: Match, options: { avatars?: (Buffer | null)[] } = {}): Promise<Buffer> {
  const teams = [...match.players.filter(player => player.team === 'A').slice(0, 6), ...match.players.filter(player => player.team === 'B').slice(0, 6)];
  const sources = options.avatars ?? await Promise.all(teams.map(player => fetchAvatar(player.robloxId)));
  const avatars = await Promise.all(sources.map(source => normalizeAvatar(source)));
  const slots = [
    ...teams.filter(player => player.team === 'A').map((_, index) => ({ x: 60, y: ROW_TOP + index * ROW_STEP - 8 })),
    ...teams.filter(player => player.team === 'B').map((_, index) => ({ x: 572, y: ROW_TOP + index * ROW_STEP - 8 })),
  ];
  const image = sharp(svgToPng(resultSvg(match)));
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (let index = 0; index < avatars.length; index++) {
    const avatar = avatars[index];
    if (!avatar || !slots[index]) continue;
    composites.push({ input: await sharp(avatar).resize(40, 40).png().toBuffer(), left: slots[index].x, top: slots[index].y });
  }
  if (composites.length) image.composite(composites);
  return image.png().toBuffer();
}

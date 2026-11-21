import sharp from 'sharp';
import type { RankedPlayer } from '../core/types.js';
import { rankNamePt } from './presentation.js';
import { escapeXml, normalizeAvatar } from './profile.js';
import { drawable, FONT_STACK, svgToPng } from './render.js';
import { fetchAvatar } from './roblox.js';

export const RANKING_WIDTH = 1100;
export const RANKING_HEIGHT = 840;

const label = (value: string, length = 40) => escapeXml(Array.from(drawable(value) || '—').slice(0, length).join(''));
const number = (value: number) => Math.round(Number.isFinite(value) ? value : 0).toLocaleString('pt-BR');

export function rankingSvg(players: RankedPlayer[]): string {
  const ranked = [...players].sort((a, b) => a.standing - b.standing).slice(0, 10);
  const rows = ranked.map((player, index) => {
    const y = 168 + index * 64;
    const rankColor = /^#[0-9a-f]{6}$/i.test(player.rank.color) ? player.rank.color : '#ef4053';
    return `<g>
      <path d="M54 ${y + 44}H1046" stroke="#23252f"/>
      <text x="52" y="${y + 27}" fill="#9294a8" font-size="15" font-weight="700" text-anchor="middle">${String(player.standing).padStart(2, '0')}</text>
      <circle cx="132" cy="${y + 12}" r="26" fill="#21232e" stroke="${rankColor}" stroke-width="2"/>
      <text x="176" y="${y + 10}" fill="#f6f6f8" font-size="18" font-weight="700">${label(player.robloxName, 22)}</text>
      <text x="176" y="${y + 30}" fill="${rankColor}" font-size="12" font-weight="650">${player.position === 'spiker' ? 'SPIKER' : 'SETTER'} · ${label(rankNamePt(player.rank.name), 26)}</text>
      <text x="1038" y="${y + 17}" fill="#ffffff" font-size="21" font-weight="800" text-anchor="end">${number(player.lp)} PDL</text>
      <text x="1038" y="${y + 33}" fill="#797c91" font-size="11" text-anchor="end">${number(player.wins)} vitórias · ${number(player.mvps)} MVPs</text>
    </g>`;
  }).join('');
  const empty = !ranked.length ? `<text x="550" y="420" fill="#9294a8" font-size="22" text-anchor="middle" font-weight="650">O ranking ainda está vazio.</text><text x="550" y="452" fill="#65687b" font-size="14" text-anchor="middle">Comece com /register e /verificar.</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RANKING_WIDTH}" height="${RANKING_HEIGHT}" viewBox="0 0 ${RANKING_WIDTH} ${RANKING_HEIGHT}">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#181a23"/><stop offset="1" stop-color="#0a0b10"/></linearGradient>
    <linearGradient id="accent"><stop stop-color="#b32239"/><stop offset="1" stop-color="#ef4053"/></linearGradient>
  </defs>
  <rect width="${RANKING_WIDTH}" height="${RANKING_HEIGHT}" rx="26" fill="url(#bg)"/>
  <rect x="1" y="1" width="${RANKING_WIDTH - 2}" height="${RANKING_HEIGHT - 2}" rx="25" fill="none" stroke="#30313d"/>
  <path d="M860 0H1100V295L1018 252Z" fill="#ef4053" opacity=".07"/>
  <path d="M930 0H960L1100 203V247Z" fill="#ef4053" opacity=".12"/>
  <rect x="0" y="34" width="5" height="55" fill="#ef4053"/>
  <g font-family="${FONT_STACK}">
    <text x="52" y="67" fill="#f6f6f8" font-size="29" font-weight="800">4.2 <tspan fill="#ef4053">MATCHMAKING</tspan></text>
    <text x="53" y="91" fill="#9294a8" font-size="11" letter-spacing="3">RANKING COMPETITIVO / TOP 10 POR ELO</text>
    <text x="1046" y="66" fill="#9294a8" font-size="12" text-anchor="end" letter-spacing="2">${number(ranked.length)} EXIBIDOS</text>
    <rect x="54" y="114" width="${RANKING_WIDTH - 108}" height="2" fill="url(#accent)"/>
    ${rows}
    ${empty}
    <path d="M54 806H1046" stroke="#282a36"/>
    <text x="54" y="828" fill="#696d81" font-size="10" letter-spacing="1.4">4 SPIKERS + 2 SETTERS. UMA EQUIPE.</text>
    <text x="1046" y="828" fill="#696d81" font-size="10" text-anchor="end">/fila · /profile · /ranking</text>
  </g>
</svg>`;
}

export async function renderRanking(players: RankedPlayer[], options: { avatars?: (Buffer | null)[] } = {}): Promise<Buffer> {
  const ranked = [...players].sort((a, b) => a.standing - b.standing).slice(0, 10);
  const sources = options.avatars ?? await Promise.all(ranked.map(player => fetchAvatar(player.robloxId)));
  const avatars = await Promise.all(sources.map(source => normalizeAvatar(source)));
  const image = sharp(svgToPng(rankingSvg(ranked)));
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (let index = 0; index < avatars.length; index++) {
    const avatar = avatars[index];
    if (!avatar) continue;
    composites.push({ input: await sharp(avatar).resize(52, 52).png().toBuffer(), left: 106, top: 168 + index * 64 - 14 });
  }
  if (composites.length) image.composite(composites);
  return image.png().toBuffer();
}

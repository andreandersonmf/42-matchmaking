import sharp from 'sharp';
import type { PlayerProfile } from '../core/types.js';
import { fetchAvatar } from './roblox.js';
import { rankLabel, rankNamePt, vipNames } from './presentation.js';
import { drawable, FONT_STACK, svgToPng } from './render.js';

export const PROFILE_WIDTH = 1100;
export const PROFILE_HEIGHT = 600;

export function escapeXml(value: string): string {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const label = (value: string, length = 35) => escapeXml(Array.from(drawable(value) || '—').slice(0, length).join(''));
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const number = (value: number) => Math.round(finite(value)).toLocaleString('pt-BR');

export function profileSvg(profile: PlayerProfile): string {
  const { player, eloHistory } = profile;
  const progress = Math.min(100, Math.max(0, finite(player.progress)));
  const winRate = player.matches ? Math.round(player.wins / player.matches * 100) : 0;
  const rankColor = /^#[0-9a-f]{6}$/i.test(player.rank.color) ? player.rank.color : '#ef4053';
  const history = eloHistory.slice(-20).map(point => finite(point.elo));
  if (history.length < 2) history.push(finite(player.elo), finite(player.elo));
  const min = Math.min(...history) - 20;
  const max = Math.max(...history) + 20;
  const points = history.map((elo, index) => `${740 + index / (history.length - 1) * 302},${430 - (elo - min) / (max - min) * 68}`).join(' ');
  const stats = [
    { title: 'VITÓRIAS', value: number(player.wins), note: `${number(player.losses)} derrotas` },
    { title: 'PARTIDAS', value: number(player.matches), note: 'jogos competitivos' },
    { title: 'WIN RATE', value: `${winRate}%`, note: 'taxa de vitória' },
    { title: 'MVPs', value: number(player.mvps), note: 'vezes em destaque' },
  ];
  const expiry = player.vipExpiresAt && Number.isFinite(player.vipExpiresAt) && Math.abs(player.vipExpiresAt) < 8.64e15
    ? new Date(player.vipExpiresAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="600" viewBox="0 0 1100 600">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#181a23"/><stop offset="1" stop-color="#0a0b10"/></linearGradient>
    <linearGradient id="accent"><stop stop-color="#b32239"/><stop offset="1" stop-color="#ef4053"/></linearGradient>
    <linearGradient id="area" x2="0" y2="1"><stop stop-color="#ef4053" stop-opacity=".28"/><stop offset="1" stop-color="#ef4053" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="1100" height="600" rx="26" fill="url(#bg)"/>
  <rect x="1" y="1" width="1098" height="598" rx="25" fill="none" stroke="#30313d"/>
  <path d="M860 0H1100V295L1018 252Z" fill="#ef4053" opacity=".07"/>
  <path d="M930 0H960L1100 203V247Z" fill="#ef4053" opacity=".12"/>
  <rect x="0" y="34" width="5" height="55" fill="#ef4053"/>
  <g font-family="${FONT_STACK}">
    <text x="52" y="67" fill="#f6f6f8" font-size="29" font-weight="800">4.2 <tspan fill="#ef4053">MATCHMAKING</tspan></text>
    <text x="53" y="91" fill="#9294a8" font-size="11" letter-spacing="3">PERFIL COMPETITIVO / ROBLOX / 6v6</text>
    <rect x="935" y="45" width="111" height="32" rx="8" fill="#331921" stroke="#73303d"/>
    <text x="990" y="66" text-anchor="middle" fill="#ff9caa" font-size="13" font-weight="700">${label(vipNames[player.vip])}</text>
    <circle cx="142" cy="207" r="88" fill="#ef4053" opacity=".1"/>
    <circle cx="142" cy="207" r="82" fill="#21232e" stroke="#ef4053" stroke-width="2"/>
    <circle cx="142" cy="191" r="26" fill="#656777"/>
    <path d="M90 253C93 204 191 204 194 253A72 72 0 0 1 90 253" fill="#656777"/>
    <text x="254" y="156" fill="#999bac" font-size="12" letter-spacing="2">JOGADOR / #${number(player.standing)}</text>
    <text x="254" y="195" fill="#ffffff" font-size="31" font-weight="750">${label(player.robloxName, 24)}</text>
    <text x="255" y="219" fill="#9294a8" font-size="14">${label(player.name, 40)}</text>
    <rect x="254" y="233" width="184" height="29" rx="7" fill="#262630"/>
    <circle cx="269" cy="248" r="4" fill="${rankColor}"/>
    <text x="282" y="253" fill="${rankColor}" font-size="13" font-weight="700">${label(rankNamePt(player.rank.name), 24)}</text>
    <text x="1046" y="175" fill="#ffffff" text-anchor="end" font-size="43" font-weight="800">${number(player.lp)}</text>
    <text x="1044" y="199" fill="#ef4053" text-anchor="end" font-size="12" letter-spacing="3">PDL</text>
    <text x="1045" y="252" fill="#999bac" text-anchor="end" font-size="12">${player.nextRank ? `${number(Math.max(0, 100 - player.lp))} PDL para ${label(rankNamePt(player.nextRank.name))}` : 'Top 30 com 100+ PDL: Grão-Mestre · Top 10 com 300+: Desafiante'}</text>
    <rect x="254" y="276" width="792" height="6" rx="3" fill="#2a2b35"/>
    <rect x="254" y="276" width="${792 * progress / 100}" height="6" rx="3" fill="url(#accent)"/>
    <path d="M54 313H1046" stroke="#2a2b36"/>
    ${stats.map((stat, index) => `<g transform="translate(${54 + index * 160},338)"><rect width="144" height="111" rx="13" fill="#1d1f29" stroke="#2c2e3a"/><text x="17" y="27" fill="#9698ab" font-size="11" letter-spacing="1.5">${label(stat.title)}</text><text x="17" y="69" fill="#f9f9fb" font-size="32" font-weight="750">${label(stat.value)}</text><text x="17" y="93" fill="#797c91" font-size="11">${label(stat.note)}</text></g>`).join('')}
    <text x="739" y="347" fill="#a9aabc" font-size="11" letter-spacing="2">EVOLUÇÃO NA ESCADA</text>
    <path d="M740 384H1042M740 415H1042" stroke="#282a36" stroke-dasharray="3 5"/>
    <polygon points="740,449 ${points} 1042,449" fill="url(#area)"/>
    <polyline points="${points}" fill="none" stroke="#ef4053" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="54" y="491" fill="#787c91" font-size="10" letter-spacing="2">POSIÇÃO</text>
    <text x="54" y="517" fill="#eeeeF4" font-size="18" font-weight="650">${player.position === 'spiker' ? 'SPIKER' : 'SETTER'}</text>
    <text x="255" y="491" fill="#787c91" font-size="10" letter-spacing="2">MELHOR RANK</text>
    <text x="255" y="517" fill="#eeeeF4" font-size="18" font-weight="650">${label(rankLabel(player.bestElo), 24)}</text>
    <text x="455" y="491" fill="#787c91" font-size="10" letter-spacing="2">SEQUÊNCIA ATUAL</text>
    <text x="455" y="517" fill="#eeeeF4" font-size="18" font-weight="650">${number(player.streak)}</text>
    <text x="739" y="491" fill="#787c91" font-size="10" letter-spacing="2">MEMBRO ${label(vipNames[player.vip])}</text>
    <text x="739" y="516" fill="#c6c8d4" font-size="14">${player.vip === 'none' ? 'Seu próximo rank começa na fila.' : `Válido até ${label(expiry)}`}</text>
    <path d="M54 546H1046" stroke="#282a36"/>
    <text x="54" y="573" fill="#696d81" font-size="10" letter-spacing="1.4">4 SPIKERS + 2 SETTERS. UMA EQUIPE.</text>
    <text x="1046" y="573" fill="#696d81" text-anchor="end" font-size="10">/fila · /ranking · /profile</text>
  </g>
</svg>`;
}

export async function normalizeAvatar(avatar: Buffer | null): Promise<Buffer | null> {
  if (!avatar || avatar.length > 2_000_000) return null;
  try {
    const input = sharp(avatar, { limitInputPixels: 16_000_000, failOn: 'error' });
    const metadata = await input.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) return null;
    return await input.resize(156, 156, { fit: 'cover' }).ensureAlpha().composite([{
      input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="156" height="156"><circle cx="78" cy="78" r="78" fill="white"/></svg>'), blend: 'dest-in',
    }]).png().toBuffer();
  } catch {
    return null;
  }
}

export async function renderProfile(profile: PlayerProfile, options: { avatar?: Buffer | null } = {}): Promise<Buffer> {
  const source = Object.hasOwn(options, 'avatar') ? options.avatar ?? null : await fetchAvatar(profile.player.robloxId);
  const avatar = await normalizeAvatar(source);
  const image = sharp(svgToPng(profileSvg(profile)));
  if (avatar) image.composite([{ input: avatar, left: 64, top: 129 }]);
  return image.png().toBuffer();
}

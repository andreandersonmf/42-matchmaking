import { createContext, useContext, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, Crown, Inbox, RefreshCw, SearchX, Trophy, Users } from 'lucide-react';
import type { Match, MatchStatus, PublicConfig, Rank, RankedPlayer } from '../core/types';
import { rankFor } from '../core/ranks';
import { percent } from './api';
import { useI18n } from './i18n';

export const AppContext = createContext<{ config: PublicConfig | null; openDiscord: () => void }>({ config: null, openDiscord: () => {} });
export const useApp = () => useContext(AppContext);

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><svg className="brand-mark" viewBox="0 0 64 50" fill="none" aria-hidden="true"><path d="M19 4 2 29h22V4M17 29v16" stroke="currentColor" strokeWidth="6" strokeLinejoin="miter"/><path d="M39 9c5-8 21-7 21 3 0 8-18 16-22 29h24" stroke="currentColor" strokeWidth="6"/><path d="M28 39h6v6h-6z" fill="#ff4252"/></svg>{!compact && <span className="brand-copy">MATCHMAKING<span>VOLLEYBALL 4.2</span></span>}</span>;
}

export function DiscordIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.7 5.1a18 18 0 0 0-4.3-1.3l-.5 1a16 16 0 0 0-5.8 0l-.5-1a18 18 0 0 0-4.3 1.3C1.6 9.2.9 13.1 1.3 17a18 18 0 0 0 5.3 2.7l1.1-1.8-1.6-.8.4-.3c3.5 1.6 7.5 1.6 11 0l.4.3-1.6.8 1.1 1.8a18 18 0 0 0 5.3-2.7c.5-4.5-.8-8.4-3-11.9ZM8.4 14.6c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm7.2 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z"/></svg>;
}

export function DiscordButton({ children, className = 'button primary', arrow = false }: { children?: ReactNode; className?: string; arrow?: boolean }) {
  const { config, openDiscord } = useApp();
  const { t } = useI18n();
  const content = <><DiscordIcon/><span>{children ?? t('Join the Discord')}</span>{arrow && <ArrowUpRight size={17}/>}</>;
  const invite = config?.discordInvite;
  if (invite && /^https:\/\//i.test(invite)) return <a href={invite} className={className} target="_blank" rel="noopener noreferrer" aria-label={`${typeof children === 'string' ? children : 'Discord'} ${t('(opens in new tab)')}`}>{content}</a>;
  return <button type="button" className={className} onClick={openDiscord}>{content}</button>;
}

export function Avatar({ name, robloxId, size = 'medium' }: { name: string; robloxId?: string; size?: 'small' | 'medium' | 'large' | 'hero' }) {
  const { config } = useApp();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [robloxId]);
  const initials = name.trim().split(/[\s_]+/).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase() || '?';
  const hues = [216, 156, 273, 33, 338, 185];
  const hue = hues[Array.from(name).reduce((sum, char) => sum + (char.codePointAt(0) || 0), 0) % hues.length];
  const src = config && !config.demo && robloxId && !failed ? `/api/avatar/${encodeURIComponent(robloxId)}` : null;
  return <span className={`avatar avatar-${size}`} style={{ '--avatar-hue': hue } as CSSProperties} aria-hidden="true">{src ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)}/> : initials}</span>;
}

export function RankEmblem({ color = '#b4c4d6', large = false }: { color?: string; large?: boolean }) {
  return <svg className={`rank-emblem${large ? ' large' : ''}`} viewBox="0 0 48 52" fill="none" style={{ color }} aria-hidden="true"><path d="m24 2 19 12v23L24 50 5 37V14L24 2Z" fill="currentColor" fillOpacity=".06" stroke="currentColor" strokeOpacity=".3"/><path d="m24 8 13 9v16L24 43 11 33V17l13-9Z" fill="currentColor" fillOpacity=".13" stroke="currentColor" strokeOpacity=".65"/><path d="m24 13 10 11-10 13-10-13 10-11Z" fill="currentColor" fillOpacity=".85"/><path d="m24 13 1 12 9-1M24 37l1-12-11-1" stroke="#0d1016" strokeOpacity=".55"/><path d="m8 38 6 5m26-5-6 5" stroke="currentColor" strokeWidth="2"/></svg>;
}

export function RankBadge({ rank, text = true }: { rank: Rank; text?: boolean }) {
  const { rankName } = useI18n();
  return <span className="rank-badge" role="img" aria-label={rankName(rank.name)} style={{ color: rank.color }}><RankEmblem color={rank.color}/>{text && <span>{rankName(rank.name)}</span>}</span>;
}

export function VipBadge({ tier }: { tier: RankedPlayer['vip'] }) {
  if (tier === 'none') return null;
  return <span className={`vip-badge ${tier === 'vip_plus' ? 'plus' : ''}`}><Crown size={10}/>{tier === 'vip_plus' ? 'VIP+' : 'VIP'}</span>;
}

export function StatusBadge({ status }: { status: MatchStatus }) {
  const { statuses } = useI18n();
  const item = statuses[status];
  return <span className={`status-badge ${item.tone}`}><i/>{item.label}</span>;
}

export function EmptyState({ title, description, search = false, action }: { title?: string; description?: string; search?: boolean; action?: ReactNode }) {
  const { t } = useI18n();
  const Icon = search ? SearchX : Inbox;
  return <div className="empty-state"><span className="empty-icon"><Icon size={25} strokeWidth={1.5}/></span><h3>{title ?? t('Nothing here yet.')}</h3><p>{description ?? t('When there is news, it will show up here.')}</p>{action}</div>;
}

export function ErrorState({ error, retry, compact = false }: { error: Error & { status?: number }; retry: () => void; compact?: boolean }) {
  const { t } = useI18n();
  return <div className={`error-state${compact ? ' compact' : ''}`} role="alert"><CircleAlert size={25}/><div><h3>{error.status === 404 ? t('This record was not found') : t('Could not update')}</h3><p>{error.message}</p></div><button className="button secondary small" onClick={retry}><RefreshCw size={15}/>{t('Try again')}</button>{error.status === 404 && <a className="text-link" href="#/overview">{t('Back to start')} <ArrowRight size={15}/></a>}</div>;
}

export function LoadingState({ rows = 5, hero = false }: { rows?: number; hero?: boolean }) {
  const { t } = useI18n();
  return <div className="loading-state" role="status" aria-label={t('Loading data')}><span className="sr-only">{t('Loading data…')}</span>{hero && <div className="skeleton skeleton-hero"/>}<div className="skeleton skeleton-title"/>{Array.from({ length: rows }, (_, i) => <div className="skeleton skeleton-row" key={i}/>)}</div>;
}

export function PageHeading({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description: string; aside?: ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}<span className="title-dot">.</span></h1><p>{description}</p></div>{aside}</div>;
}

export function SectionHeading({ title, eyebrow, href, link, aside }: { title: string; eyebrow?: string; href?: string; link?: string; aside?: ReactNode }) {
  const { t } = useI18n();
  return <div className="section-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{href ? <a className="text-link" href={href}>{link ?? t('View all')}<ArrowUpRight size={15}/></a> : aside}</div>;
}

export function StatCard({ label, value, detail, icon, accent = false }: { label: string; value: ReactNode; detail: ReactNode; icon: ReactNode; accent?: boolean }) {
  return <div className={`stat-card${accent ? ' accent' : ''}`}><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value}</strong><span className="stat-detail">{detail}</span></div>;
}

export function Pagination({ page, pages, total, label, onChange }: { page: number; pages: number; total: number; label: string; onChange: (page: number) => void }) {
  const { t, number } = useI18n();
  if (!total) return null;
  const last = Math.max(1, pages);
  const visible = Array.from(new Set([1, page - 1, page, page + 1, last].filter(value => value > 0 && value <= last))).sort((a, b) => a - b);
  return <div className="pagination"><span>{number(total)} {label}<span className="pagination-context">{t(' · Page {page} of {last}', { page: number(page), last: number(last) })}</span></span><nav aria-label={t('Pagination')}><button className="pagination-arrow" aria-label={t('Previous page')} disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={17}/></button>{visible.map((value, index) => <span key={value} className="pagination-item">{index > 0 && value - visible[index - 1] > 1 && <span className="pagination-ellipsis">…</span>}<button aria-label={t('Page {value}', { value })} aria-current={page === value ? 'page' : undefined} className={page === value ? 'selected' : ''} onClick={() => onChange(value)}>{value}</button></span>)}<button className="pagination-arrow" aria-label={t('Next page')} disabled={page >= last} onClick={() => onChange(page + 1)}><ChevronRight size={17}/></button></nav></div>;
}

export function PlayerTable({ players, compact = false }: { players: RankedPlayer[]; compact?: boolean }) {
  const { t, number, positions } = useI18n();
  if (!players.length) return <EmptyState title={t('The next name could be yours')} description={t('No players registered yet. Link your account on Discord to get started.')}/>;
  return <div className="table-scroll"><table className={`player-table${compact ? ' compact-table' : ''}`}><caption className="sr-only">{t('Player ranking by Elo')}</caption><thead><tr><th scope="col" className="standing-cell">#</th><th scope="col">{t('Player')}</th><th scope="col">Rank</th><th scope="col" className="numeric">{t('LP')}</th>{!compact && <><th scope="col" className="numeric">{t('Matches')}</th><th scope="col" className="numeric">{t('Wins')}</th><th scope="col" className="numeric">Win rate</th><th scope="col" className="numeric">MVPs</th></>}<th scope="col"><span className="sr-only">{t('Player profile')}</span></th></tr></thead><tbody>{players.map(player => <tr key={player.discordId} className={player.standing === 1 ? 'leader-row' : ''}><td className="standing-cell"><span className={player.standing === 1 ? 'first-place' : 'standing'}>{player.standing === 1 ? <Crown size={17}/> : String(player.standing).padStart(2, '0')}</span><span className="sr-only">{player.standing === 1 ? t('First place') : ''}</span></td><td><a className="player-identity" href={`#/perfil/${encodeURIComponent(player.discordId)}`}><Avatar name={player.robloxName} robloxId={player.robloxId}/><span><span className="player-name">{player.robloxName}<VipBadge tier={player.vip}/></span><span className="player-meta">{positions[player.position]}{compact && <span> · {percent(player.wins, player.matches)}% WR</span>}</span></span></a></td><td><RankBadge rank={player.rank}/></td><td className="numeric elo-cell">{number(player.lp)}</td>{!compact && <><td className="numeric muted">{number(player.matches)}</td><td className="numeric">{number(player.wins)}</td><td className="numeric"><span className={percent(player.wins, player.matches) >= 50 ? 'positive' : 'muted'}>{percent(player.wins, player.matches)}%</span></td><td className="numeric muted">{number(player.mvps)}</td></>}<td className="row-arrow"><a href={`#/perfil/${encodeURIComponent(player.discordId)}`} aria-label={t('View {name} profile', { name: player.robloxName })}><ArrowUpRight size={17}/></a></td></tr>)}</tbody></table></div>;
}

export function MatchCard({ match }: { match: Match }) {
  const { t, date, modes, rankName } = useI18n();
  const a = match.players.filter(player => player.team === 'A');
  const b = match.players.filter(player => player.team === 'B');
  const average = (players: Match['players']) => players.length ? rankName(rankFor(players.reduce((sum, player) => sum + player.elo, 0) / players.length).rank.name) : '—';
  return <a className="match-card" href={`#/partida/${match.id}`}><div className="match-card-top"><span className="match-id">{t('MATCH #')}{String(match.id).padStart(4, '0')}</span><StatusBadge status={match.status}/></div><div className="match-versus"><div><span className="team-symbol team-a">A</span><strong>{t('Team A')}{match.winner === 'A' && <Trophy size={14}/>}</strong><small>{average(a)} {t('avg rank')}</small></div><span className="versus">vs</span><div><span className="team-symbol team-b">B</span><strong>{t('Team B')}{match.winner === 'B' && <Trophy size={14}/>}</strong><small>{average(b)} {t('avg rank')}</small></div></div><div className="match-card-footer"><span><Users size={13}/>{match.mode ? modes[match.mode] : t('Mode in voting')}</span><span>{date(match.createdAt)}<ArrowUpRight size={15}/></span></div></a>;
}

export function EloDelta({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  return <span className={`elo-delta ${value >= 0 ? 'positive' : 'negative'}`}>{value >= 0 ? <ArrowUpRight size={14}/> : <ArrowDownLeft size={14}/>} {value > 0 ? '+' : ''}{value}</span>;
}

export function CourtIllustration() {
  return <svg className="court-illustration" viewBox="0 0 680 480" fill="none" aria-hidden="true"><defs><linearGradient id="court-line" x1="0" y1="470" x2="620" y2="80" gradientUnits="userSpaceOnUse"><stop stopColor="#ef364b" stopOpacity=".08"/><stop offset=".65" stopColor="#ff5364" stopOpacity=".7"/><stop offset="1" stopColor="#ff8893" stopOpacity=".2"/></linearGradient><radialGradient id="ball-fill" cx=".32" cy=".2" r=".85"><stop stopColor="#f5f1ed"/><stop offset=".6" stopColor="#a6a0a3"/><stop offset="1" stopColor="#49434a"/></radialGradient><radialGradient id="ball-glow"><stop stopColor="#ff354a" stopOpacity=".32"/><stop offset="1" stopColor="#ff354a" stopOpacity="0"/></radialGradient><clipPath id="ball-clip"><circle cx="451" cy="179" r="67"/></clipPath></defs><ellipse cx="444" cy="237" rx="200" ry="190" fill="url(#ball-glow)"/><g stroke="url(#court-line)" strokeWidth="1.5"><path d="m83 280 283-137 270 154-285 157L83 280Z" fill="#ef3547" fillOpacity=".022"/><path d="m218 215 272 158M277 187l274 150M158 244l272 161M90 290l260 174 294-163"/><path d="m212 356 284-141" strokeDasharray="3 6"/><path d="m219 215-2-88 270 151 3 95M217 128 502 272M217 147 490 299M217 163l272 155M218 182l271 154M218 201l272 154"/><path d="m238 140 1 86m21-76 1 88m21-76 1 88m21-75 1 87m21-75 1 87m21-74 1 86m21-73 1 86m21-73 1 86m21-73 1 86m21-72 1 85m21-72 1 85m21-72 1 86" strokeOpacity=".5"/><path d="m216 127-4 112m277 40 4 115" strokeWidth="4"/><path d="M353 454v-17m283-140-16 1M83 280l20 2M366 143l-1 16" strokeWidth="3"/></g><path d="M358 75c64-16 155 7 204 73" stroke="#ee4657" strokeOpacity=".35" strokeDasharray="4 8"/><path d="m557 134 6 17-18-1" stroke="#ee4657" strokeOpacity=".4"/><ellipse cx="451" cy="290" rx="65" ry="16" fill="#ff394b" fillOpacity=".07"/><circle cx="451" cy="179" r="67" fill="url(#ball-fill)"/><g clipPath="url(#ball-clip)" stroke="#51464c" strokeWidth="1.8"><path d="M401 130c24 5 52 23 63 55-25 10-48 26-57 49M420 115c26 9 51 28 61 60M443 112c30 11 49 30 57 51M464 185c17-18 34-23 56-22M482 183c15-3 24-2 36 1M480 201c16-1 25 1 33 5M407 234c-7-27-14-45-25-62M428 244c-3-17-7-30-14-42M448 247c-3-20-8-38-17-51M464 185c6 19 8 40 6 59"/><path d="M401 130c24 5 52 23 63 55 17-18 34-23 56-22l-5-24-44-36-49 6Z" fill="#f63e53" fillOpacity=".8" stroke="#842b39"/><path d="M420 115c26 9 51 28 61 60M443 112c30 11 49 30 57 51" stroke="#972f40"/></g><circle cx="451" cy="179" r="67" stroke="#fff" strokeOpacity=".17"/><g fill="#a58e94" fontFamily="monospace" fontSize="9" letterSpacing="2"><text x="317" y="475">THE COURT IS YOURS.</text><text x="516" y="94" transform="rotate(30 516 94)">4.2 / MM</text></g><path d="M593 365v15m-7-7h14M298 95v11m-5-5h10" stroke="#cc6673" strokeOpacity=".55"/></svg>;
}

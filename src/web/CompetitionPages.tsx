import { useEffect, useState } from 'react';
import { ArrowUpRight, ListFilter, Search, Swords, Trophy, X } from 'lucide-react';
import type { Match, RankedPlayer } from '../core/types';
import { navigate, useApi } from './api';
import { DiscordButton, EmptyState, ErrorState, LoadingState, MatchCard, PageHeading, Pagination, PlayerTable, RankEmblem, useApp } from './components';
import { useI18n } from './i18n';

type PlayersResponse = { players: RankedPlayer[]; total: number; page: number; pages: number };
type MatchesResponse = { matches: Match[]; total: number; page: number; pages: number };
const pageNumber = (query: URLSearchParams) => Math.max(1, Math.min(100000, Math.floor(Number(query.get('page')) || 1)));

export function RankingPage({ query }: { query: URLSearchParams }) {
  const { config } = useApp();
  const { t, number, rankName } = useI18n();
  const search = query.get('search') || '';
  const position = ['spiker', 'setter'].includes(query.get('position') || '') ? query.get('position')! : 'all';
  const tiers = [...new Set(config?.ranks.map(rank => rank.tier) || [])];
  const tier = tiers.includes(query.get('tier') || '') ? query.get('tier')! : 'all';
  const page = pageNumber(query);
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);
  const params = new URLSearchParams({ search, position, tier, page: String(page), limit: '10' });
  const resource = useApi<PlayersResponse>(`/api/players?${params}`);
  const change = (changes: Record<string, string>) => {
    const next = new URLSearchParams({ search, position, tier, page: '1', ...changes });
    for (const [key, value] of [...next.entries()]) if (!value || value === 'all' || (key === 'page' && value === '1')) next.delete(key);
    navigate(`ranking${next.size ? `?${next}` : ''}`);
  };
  const filtered = search || position !== 'all' || tier !== 'all';
  return <>
    <PageHeading eyebrow={t('THE BEST MEET HERE')} title={t('Ranking')} description={t('Every point is an achievement. Every position, a new story.')} aside={<div className="heading-emblem"><RankEmblem color="#edbd73" large/><span>{t('CLAIM')}<br/><strong>{t('YOUR SPOT.')}</strong></span></div>}/>
    <div className="ranking-banner"><span className="ranking-banner-icon"><Trophy size={22}/></span><div><strong>{t('The top is earned on the court.')}</strong><p>{t('Play, grow your Elo and find your place among the best.')}</p></div><a href="#/regras" className="text-link">{t('How Elo works')} <ArrowUpRight size={15}/></a><span className="banner-watermark" aria-hidden="true">#1</span></div>
    <section className="panel ranking-panel" aria-label={t('Player ranking')}><div className="filter-bar"><form className="filter-search" role="search" onSubmit={event => { event.preventDefault(); change({ search: draft.trim() }); }}><Search size={17}/><input aria-label={t('Search player')} placeholder={t('Search by Roblox username…')} value={draft} onChange={event => setDraft(event.target.value)} maxLength={100}/>{draft && <button type="button" className="icon-button clear-search" aria-label={t('Clear search')} onClick={() => { setDraft(''); change({ search: '' }); }}><X size={14}/></button>}<button className="search-submit" type="submit">{t('Search')}</button></form><div className="filter-selects"><label><span className="sr-only">{t('Filter by position')}</span><select aria-label={t('Filter by position')} value={position} onChange={event => change({ position: event.target.value })}><option value="all">{t('All positions')}</option><option value="spiker">Spiker</option><option value="setter">Setter</option></select></label><label><span className="sr-only">{t('Filter by rank')}</span><select aria-label={t('Filter by rank')} value={tier} onChange={event => change({ tier: event.target.value })}><option value="all">{t('All ranks')}</option>{tiers.map(value => <option key={value} value={value}>{rankName(value)}</option>)}</select></label></div></div>
    <div className="results-caption"><span><ListFilter size={13}/>{search ? t('Results for “{search}”', { search }) : t('Ranking by Elo')}</span><span>{resource.data ? t('{n} players', { n: number(resource.data.total) }) : t('Loading ranking')}</span></div>
    {resource.loading ? <LoadingState rows={7}/> : resource.error ? <ErrorState error={resource.error} retry={resource.retry}/> : resource.data && <>{resource.data.players.length ? <PlayerTable players={resource.data.players}/> : <EmptyState search={Boolean(filtered)} title={filtered ? t('No players found') : t('The ranking starts with you')} description={filtered ? t('Try another name or adjust the filters to find your player.') : t('Players registered on Discord will appear here. There is no data to rank yet.')} action={filtered ? <button className="button secondary small" onClick={() => { setDraft(''); navigate('ranking'); }}>{t('Clear filters')}</button> : <DiscordButton className="button secondary small"/>}/>}<Pagination page={resource.data.page} pages={resource.data.pages} total={resource.data.total} label={t('players')} onChange={value => change({ page: String(value) })}/></>}
    </section><div className="table-note"><span><Trophy size={14}/>{t('Position considers each player’s current Elo.')}</span><a href="#/regras">{t('See all ranks')} <ArrowUpRight size={13}/></a></div>
  </>;
}

export function MatchesPage({ query }: { query: URLSearchParams }) {
  const { t, number, modes } = useI18n();
  const status = ['active', 'completed'].includes(query.get('status') || '') ? query.get('status')! : 'all';
  const mode = ['captains', 'balanced', 'random'].includes(query.get('mode') || '') ? query.get('mode')! : 'all';
  const page = pageNumber(query);
  const params = new URLSearchParams({ status, mode, page: String(page), limit: '10' });
  const resource = useApi<MatchesResponse>(`/api/matches?${params}`);
  const change = (changes: Record<string, string>) => {
    const next = new URLSearchParams({ status, mode, page: '1', ...changes });
    navigate(`partidas?${next}`);
  };
  return <><PageHeading eyebrow={t('EVERY MATCH, A STORY')} title={t('On the court')} description={t('Follow the games, meet the teams and check the results.')} aside={<DiscordButton arrow>{t('Find a match')}</DiscordButton>}/><div className="matches-toolbar"><nav className="tabs" aria-label={t('Filter matches by status')}>{[['all', t('All matches')], ['active', t('Active')], ['completed', t('History')]].map(([value, label]) => <a key={value} className={value === status ? 'active' : ''} aria-current={value === status ? 'page' : undefined} href={`#/partidas?${new URLSearchParams({ status: value, mode })}`}>{value === 'active' && <span className="live-dot"/>}{label}</a>)}</nav><label className="mode-select"><ListFilter size={16}/><span className="sr-only">{t('Filter match mode')}</span><select aria-label={t('Filter match mode')} value={mode} onChange={event => change({ mode: event.target.value })}><option value="all">{t('All modes')}</option>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {resource.loading ? <LoadingState rows={5}/> : resource.error ? <ErrorState error={resource.error} retry={resource.retry}/> : resource.data && <>{resource.data.matches.length ? <><div className="list-meta"><span>{t('{n} matches found', { n: number(resource.data.total) })}</span><span><Swords size={13}/>{t('6v6 · 4 spikers + 2 setters per team')}</span></div><div className="match-grid all-matches">{resource.data.matches.map(match => <MatchCard match={match} key={match.id}/>)}</div><Pagination page={resource.data.page} pages={resource.data.pages} total={resource.data.total} label={t('Matches')} onChange={value => change({ page: String(value) })}/></> : <div className="panel"><EmptyState title={status === 'active' ? t('Break between serves') : t('No matches around here')} description={mode !== 'all' ? t('There are no matches in this mode with the selected filter. Try viewing all modes.') : status === 'active' ? t('No active matches right now. Join Discord and get ready for the next game.') : t('When staff starts matches on Discord, they will appear here.')} action={mode !== 'all' ? <button className="button secondary small" onClick={() => change({ mode: 'all' })}>{t('View all modes')}</button> : <DiscordButton className="button secondary small"/>}/></div>}</>}
    <div className="readonly-note"><ShieldNote/></div></>;
}

function ShieldNote() {
  const { t } = useI18n();
  return <><span className="readonly-dot"/>{t('You follow along here. The queue, the votes and the organization happen on Discord.')}</>;
}

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, ChevronRight, Crown, LayoutDashboard, Menu, Search, ShieldCheck, Swords, Trophy, X } from 'lucide-react';
import type { Overview } from '../core/types';
import { navigate, useApi, useRoute } from './api';
import { AppContext, Brand, DiscordButton, DiscordIcon, EmptyState, ErrorState, LoadingState } from './components';
import { LanguageSwitcher, useI18n } from './i18n';
import OverviewPage from './OverviewPage';
import { MatchesPage, RankingPage } from './CompetitionPages';
import { MatchDetailPage, ProfilePage } from './DetailPages';
import { RulesPage, VipPage } from './InfoPages';

export default function App() {
  const { t } = useI18n();
  const links = [
    { path: 'overview', label: t('Overview'), icon: LayoutDashboard, group: t('COMPETITION') },
    { path: 'ranking', label: t('Ranking'), icon: Trophy, group: '' },
    { path: 'partidas', label: t('Matches'), icon: Swords, group: '' },
    { path: 'regras', label: t('Rules & ranks'), icon: BookOpen, group: t('BEYOND THE COURT') },
    { path: 'vip', label: t('Go VIP'), icon: Crown, group: '' },
  ];
  const overview = useApi<Overview>('/api/overview', 15000);
  const route = useRoute();
  const [search, setSearch] = useState(route.query.get('search') || '');
  const [discordOpen, setDiscordOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const discordDialog = useRef<HTMLDialogElement>(null);
  const menuDialog = useRef<HTMLDialogElement>(null);
  const main = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const previousPath = useRef(route.path);
  const lastOverview = useRef<Overview | null>(null);
  if (overview.data) lastOverview.current = overview.data;
  const data = overview.data || lastOverview.current;
  const config = data?.config || null;
  const section = route.path.split('/')[0];
  const active = section === 'perfil' ? 'ranking' : section === 'partida' ? 'partidas' : section;
  const title = section === 'perfil' ? t('Player profile') : section === 'partida' ? t('Match details') : links.find(link => link.path === active)?.label || t('Page not found');
  const searchQuery = route.query.get('search') || '';

  useEffect(() => { if (section === 'ranking') setSearch(searchQuery); }, [section, searchQuery]);
  useEffect(() => {
    document.title = `${title} · ${config?.name || '4.2 Matchmaking'}`;
    setMenuOpen(false);
    if (previousPath.current !== route.path) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      main.current?.focus({ preventScroll: true });
      previousPath.current = route.path;
    }
  }, [route.path, title, config?.name]);
  useEffect(() => {
    const dialog = discordDialog.current;
    if (discordOpen && !dialog?.open) dialog?.showModal();
    if (!discordOpen && dialog?.open) dialog.close();
  }, [discordOpen]);
  useEffect(() => {
    const dialog = menuDialog.current;
    if (menuOpen && !dialog?.open) dialog?.showModal();
    if (!menuOpen && dialog?.open) dialog.close();
  }, [menuOpen]);
  useEffect(() => {
    if (!discordOpen && !menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [discordOpen, menuOpen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || discordOpen || menuOpen) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); searchRef.current?.focus();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [discordOpen, menuOpen]);

  const sidebar = (mobile = false) => <div className="sidebar-inner"><div className="sidebar-brand"><a href="#/overview" aria-label={`4.2 Matchmaking — ${t('Overview')}`} onClick={() => setMenuOpen(false)}><Brand/></a>{mobile && <button className="icon-button" onClick={() => setMenuOpen(false)} aria-label={t('Close menu')}><X size={21}/></button>}</div><div className="sidebar-edition"><span/>{t('YOUR GAME. ANOTHER LEVEL.')}</div><nav className="main-nav" aria-label={mobile ? t('Mobile main menu') : t('Main menu')}>{links.map(({ path, label, icon: Icon, group }) => <div key={path}>{group && <span className="nav-group">{group}</span>}<a href={`#/${path}`} className={`nav-link${active === path ? ' active' : ''}${path === 'vip' ? ' vip-nav' : ''}`} aria-current={active === path ? 'page' : undefined} onClick={() => setMenuOpen(false)}><Icon size={18} strokeWidth={1.65}/><span>{label}</span>{path === 'partidas' && !!data?.stats.activeMatches && <span className="nav-count">{data.stats.activeMatches}</span>}{path === 'vip' && <ArrowUpRight className="vip-nav-arrow" size={13}/>}</a></div>)}</nav><div className="sidebar-bottom"><div className="sidebar-discord"><div className="sidebar-discord-heading"><DiscordIcon size={23}/><span>{t('The community')}<br/><strong>{t('is our team.')}</strong></span></div><p>{t('The queue starts there.')}<br/>{t('So do the best matches.')}</p><DiscordButton className="sidebar-discord-link" arrow/></div><div className="sidebar-status"><span className={config?.configured ? 'live-dot' : 'idle-dot'}/><span>{config?.demo ? t('Demo environment') : config?.configured ? t('Discord configured') : t('Waiting for setup')}</span><ShieldCheck size={12}/></div><div className="sidebar-copyright">{t('MADE FOR THOSE WHO LIVE THE COURT.')}</div></div></div>;

  let page;
  const id = route.path.split('/')[1];
  let decodedId = id || '';
  try { decodedId = decodeURIComponent(decodedId); } catch { decodedId = ''; }
  if (!data) page = overview.error ? <ErrorState error={overview.error} retry={overview.retry}/> : <LoadingState hero rows={5}/>;
  else if (section === 'overview' && route.path === 'overview') page = <OverviewPage overview={data}/>;
  else if (section === 'ranking' && route.path === 'ranking') page = <RankingPage query={route.query}/>;
  else if (section === 'partidas' && route.path === 'partidas') page = <MatchesPage query={route.query}/>;
  else if (section === 'regras' && route.path === 'regras') page = <RulesPage/>;
  else if (section === 'vip' && route.path === 'vip') page = <VipPage/>;
  else if (section === 'perfil' && decodedId && route.path.split('/').length === 2) page = <ProfilePage key={decodedId} id={decodedId}/>;
  else if (section === 'partida' && /^\d+$/.test(decodedId) && route.path.split('/').length === 2) page = <MatchDetailPage key={decodedId} id={decodedId}/>;
  else page = <EmptyState title={t('That play went out of bounds')} description={t('The page you are looking for does not exist. Head back to the hub and keep exploring.')} action={<a className="button primary" href="#/overview">{t('Back to start')} <ArrowRight size={16}/></a>}/>;

  return <AppContext.Provider value={{ config, openDiscord: () => { setMenuOpen(false); setDiscordOpen(true); } }}><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); main.current?.focus(); }}>{t('Skip to content')}</a><aside className="sidebar">{sidebar()}</aside><div className="app-shell"><header className="topbar"><div className="topbar-leading"><button className="icon-button mobile-menu-button" aria-label={t('Open navigation')} aria-expanded={menuOpen} aria-controls="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={22}/></button><div className="breadcrumb"><span>{t('Competitive hub')}</span><ChevronRight size={12}/><strong>{title}</strong></div><a className="mobile-brand" href="#/overview" aria-label="4.2 — início"><Brand compact/></a></div><form className="global-search" role="search" onSubmit={event => { event.preventDefault(); navigate(`ranking${search.trim() ? `?${new URLSearchParams({ search: search.trim() })}` : ''}`); }}><Search size={16}/><input ref={searchRef} type="search" aria-label={t('Search player')} placeholder={t('Search player…')} value={search} onChange={event => setSearch(event.target.value)} maxLength={100}/><button type="submit" aria-label={t('Search the ranking')}><ArrowRight size={14}/></button><kbd aria-hidden="true">/</kbd></form><div className="header-actions">{config?.demo && <span className="demo-chip"><span/>{t('Demo')}</span>}<DiscordButton className="header-discord">Discord</DiscordButton></div></header><main id="main-content" ref={main} tabIndex={-1}><div className="main-content">{overview.error && data && <ErrorState error={overview.error} retry={overview.retry} compact/>}{page}</div><footer className="page-footer"><span><strong>4.2</strong> MATCHMAKING <i/>{t('Made for the next play.')}</span><div>{config?.demo ? <span className="demo-note">{t('Illustrative data · demo environment')}</span> : <span>Volleyball 4.2 · Roblox</span>}<a href="#/regras">{t('Play fair. Play together.')} <ArrowUpRight size={12}/></a></div></footer></main></div>
    <LanguageSwitcher/>
    <dialog id="mobile-menu" ref={menuDialog} className="mobile-drawer" aria-label={t('Navigation')} onClose={() => setMenuOpen(false)} onClick={event => { if (event.target === event.currentTarget) setMenuOpen(false); }}>{sidebar(true)}</dialog>
    <dialog ref={discordDialog} className="discord-modal" aria-labelledby="discord-title" aria-describedby="discord-description" onClose={() => setDiscordOpen(false)} onClick={event => { if (event.target === event.currentTarget) setDiscordOpen(false); }}><div className="modal-content"><button className="icon-button modal-close" aria-label={t('Close notice')} onClick={() => setDiscordOpen(false)}><X size={20}/></button><span className="modal-symbol"><DiscordIcon size={33}/></span><span className="eyebrow">{t('YOUR TEAM MEETS ON DISCORD')}</span><h2 id="discord-title">{t('Discord invite')}<br/>{t('not configured yet')}</h2><p id="discord-description">{t('Queueing and matches happen on Discord. The community link is not available in this environment yet.')}</p><div className="modal-note"><ShieldCheck size={18}/><span>{t('Once the team sets up the invite, you will be able to join from any button on the site.')}</span></div><button className="button primary full-width" onClick={() => setDiscordOpen(false)}>{t('Got it')} <ArrowRight size={16}/></button><span className="modal-bottom">{t('Meanwhile, explore the ranking and get to know the rules.')}</span></div></dialog>
  </AppContext.Provider>;
}

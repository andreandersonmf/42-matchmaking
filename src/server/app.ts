import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomainError } from '../core/engine.js';
import { hideMmr, RANKS } from '../core/ranks.js';
import type { MatchFilter, MatchMode, Overview, PublicConfig, ServiceContract } from '../core/types.js';

type AppOptions = {
  demo: boolean;
  discordInvite: string | null;
  configured: boolean;
  avatar: (robloxId: string) => Promise<Buffer | null>;
};

export function createApp(service: ServiceContract, options: AppOptions) {
  const app = express();
  app.set('json replacer', hideMmr);
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
    next();
  });
  const config: PublicConfig = {
    name: '4.2 Matchmaking', demo: options.demo, discordInvite: options.discordInvite,
    configured: options.configured, ranks: RANKS,
  };
  const windows = new Map<string, { count: number; until: number }>();
  app.use('/api', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.status(405).json({ error: 'O site é somente leitura. Jogue e gerencie partidas pelo Discord.' });
      return;
    }
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (windows.size > 1000) {
      for (const [address, window] of windows) if (window.until <= now) windows.delete(address);
    }
    const current = windows.get(key);
    const window = current && current.until > now ? current : { count: 0, until: now + 60_000 };
    window.count++;
    windows.set(key, window);
    if (window.count > 180) {
      response.setHeader('Retry-After', String(Math.ceil((window.until - now) / 1000)));
      response.status(429).json({ error: 'Muitas consultas. Aguarde um momento e tente novamente.' });
      return;
    }
    next();
  });

  app.get('/api/health', (_request, response) => response.json({ ok: true, demo: options.demo }));
  app.get('/api/overview', async (_request, response) => {
    const players = await service.listPlayers();
    const queue = await service.getQueue();
    const activeMatches = await service.getActiveMatches();
    const overview: Overview = {
      config,
      stats: { players: players.length, completedMatches: await service.countMatches({ status: 'completed' }), activeMatches: activeMatches.length, queued: queue.players.length },
      queue, topPlayers: players.slice(0, 10),
      recentMatches: await service.listMatches(5, { status: 'completed' }), activeMatches,
    };
    response.json(overview);
  });

  function text(value: unknown) { return typeof value === 'string' ? value.slice(0, 100) : ''; }
  function pagination(pageValue: unknown, limitValue: unknown, total: number) {
    const numericLimit = Number(limitValue);
    const limit = Number.isInteger(numericLimit) && numericLimit > 0 ? Math.min(numericLimit, 50) : 10;
    const pages = Math.max(1, Math.ceil(total / limit));
    const numericPage = Number(pageValue);
    const page = Number.isInteger(numericPage) && numericPage > 0 ? Math.min(numericPage, pages) : 1;
    return { page, pages, limit, start: (page - 1) * limit };
  }

  app.get('/api/players', async (request, response) => {
    const search = text(request.query.search).trim().toLocaleLowerCase('pt-BR');
    const position = text(request.query.position);
    const tier = text(request.query.tier);
    let players = await service.listPlayers();
    if (search) players = players.filter(player => player.robloxName.toLocaleLowerCase('pt-BR').includes(search));
    if (position && position !== 'all') players = players.filter(player => player.position === position);
    if (tier && tier !== 'all') players = players.filter(player => player.rank.tier === tier);
    const total = players.length;
    const { page, pages, limit, start } = pagination(request.query.page, request.query.limit, total);
    response.json({ players: players.slice(start, start + limit), total, page, pages });
  });

  app.get('/api/players/:id', async (request, response) => {
    if (!/^\d{1,20}$/.test(request.params.id)) { response.status(404).json({ error: 'Jogador não encontrado.' }); return; }
    const profile = await service.getProfile(request.params.id);
    if (!profile) { response.status(404).json({ error: 'Jogador não encontrado.' }); return; }
    response.json(profile);
  });

  app.get('/api/matches', async (request, response) => {
    const status = text(request.query.status);
    const mode = text(request.query.mode);
    if (status && !['all', 'active', 'completed'].includes(status)) { response.status(400).json({ error: 'Filtro de status inválido.' }); return; }
    if (mode && !['all', 'balanced', 'captains', 'random'].includes(mode)) { response.status(400).json({ error: 'Filtro de modo inválido.' }); return; }
    const filter: MatchFilter = {};
    if (status === 'completed' || status === 'active') filter.status = status;
    if (mode && mode !== 'all') filter.mode = mode as MatchMode;
    const total = await service.countMatches(filter);
    const { page, pages, limit, start } = pagination(request.query.page, request.query.limit, total);
    response.json({ matches: await service.listMatches(limit, filter, start), total, page, pages });
  });

  app.get('/api/matches/:id', async (request, response) => {
    if (!/^\d{1,10}$/.test(request.params.id)) { response.status(404).json({ error: 'Partida não encontrada.' }); return; }
    const match = await service.getMatch(Number(request.params.id));
    if (!match) { response.status(404).json({ error: 'Partida não encontrada.' }); return; }
    response.json(match);
  });

  const avatarCache = new Map<string, { bytes: Buffer; expires: number }>();
  const pendingAvatars = new Map<string, Promise<Buffer | null>>();
  app.get('/api/avatar/:id', async (request, response) => {
    const id = request.params.id;
    if (options.demo || !/^\d{1,20}$/.test(id)) { response.status(404).end(); return; }
    const cached = avatarCache.get(id);
    if (cached && cached.expires > Date.now()) {
      response.setHeader('Cache-Control', 'public, max-age=3600');
      response.type('png').send(cached.bytes);
      return;
    }
    let pending = pendingAvatars.get(id);
    if (!pending) {
      pending = options.avatar(id).catch(() => null).finally(() => pendingAvatars.delete(id));
      pendingAvatars.set(id, pending);
    }
    const bytes = await pending;
    if (!bytes) { response.status(404).end(); return; }
    if (avatarCache.size >= 200) avatarCache.delete(avatarCache.keys().next().value!);
    avatarCache.set(id, { bytes, expires: Date.now() + 3_600_000 });
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.type('png').send(bytes);
  });

  app.use('/api', (_request, response) => response.status(404).json({ error: 'Recurso não encontrado.' }));
  const distribution = resolve('dist');
  if (existsSync(resolve(distribution, 'index.html'))) {
    app.use(express.static(distribution, { index: false }));
    app.get('/{*path}', (_request, response) => response.sendFile(resolve(distribution, 'index.html')));
  }
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof DomainError) response.status(400).json({ error: error.message });
    else {
      console.error('Falha interna na API:', error instanceof Error ? error.message : 'erro desconhecido');
      response.status(500).json({ error: 'Não foi possível carregar os dados. Tente novamente.' });
    }
  });
  return app;
}

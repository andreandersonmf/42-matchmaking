import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainError } from '../src/core/engine.js';
import { RANKS } from '../src/core/ranks.js';
import type { MatchFilter, MatchMode, Overview, PublicConfig } from '../src/core/types.js';
import { service } from '../src/core/runtime.js';
import { fetchAvatar } from '../src/bot/roblox.js';
import { readPublicEnvironment } from '../src/server/config.js';

const environment = readPublicEnvironment();
const demo = process.env.DEMO_MODE === 'true';
const config: PublicConfig = {
  name: '4.2 Matchmaking', demo, discordInvite: demo ? null : environment.discordInvite,
  configured: environment.configured, ranks: RANKS,
};

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
};

const windows = new Map<string, { count: number; until: number }>();
function rateLimit(request: Request): Response | null {
  const now = Date.now();
  const key = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (windows.size > 1000) {
    for (const [address, window] of windows) if (window.until <= now) windows.delete(address);
  }
  const current = windows.get(key);
  const window = current && current.until > now ? current : { count: 0, until: now + 60_000 };
  window.count++;
  windows.set(key, window);
  if (window.count > 180) {
    return new Response(JSON.stringify({ error: 'Muitas consultas. Aguarde um momento e tente novamente.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(Math.ceil((window.until - now) / 1000)) },
    });
  }
  return null;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders, ...extra },
  });
}

function text(value: unknown) { return typeof value === 'string' ? value.slice(0, 100) : ''; }
function pagination(pageValue: unknown, limitValue: unknown, total: number) {
  const numericLimit = Number(limitValue);
  const limit = Number.isInteger(numericLimit) && numericLimit > 0 ? Math.min(numericLimit, 50) : 10;
  const pages = Math.max(1, Math.ceil(total / limit));
  const numericPage = Number(pageValue);
  const page = Number.isInteger(numericPage) && numericPage > 0 ? Math.min(numericPage, pages) : 1;
  return { page, pages, limit, start: (page - 1) * limit };
}

const avatarCache = new Map<string, { bytes: Buffer; expires: number }>();
const pendingAvatars = new Map<string, Promise<Buffer | null>>();

async function route(request: Request, pathname: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  if (pathname === '/api/health') return json({ ok: true, demo });
  if (pathname === '/api/overview') {
    const players = await service.listPlayers();
    const queue = await service.getQueue();
    const activeMatches = await service.getActiveMatches();
    const overview: Overview = {
      config,
      stats: { players: players.length, completedMatches: await service.countMatches({ status: 'completed' }), activeMatches: activeMatches.length, queued: queue.players.length },
      queue, topPlayers: players.slice(0, 10),
      recentMatches: await service.listMatches(5, { status: 'completed' }), activeMatches,
    };
    return json(overview);
  }
  if (pathname === '/api/players') {
    const search = text(query.get('search')).trim().toLocaleLowerCase('pt-BR');
    const position = text(query.get('position'));
    const tier = text(query.get('tier'));
    let players = await service.listPlayers();
    if (search) players = players.filter(player => player.robloxName.toLocaleLowerCase('pt-BR').includes(search));
    if (position && position !== 'all') players = players.filter(player => player.position === position);
    if (tier && tier !== 'all') players = players.filter(player => player.rank.tier === tier);
    const total = players.length;
    const { page, pages, limit, start } = pagination(query.get('page'), query.get('limit'), total);
    return json({ players: players.slice(start, start + limit), total, page, pages });
  }
  const playerId = pathname.match(/^\/api\/players\/(\d{1,20})$/)?.[1];
  if (pathname.startsWith('/api/players/')) {
    if (!playerId) return json({ error: 'Jogador não encontrado.' }, 404);
    const profile = await service.getProfile(playerId);
    if (!profile) return json({ error: 'Jogador não encontrado.' }, 404);
    return json(profile);
  }
  if (pathname === '/api/matches') {
    const status = text(query.get('status'));
    const mode = text(query.get('mode'));
    if (status && !['all', 'active', 'completed'].includes(status)) return json({ error: 'Filtro de status inválido.' }, 400);
    if (mode && !['all', 'balanced', 'captains', 'random'].includes(mode)) return json({ error: 'Filtro de modo inválido.' }, 400);
    const filter: MatchFilter = {};
    if (status === 'completed' || status === 'active') filter.status = status;
    if (mode && mode !== 'all') filter.mode = mode as MatchMode;
    const total = await service.countMatches(filter);
    const { page, pages, limit, start } = pagination(query.get('page'), query.get('limit'), total);
    return json({ matches: await service.listMatches(limit, filter, start), total, page, pages });
  }
  const matchId = pathname.match(/^\/api\/matches\/(\d{1,10})$/)?.[1];
  if (pathname.startsWith('/api/matches/')) {
    if (!matchId) return json({ error: 'Partida não encontrada.' }, 404);
    const match = await service.getMatch(Number(matchId));
    if (!match) return json({ error: 'Partida não encontrada.' }, 404);
    return json(match);
  }
  const avatarId = pathname.match(/^\/api\/avatar\/(\d{1,20})$/)?.[1];
  if (pathname.startsWith('/api/avatar/')) {
    if (demo || !avatarId) return new Response(null, { status: 404 });
    const cached = avatarCache.get(avatarId);
    if (cached && cached.expires > Date.now()) {
      return new Response(new Uint8Array(cached.bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', ...securityHeaders } });
    }
    let pending = pendingAvatars.get(avatarId);
    if (!pending) {
      // o bot guarda o avatar no banco; só se ainda não houver cópia tentamos o Roblox direto
      pending = service.getAvatar(avatarId).catch(() => null)
        .then(stored => stored ?? fetchAvatar(avatarId))
        .catch(() => null).finally(() => pendingAvatars.delete(avatarId));
      pendingAvatars.set(avatarId, pending);
    }
    const bytes = await pending;
    if (!bytes) return new Response(null, { status: 404 });
    if (avatarCache.size >= 200) avatarCache.delete(avatarCache.keys().next().value!);
    avatarCache.set(avatarId, { bytes, expires: Date.now() + 3_600_000 });
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', ...securityHeaders } });
  }
  return json({ error: 'Recurso não encontrado.' }, 404);
}

function toWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.append(key, value);
  }
  return new Request(url, { method: req.method ?? 'GET', headers });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

// o runtime Node da Vercel entrega (IncomingMessage, ServerResponse), não Web Request/Response
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = toWebRequest(req);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    await sendWebResponse(res, json({ error: 'O site é somente leitura. Jogue e gerencie partidas pelo Discord.' }, 405, { Allow: 'GET, HEAD' }));
    return;
  }
  const limited = rateLimit(request);
  if (limited) { await sendWebResponse(res, limited); return; }
  try {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith('/api/')) { await sendWebResponse(res, json({ error: 'Recurso não encontrado.' }, 404)); return; }
    await sendWebResponse(res, await route(request, pathname));
  } catch (error) {
    if (error instanceof DomainError) { await sendWebResponse(res, json({ error: error.message }, 400)); return; }
    console.error('Falha interna na API:', error instanceof Error ? error.message : 'erro desconhecido');
    await sendWebResponse(res, json({ error: 'Não foi possível carregar os dados. Tente novamente.' }, 500));
  }
}

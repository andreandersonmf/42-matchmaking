import { createClient, LibsqlError } from '@libsql/client';
import { LibsqlBatchError, type InStatement, type InValue, type ResultSet, type Transaction } from '@libsql/client';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateElo, rankFor, START_ELO } from './ranks.js';
import type {
  LinkChallenge, Match, MatchFilter, MatchMode, MatchPlayer, Player, Position, RankedPlayer,
  Report, ServiceContract, Team, Verdict, VipTier,
} from './types.js';
import { VERDICTS } from './types.js';

export class DomainError extends Error {
  constructor(message: string) { super(message); this.name = 'DomainError'; }
}

type StoredMatch = Match & {
  modeBallots: Record<string, MatchMode>;
  mvpBallots: Record<string, string>;
  /** Votos de capitão (eleitor -> candidato). Ausente em partidas antigas. */
  captainBallots?: Record<string, string>;
  draftIndex: number;
};
const CAPTAIN_VOTE_MS = 30_000;
const QUEUE_TTL_MS = 30 * 60_000;
const READY_MS = 2 * 60_000;
const BEFORE_GAME = ['captains', 'drafting', 'ready'];
type JsonRow = { data: string };
type DbHandle = { execute(stmt: InStatement): Promise<ResultSet> };
const MODES: MatchMode[] = ['balanced', 'captains', 'random'];
// Ordem do draft em serpente: 1 = quem pica primeiro, 2 = o outro time. São 10 picks (os 2 capitães já estão nos times).
const SNAKE = [1, 2, 2, 1, 1, 2, 2, 1, 1, 2] as const;
const PICK_SECONDS = 45_000;
const ACTIVE = "('voting','captains','drafting','ready','live','mvp')";
/** Denúncias: até 24h depois da partida, até 3 denunciantes por ticket, pelo menos 2 votos do Conselho. */
const REPORT_WINDOW_MS = 24 * 60 * 60_000;
const MAX_REPORTERS = 3;
const MIN_BALLOTS = 2;

/**
 * Monta os 12 da partida a partir da fila (em ordem de entrada): os mais antigos de cada posição entram
 * primeiro. Se faltar spiker ou setter, os últimos a entrar da posição que sobrou tomam autofill.
 */
export function pickPlayers<T extends { position: Position }>(queue: T[]): (T & { autofill: boolean })[] | null {
  if (queue.length < 12) return null;
  const spikers = queue.filter(player => player.position === 'spiker');
  const setters = queue.filter(player => player.position === 'setter');
  const spikerCount = Math.min(8, spikers.length);
  const setterCount = Math.min(4, setters.length);
  const keep = (players: T[]) => players.map(player => ({ ...player, autofill: false }));
  const fill = (players: T[], start: number, count: number, position: Position) =>
    players.slice(start, start + count).map(player => ({ ...player, position, autofill: true }));
  return [
    ...keep(spikers.slice(0, spikerCount)), ...fill(setters, setterCount, 8 - spikerCount, 'spiker'),
    ...keep(setters.slice(0, setterCount)), ...fill(spikers, spikerCount, 4 - setterCount, 'setter'),
  ];
}

/** Autofill ganha o dobro na vitória e perde só metade na derrota. */
export const autofillDelta = (delta: number): number => delta > 0 ? delta * 2 : Math.trunc(delta / 2) || 0;

/** Autofill: derrota sempre pela metade; vitória em dobro só para quem é novo (< 10 jogos) ou fraco (100+ abaixo do geral) na role. */
export const autofillGain = (delta: number, role: { elo: number; games: number }, elo: number): number =>
  delta > 0 && role.games >= 10 && role.elo > elo - 100 ? delta : autofillDelta(delta);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(message);
}

function combinations<T>(values: T[], count: number): T[][] {
  if (count === 0) return [[]];
  return values.flatMap((value, index) => combinations(values.slice(index + 1), count - 1).map(rest => [value, ...rest]));
}

function shuffle<T>(values: T[]) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = randomInt(index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function isBusy(error: unknown) {
  const code = error instanceof LibsqlError || error instanceof LibsqlBatchError ? error.code : undefined;
  return ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT'].includes(code ?? '');
}

const delay = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));

export interface ServiceOptions {
  now?: () => number;
  ownerId?: string;
  authToken?: string;
  /** Sorteio inteiro em [0, max). Padrão: crypto.randomInt. Injetável para testes determinísticos. */
  random?: (max: number) => number;
}

export class MatchmakingService implements ServiceContract {
  private readonly client: ReturnType<typeof createClient>;
  private readonly now: () => number;
  private readonly random: (max: number) => number;
  private readonly ownerId: string;
  private readonly ready: Promise<void>;
  /** Transação da chamada atual (por contexto assíncrono, nunca compartilhada entre chamadas concorrentes). */
  private readonly currentTx = new AsyncLocalStorage<Transaction>();
  // ponytail: transações em fila única; troque por controle por recurso se o volume crescer.
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(target: string, options: ServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (max => randomInt(max));
    this.ownerId = options.ownerId ?? '';
    const url = target === ':memory:' ? 'file::memory:' : target.includes('://') ? target : pathToFileURL(resolve(target)).href;
    this.client = url.startsWith('file:') ? createClient({ url }) : createClient({ url, authToken: options.authToken });
    this.ready = this.initialize();
  }

  private async initialize() {
    // PRAGMAs não persistem entre requisições no libSQL remoto; valem só para bancos locais.
    if (this.client.protocol === 'file') {
      await this.client.execute('PRAGMA journal_mode = WAL');
      await this.client.execute('PRAGMA busy_timeout = 5000');
      await this.client.execute('PRAGMA foreign_keys = ON');
    }
    // o driver prepara apenas o primeiro statement por execute(); o DDL é dividido em chamadas individuais
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS players (
        discord_id TEXT PRIMARY KEY,
        roblox_id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS links (discord_id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS role_elo (
        discord_id TEXT NOT NULL, role TEXT NOT NULL, elo INTEGER NOT NULL, games INTEGER NOT NULL,
        PRIMARY KEY (discord_id, role)
      )`,
      `CREATE TABLE IF NOT EXISTS queue (
        discord_id TEXT PRIMARY KEY REFERENCES players(discord_id),
        queued_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS matches_status ON matches(status)`,
      `CREATE TABLE IF NOT EXISTS elo_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT NOT NULL REFERENCES players(discord_id),
        match_id INTEGER REFERENCES matches(id),
        at INTEGER NOT NULL,
        elo INTEGER NOT NULL,
        delta INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS elo_player ON elo_events(discord_id, id)`,
      // Avatares do Roblox guardados pelo bot e servidos pelo site (a Vercel nem sempre consegue falar com o Roblox).
      `CREATE TABLE IF NOT EXISTS avatars (
        roblox_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        refresh_after INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
      // Tickets de denúncia: um por acusado em cada partida; denunciantes e votos ficam no JSON.
      `CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        accused_id TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (match_id, accused_id)
      )`,
    ]) await this.client.execute(statement);
  }

  close() { this.client.close(); }

  private get handle(): DbHandle {
    return this.currentTx.getStore() ?? this.client;
  }

  private async transaction<T>(action: () => Promise<T>): Promise<T> {
    await this.ready;
    if (this.currentTx.getStore()) return action();
    const attemptAll = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const tx: Transaction = await this.client.transaction('write');
        try {
          const result = await this.currentTx.run(tx, action);
          await tx.commit();
          return result;
        } catch (error) {
          await tx.rollback().catch(() => undefined);
          if (isBusy(error) && attempt < 3) { await delay(50 * (attempt + 1) ** 2); continue; }
          throw error;
        }
      }
    };
    const next = this.txQueue.then(attemptAll, attemptAll);
    this.txQueue = next.catch(() => undefined);
    return next;
  }

  private async rows<T = Record<string, unknown>>(sql: string, ...args: InValue[]): Promise<T[]> {
    await this.ready;
    return (await this.handle.execute({ sql, args })).rows as T[];
  }

  private async row<T = Record<string, unknown>>(sql: string, ...args: InValue[]): Promise<T | undefined> {
    return (await this.rows<T>(sql, ...args))[0];
  }

  private async run(sql: string, ...args: InValue[]): Promise<ResultSet> {
    await this.ready;
    return this.handle.execute({ sql, args });
  }

  /** Avatar PNG já normalizado, ou null se ainda não foi baixado. */
  async getAvatar(robloxId: string): Promise<Buffer | null> {
    const row = await this.row<{ data: string }>('SELECT data FROM avatars WHERE roblox_id=?', robloxId);
    return row && row.data ? Buffer.from(row.data, 'base64') : null;
  }

  async saveAvatar(robloxId: string, png: Buffer, refreshAfterMs: number): Promise<void> {
    const now = this.now();
    await this.run(
      'INSERT INTO avatars(roblox_id,data,updated_at,refresh_after) VALUES(?,?,?,?) ON CONFLICT(roblox_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,refresh_after=excluded.refresh_after',
      robloxId, png.toString('base64'), now, now + refreshAfterMs);
  }

  /** Falha ao baixar: mantém o avatar antigo (se houver) e só tenta de novo depois do intervalo. */
  async deferAvatar(robloxId: string, retryAfterMs: number): Promise<void> {
    const now = this.now();
    await this.run(
      "INSERT INTO avatars(roblox_id,data,updated_at,refresh_after) VALUES(?,'',?,?) ON CONFLICT(roblox_id) DO UPDATE SET refresh_after=excluded.refresh_after",
      robloxId, now, now + retryAfterMs);
  }

  /** IDs Roblox de jogadores sem avatar guardado ou com avatar vencido, os mais atrasados primeiro. */
  async avatarsToRefresh(limit: number): Promise<string[]> {
    const rows = await this.rows<{ id: string }>(
      'SELECT p.roblox_id AS id FROM players p LEFT JOIN avatars a ON a.roblox_id=p.roblox_id WHERE a.roblox_id IS NULL OR a.refresh_after<=? ORDER BY COALESCE(a.refresh_after,0),p.roblox_id LIMIT ?',
      this.now(), limit);
    return rows.map(row => String(row.id));
  }

  async seedIfEmpty(seed: () => Promise<void>) {
    await this.transaction(async () => {
      if (!await this.row('SELECT 1 FROM players LIMIT 1')) await seed();
    });
  }

  private async audit(actorId: string, action: string, details: unknown) {
    await this.run('INSERT INTO audit(actor_id,action,details,at) VALUES(?,?,?,?)',
      actorId, action, JSON.stringify(details), this.now());
  }

  private async savePlayer(player: Player) {
    await this.run('UPDATE players SET data=? WHERE discord_id=?', JSON.stringify(player), player.discordId);
  }

  private async requiredPlayer(id: string) {
    const player = await this.getPlayer(id);
    assert(player, 'Vincule sua conta Roblox com /register e /verificar antes de jogar.');
    return player;
  }

  async getPlayer(discordId: string): Promise<Player | null> {
    const row = await this.row<JsonRow>('SELECT data FROM players WHERE discord_id=?', discordId);
    if (!row) return null;
    const player = JSON.parse(row.data) as Player;
    if (player.vipExpiresAt === null || player.vipExpiresAt <= this.now()) player.vip = 'none';
    return player;
  }

  async listPlayers(): Promise<RankedPlayer[]> {
    const ids = await this.rows<{ discord_id: string }>('SELECT discord_id FROM players');
    const players = await Promise.all(ids.map(async row => (await this.getPlayer(row.discord_id))!));
    return players
      .sort((a, b) => b.elo - a.elo || b.wins - a.wins || a.joinedAt - b.joinedAt || a.discordId.localeCompare(b.discordId))
      .map((player, index) => ({ ...player, ...rankFor(player.elo), standing: index + 1 }));
  }

  async getRankedPlayer(discordId: string) {
    return (await this.listPlayers()).find(player => player.discordId === discordId) ?? null;
  }

  async getProfile(discordId: string) {
    const player = await this.getRankedPlayer(discordId);
    if (!player) return null;
    const history = await this.listMatches(20, { status: 'completed', playerId: discordId });
    const events = await this.rows<{ at: number; elo: number; delta: number; matchId: number | null }>(
      'SELECT at,elo,delta,match_id AS matchId FROM elo_events WHERE discord_id=? ORDER BY id DESC LIMIT 30', discordId);
    return { player, history, eloHistory: events.reverse() };
  }

  /** Staff verifica alguém sem o código na descrição do Roblox (o bot confere nick e ID antes). */
  async manualLink(actorId: string, discordId: string, name: string, robloxId: string, robloxName: string, position: Position): Promise<Player> {
    return this.transaction(async () => {
      const challenge = await this.beginLink(discordId, name, robloxId, robloxName, position);
      const player = await this.completeLink(discordId, challenge.code);
      await this.audit(actorId, 'player.manual_link', { discordId, robloxId, robloxName });
      return player;
    });
  }

  async beginLink(discordId: string, name: string, robloxId: string, robloxName: string, position: Position): Promise<LinkChallenge> {
    return this.transaction(async () => {
      assert(!await this.getPlayer(discordId), 'Sua conta já está vinculada. Use /posicao para mudar sua função.');
      assert(/^\d{1,20}$/.test(robloxId), 'ID Roblox inválido.');
      assert(position === 'spiker' || position === 'setter', 'Escolha Spiker ou Setter.');
      assert(name.length > 0 && name.length <= 100 && robloxName.length > 0 && robloxName.length <= 100, 'Nome de jogador inválido.');
      assert(!await this.row('SELECT discord_id FROM players WHERE roblox_id=?', robloxId), 'Esta conta Roblox já está vinculada a outro jogador.');
      const challenge: LinkChallenge = {
        discordId, name, robloxId, robloxName, position,
        code: `MM42-${randomBytes(8).toString('hex').toUpperCase()}`,
        expiresAt: this.now() + 15 * 60_000,
      };
      await this.run('INSERT INTO links(discord_id,data) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET data=excluded.data',
        discordId, JSON.stringify(challenge));
      return challenge;
    });
  }

  async getLink(discordId: string): Promise<LinkChallenge | null> {
    const row = await this.row<JsonRow>('SELECT data FROM links WHERE discord_id=?', discordId);
    return row ? JSON.parse(row.data) as LinkChallenge : null;
  }

  async completeLink(discordId: string, robloxDescription: string): Promise<Player> {
    return this.transaction(async () => {
      const link = await this.getLink(discordId);
      assert(link, 'Inicie a vinculação com /register primeiro.');
      assert(link.expiresAt > this.now(), 'O código expirou. Gere outro com /register.');
      assert(robloxDescription.includes(link.code), 'Código não encontrado na descrição Roblox. Salve a descrição e tente /verificar novamente.');
      assert(!await this.getPlayer(discordId), 'Sua conta já está vinculada.');
      assert(!await this.row('SELECT discord_id FROM players WHERE roblox_id=?', link.robloxId), 'Esta conta Roblox já está vinculada a outro jogador.');
      const player: Player = {
        discordId, name: link.name, robloxId: link.robloxId, robloxName: link.robloxName,
        position: link.position, elo: START_ELO, wins: 0, losses: 0, matches: 0, mvps: 0,
        streak: 0, bestElo: START_ELO, vip: 'none', vipExpiresAt: null, joinedAt: this.now(),
      };
      await this.run('INSERT INTO players(discord_id,roblox_id,data) VALUES(?,?,?)', discordId, link.robloxId, JSON.stringify(player));
      await this.run('DELETE FROM links WHERE discord_id=?', discordId);
      await this.audit(discordId, 'account.linked', { robloxId: link.robloxId });
      return player;
    });
  }

  private async hasActiveMatch(discordId: string) {
    return (await this.getActiveMatches()).some(match => match.players.some(player => player.discordId === discordId));
  }

  async setPosition(discordId: string, position: Position): Promise<Player> {
    return this.transaction(async () => {
      assert(position === 'spiker' || position === 'setter', 'Escolha Spiker ou Setter.');
      assert(!await this.hasActiveMatch(discordId), 'Sua posição não pode mudar durante uma partida.');
      const player = await this.requiredPlayer(discordId);
      player.position = position;
      await this.savePlayer(player);
      return player;
    });
  }

  async joinQueue(discordId: string, position?: Position) {
    return this.transaction(async () => {
      const player = await this.requiredPlayer(discordId);
      assert(!player.queueBanUntil || player.queueBanUntil <= this.now(),
        `Você está suspenso da fila pelo Conselho até <t:${Math.floor((player.queueBanUntil ?? 0) / 1000)}:f>.`);
      assert(!await this.hasActiveMatch(discordId), 'Você já participa de uma partida em andamento.');
      assert(!await this.row('SELECT discord_id FROM queue WHERE discord_id=?', discordId), 'Você já está na fila.');
      assert((await this.rows('SELECT discord_id FROM queue')).length < 12, 'A fila está cheia (12/12). Aguarde a próxima partida.');
      if (position) {
        assert(position === 'spiker' || position === 'setter', 'Escolha Spiker ou Setter.');
        player.position = position;
        await this.savePlayer(player);
      }
      await this.run('INSERT INTO queue(discord_id,queued_at) VALUES(?,?)', discordId, this.now());
      return this.getQueue();
    });
  }

  async leaveQueue(discordId: string) {
    return this.transaction(async () => {
      assert(await this.row('SELECT discord_id FROM queue WHERE discord_id=?', discordId), 'Você não está na fila.');
      await this.run('DELETE FROM queue WHERE discord_id=?', discordId);
      return this.getQueue();
    });
  }

  async getQueue() {
    const rows = await this.rows<{ discord_id: string; queued_at: number }>('SELECT discord_id,queued_at FROM queue ORDER BY queued_at,discord_id');
    const players = await Promise.all(rows.map(async row => ({ ...await this.requiredPlayer(row.discord_id), queuedAt: row.queued_at })));
    const spikers = players.filter(player => player.position === 'spiker').length;
    const setters = players.filter(player => player.position === 'setter').length;
    return { players, spikers, setters, ready: players.length >= 12 };
  }

  private async readStored(id: number) {
    const row = await this.row<JsonRow>('SELECT data FROM matches WHERE id=?', id);
    assert(row, 'Partida não encontrada.');
    return JSON.parse(row.data) as StoredMatch;
  }

  private publicMatch(match: StoredMatch): Match {
    const { modeBallots, mvpBallots, captainBallots, draftIndex, ...result } = match;
    return structuredClone({ ...result, firstPick: result.firstPick ?? null });
  }

  private async saveMatch(match: StoredMatch) {
    match.votes = { captains: 0, balanced: 0, random: 0 };
    for (const mode of Object.values(match.modeBallots)) match.votes[mode]++;
    match.modeVoters = Object.keys(match.modeBallots).length;
    match.mvpVoters = Object.keys(match.mvpBallots).length;
    for (const player of match.players) player.mvpVotes = Object.values(match.mvpBallots).filter(id => id === player.discordId).length;
    await this.run('UPDATE matches SET status=?,data=? WHERE id=?', match.status, JSON.stringify(match), match.id);
  }

  async getMatch(id: number): Promise<Match | null> {
    const row = await this.row<JsonRow>('SELECT data FROM matches WHERE id=?', id);
    return row ? this.publicMatch(JSON.parse(row.data) as StoredMatch) : null;
  }

  private matchFilter(filter: MatchFilter) {
    const clauses: string[] = [];
    const parameters: InValue[] = [];
    if (filter.status === 'active') clauses.push(`status IN ${ACTIVE}`);
    else if (filter.status === 'completed') clauses.push("status = 'completed'");
    if (filter.mode) { clauses.push("json_extract(data, '$.mode') = ?"); parameters.push(filter.mode); }
    if (filter.playerId) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(matches.data, '$.players') AS participant WHERE json_extract(participant.value, '$.discordId') = ?)");
      parameters.push(filter.playerId);
    }
    return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', parameters };
  }

  async listMatches(limit = 100, filter: MatchFilter = {}, offset = 0): Promise<Match[]> {
    const { where, parameters } = this.matchFilter(filter);
    const args: InValue[] = [...parameters, limit, offset];
    const rows = await this.rows<JsonRow>(`SELECT data FROM matches${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args);
    return rows.map(row => this.publicMatch(JSON.parse(row.data) as StoredMatch));
  }

  async countMatches(filter: MatchFilter = {}): Promise<number> {
    const { where, parameters } = this.matchFilter(filter);
    return (await this.row<{ total: number }>(`SELECT COUNT(*) AS total FROM matches${where}`, ...parameters))!.total;
  }

  async getActiveMatches(): Promise<Match[]> {
    const rows = await this.rows<JsonRow>(`SELECT data FROM matches WHERE status IN ${ACTIVE} ORDER BY id DESC`);
    return rows.map(row => this.publicMatch(JSON.parse(row.data) as StoredMatch));
  }

  async createMatch(initiatorId: string, channelId: string): Promise<Match> {
    return this.transaction(async () => {
      const queue = await this.getQueue();
      const selected = pickPlayers(queue.players);
      assert(selected, `São necessários 12 jogadores na fila. A fila tem ${queue.players.length}.`);
      const createdAt = this.now();
      const inserted = await this.run('INSERT INTO matches(status,created_at,data) VALUES(?,?,?)', 'voting', createdAt, '{}');
      const match: StoredMatch = {
        id: Number(inserted.lastInsertRowid), status: 'voting', createdAt, startedAt: null, finishedAt: null,
        initiatorId, mode: null, modeDeadline: createdAt + 30_000, mvpDeadline: null,
        draftDeadline: null, draftTurn: null, firstPick: null, winner: null, mvpId: null, channelId, messageId: null,
        votes: { captains: 0, balanced: 0, random: 0 }, modeVoters: 0, mvpVoters: 0,
        modeBallots: {}, mvpBallots: {}, draftIndex: 0, readyDeadline: createdAt + READY_MS,
        players: selected.map(player => ({
          discordId: player.discordId, name: player.name, robloxId: player.robloxId, robloxName: player.robloxName,
          elo: player.elo, position: player.position, autofill: player.autofill, vip: player.vip, team: null, isCaptain: false,
          eloDelta: null, mvpVotes: 0,
        })),
      };
      for (const player of selected) await this.run('DELETE FROM queue WHERE discord_id=?', player.discordId);
      // Sem votação de modo: os jogadores votam nos 2 capitães e eles montam os times no draft.
      this.resolveMode(match, 'captains');
      // Primeiro só a presença: a votação de capitão abre quando os 12 confirmarem.
      match.captainDeadline = null;
      await this.saveMatch(match);
      await this.audit(initiatorId, 'match.created', { matchId: match.id });
      return this.publicMatch(match);
    });
  }

  async attachMessage(id: number, channelId: string, messageId: string): Promise<void> {
    await this.transaction(async () => {
      const match = await this.readStored(id);
      match.channelId = channelId;
      match.messageId = messageId;
      await this.saveMatch(match);
    });
  }

  private assertParticipant(match: StoredMatch, discordId: string) {
    assert(match.players.some(player => player.discordId === discordId), 'Somente os 12 participantes podem votar nesta partida.');
  }

  async voteMode(id: number, discordId: string, mode: MatchMode): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(match.status === 'voting' && this.now() < match.modeDeadline, 'A votação de modo já terminou.');
      this.assertParticipant(match, discordId);
      assert(MODES.includes(mode), 'Modo de partida inválido.');
      match.modeBallots[discordId] = mode;
      if (Object.keys(match.modeBallots).length === 12) this.resolveMode(match);
      await this.saveMatch(match);
      return this.publicMatch(match);
    });
  }

  private resolveMode(match: StoredMatch, forced?: MatchMode) {
    const counts = (mode: MatchMode) => Object.values(match.modeBallots).filter(vote => vote === mode).length;
    match.mode = forced ?? [...MODES].sort((a, b) => counts(b) - counts(a))[0];
    match.draftTurn = null;
    match.draftDeadline = null;
    match.firstPick = null;
    // Em todo modo os jogadores votam nos capitães. No modo capitães o draft só começa depois disso.
    match.status = 'captains';
    match.captainBallots = {};
    match.captainDeadline = this.now() + CAPTAIN_VOTE_MS;
    if (match.mode === 'captains') return;
    const spikers = match.players.filter(player => player.position === 'spiker');
    const setters = match.players.filter(player => player.position === 'setter');
    let teamA: MatchPlayer[];
    if (match.mode === 'random') {
      teamA = [...shuffle(spikers).slice(0, 4), ...shuffle(setters).slice(0, 2)];
    } else {
      const totalElo = match.players.reduce((total, player) => total + player.elo, 0);
      let bestDifference = Infinity;
      teamA = [];
      for (const fourSpikers of combinations(spikers, 4)) {
        for (const twoSetters of combinations(setters, 2)) {
          const candidate = [...fourSpikers, ...twoSetters];
          const difference = Math.abs(2 * candidate.reduce((sum, player) => sum + player.elo, 0) - totalElo);
          if (difference < bestDifference) { bestDifference = difference; teamA = candidate; }
        }
      }
    }
    const ids = new Set(teamA.map(player => player.discordId));
    for (const player of match.players) player.team = ids.has(player.discordId) ? 'A' : 'B';
  }

  /** Mais votados viram capitães: os 2 primeiros no modo capitães, ou o primeiro de cada time nos outros modos. */
  private resolveCaptains(match: StoredMatch) {
    const ballots = Object.values(match.captainBallots ?? {});
    const tieKey = (id: string) => createHash('sha256').update(`mm42:cap:${match.id}:${id}`).digest('hex');
    const ranked = (players: MatchPlayer[]) => [...players].sort((a, b) =>
      ballots.filter(id => id === b.discordId).length - ballots.filter(id => id === a.discordId).length || tieKey(a.discordId).localeCompare(tieKey(b.discordId)));
    match.captainDeadline = null;
    if (match.mode === 'captains') {
      const [first, second] = ranked(match.players);
      first.team = 'A'; first.isCaptain = true;
      second.team = 'B'; second.isCaptain = true;
      this.startDraft(match);
      return;
    }
    for (const team of ['A', 'B'] as Team[]) ranked(match.players.filter(player => player.team === team))[0].isCaptain = true;
    match.status = 'ready';
  }

  async voteCaptain(id: number, voterId: string, candidateId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(match.status !== 'captains' || match.captainDeadline != null, 'A votação de capitão começa quando os 12 confirmarem presença.');
      assert(match.status === 'captains' && match.captainDeadline != null && this.now() < match.captainDeadline, 'A votação de capitão já terminou.');
      this.assertParticipant(match, voterId);
      const voter = match.players.find(player => player.discordId === voterId)!;
      const candidate = match.players.find(player => player.discordId === candidateId);
      assert(candidate, 'O capitão precisa ser um dos 12 jogadores desta partida.');
      assert(voter.team === null || candidate.team === voter.team, 'Vote em alguém do seu time.');
      match.captainBallots = { ...match.captainBallots, [voterId]: candidateId };
      if (Object.keys(match.captainBallots).length === 12) this.resolveCaptains(match);
      await this.saveMatch(match);
      return this.publicMatch(match);
    });
  }

  /** Passa o painel da partida para a sala privada; o resultado continua indo para o canal onde ela foi criada. */
  async moveToRoom(id: number, roomId: string): Promise<void> {
    await this.transaction(async () => {
      const match = await this.readStored(id);
      match.resultChannelId ??= match.channelId;
      match.channelId = roomId;
      match.messageId = null;
      await this.saveMatch(match);
    });
  }

  private canPick(match: StoredMatch, player: MatchPlayer) {
    if (player.team !== null || match.draftTurn === null) return false;
    const teammates = match.players.filter(candidate => candidate.team === match.draftTurn);
    const maximum = player.position === 'spiker' ? 4 : 2;
    return teammates.length < 6 && teammates.filter(candidate => candidate.position === player.position).length < maximum;
  }

  /** Ordem completa dos picks. Partidas antigas sem firstPick começavam pela equipe A. */
  private pickOrder(match: StoredMatch): Team[] {
    const first: Team = match.firstPick ?? 'A';
    const second: Team = first === 'A' ? 'B' : 'A';
    return SNAKE.map(slot => slot === 1 ? first : second);
  }

  private applyPick(match: StoredMatch, player: MatchPlayer) {
    player.team = match.draftTurn;
    match.draftIndex++;
    const order = this.pickOrder(match);
    if (match.draftIndex >= order.length) {
      match.status = 'ready';
      match.draftTurn = null;
      match.draftDeadline = null;
    } else {
      match.draftTurn = order[match.draftIndex];
      match.draftDeadline = this.now() + PICK_SECONDS;
    }
  }

  private startDraft(match: StoredMatch) {
    match.firstPick = this.random(2) === 0 ? 'A' : 'B';
    match.status = 'drafting';
    match.draftIndex = 0;
    match.draftTurn = match.firstPick;
    match.draftDeadline = this.now() + PICK_SECONDS;
  }

  async setCaptain(id: number, actorId: string, team: Team, playerId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      this.assertInitiator(match, actorId);
      assert(match.status === 'captains', 'Os capitães só podem ser escolhidos enquanto a partida aguarda essa etapa.');
      assert(team === 'A' || team === 'B', 'Escolha o time A ou B para o capitão.');
      const chosen = match.players.find(player => player.discordId === playerId);
      assert(chosen, 'O capitão precisa ser um dos 12 jogadores desta partida.');
      assert(!(chosen.isCaptain && chosen.team !== team), 'Este jogador já é capitão do outro time. Escolha outra pessoa.');
      for (const player of match.players) {
        if (player.isCaptain && player.team === team && player !== chosen) { player.isCaptain = false; player.team = null; }
      }
      chosen.team = team;
      chosen.isCaptain = true;
      const bothChosen = match.players.filter(player => player.isCaptain).length === 2;
      if (bothChosen) this.startDraft(match);
      await this.saveMatch(match);
      await this.audit(actorId, 'match.captain', { matchId: id, team, playerId, draftStarted: bothChosen, firstPick: match.firstPick });
      return this.publicMatch(match);
    });
  }

  async pick(id: number, captainId: string, playerId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(match.status === 'drafting', 'Esta partida não está em fase de picks.');
      assert(match.draftDeadline !== null && this.now() < match.draftDeadline, 'O tempo deste pick terminou. Aguarde a escolha automática.');
      const captain = match.players.find(player => player.isCaptain && player.team === match.draftTurn);
      assert(captain?.discordId === captainId, 'Somente o capitão da vez pode escolher.');
      const player = match.players.find(candidate => candidate.discordId === playerId);
      assert(player && this.canPick(match, player), 'Pick inválido. Cada equipe precisa de 4 Spikers e 2 Setters.');
      this.applyPick(match, player);
      await this.saveMatch(match);
      return this.publicMatch(match);
    });
  }

  private assertInitiator(match: StoredMatch, actorId: string) {
    assert(actorId === match.initiatorId, 'Somente a pessoa da staff que iniciou esta partida pode executar esta ação.');
  }

  async startMatch(id: number, actorId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      // Quem pode iniciar (capitão ou Match Organizer) é checado no bot, que conhece os cargos.
      assert(match.status === 'ready', 'A partida precisa ter os times definidos antes de começar.');
      const missing = match.players.filter(player => !player.ready && match.readyDeadline != null);
      assert(!missing.length, `Faltam ${missing.length} jogador(es) confirmarem presença. Troque quem saiu ou ficou inativo.`);
      for (const team of ['A', 'B']) {
        const players = match.players.filter(player => player.team === team);
        assert(players.filter(player => player.position === 'spiker').length === 4 && players.filter(player => player.position === 'setter').length === 2, 'Composição inválida: cada time deve ter 4 Spikers e 2 Setters.');
      }
      match.status = 'live';
      match.startedAt = this.now();
      await this.saveMatch(match);
      await this.audit(actorId, 'match.started', { matchId: id });
      return this.publicMatch(match);
    });
  }

  private finish(match: StoredMatch, winner: Team) {
    match.winner = winner;
    match.status = 'mvp';
    match.mvpDeadline = this.now() + 60_000;
  }

  /** Cada capitão informa o vencedor; quando os dois concordam a partida é finalizada. */
  async reportResult(id: number, captainId: string, winner: Team): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(match.status === 'live', 'Somente uma partida em andamento pode ter resultado.');
      assert(winner === 'A' || winner === 'B', 'Escolha o time A ou B como vencedor.');
      const captain = match.players.find(player => player.isCaptain && player.discordId === captainId);
      assert(captain?.team, 'Somente os capitães podem informar o resultado.');
      match.resultReports = { ...match.resultReports, [captain.team]: winner };
      if (match.resultReports.A && match.resultReports.A === match.resultReports.B) {
        this.finish(match, winner);
        await this.audit(captainId, 'match.result', { matchId: id, winner, byCaptains: true });
      }
      await this.saveMatch(match);
      return this.publicMatch(match);
    });
  }

  private openCaptainVoteIfAllReady(match: StoredMatch) {
    if (match.status === 'captains' && match.captainDeadline == null && match.players.every(player => player.ready)) {
      match.captainDeadline = this.now() + CAPTAIN_VOTE_MS;
    }
  }

  async setReady(id: number, playerId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(BEFORE_GAME.includes(match.status), 'A partida já começou ou terminou.');
      const player = match.players.find(p => p.discordId === playerId);
      assert(player && !player.left, 'Somente os jogadores desta partida podem confirmar presença.');
      player.ready = true;
      this.openCaptainVoteIfAllReady(match);
      await this.saveMatch(match);
      return this.publicMatch(match);
    });
  }

  async leaveMatch(id: number, playerId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(BEFORE_GAME.includes(match.status), 'O jogo já começou; peça à staff para cancelar se precisar.');
      const player = match.players.find(p => p.discordId === playerId);
      assert(player, 'Você não está nesta partida.');
      assert(!player.isCaptain, 'Capitão não pode sair. Peça à staff para cancelar a partida.');
      player.left = true;
      player.ready = false;
      await this.saveMatch(match);
      return this.publicMatch(match);
    });
  }

  /** Quem saiu, ou não confirmou presença no prazo, pode ser trocado por alguém da fila na mesma vaga. */
  async substitute(id: number, actorId: string, outId: string, inId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(BEFORE_GAME.includes(match.status), 'Só dá para trocar jogador antes do jogo começar.');
      const slot = match.players.find(p => p.discordId === outId);
      assert(slot, 'Esse jogador não está nesta partida.');
      assert(!slot.isCaptain, 'Capitão não pode ser trocado.');
      assert(slot.left || (!slot.ready && match.readyDeadline != null && this.now() >= match.readyDeadline),
        'Só dá para trocar quem saiu ou não confirmou presença em 2 minutos.');
      assert(await this.row('SELECT discord_id FROM queue WHERE discord_id=?', inId), 'O substituto precisa estar na fila.');
      const player = await this.requiredPlayer(inId);
      Object.assign(slot, {
        discordId: player.discordId, name: player.name, robloxId: player.robloxId, robloxName: player.robloxName,
        elo: player.elo, vip: player.vip, autofill: player.position !== slot.position, ready: true, left: false, mvpVotes: 0,
      });
      delete match.captainBallots?.[outId];
      this.openCaptainVoteIfAllReady(match);
      await this.run('DELETE FROM queue WHERE discord_id=?', inId);
      await this.saveMatch(match);
      await this.audit(actorId, 'match.substitute', { matchId: id, outId, inId });
      return this.publicMatch(match);
    });
  }

  async finishMatch(id: number, actorId: string, winner: Team): Promise<Match> {
    return this.transaction(async () => {
      // Quem pode finalizar (qualquer Match Organizer) é checado no bot, que conhece os cargos.
      const match = await this.readStored(id);
      assert(match.status === 'live', 'Somente uma partida em andamento pode ser finalizada.');
      assert(winner === 'A' || winner === 'B', 'Escolha o time A ou B como vencedor.');
      this.finish(match, winner);
      await this.saveMatch(match);
      await this.audit(actorId, 'match.result', { matchId: id, winner });
      return this.publicMatch(match);
    });
  }

  async voteMvp(id: number, voterId: string, candidateId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(match.status === 'mvp' && match.mvpDeadline !== null && this.now() < match.mvpDeadline, 'A votação de MVP já terminou.');
      this.assertParticipant(match, voterId);
      assert(match.players.some(player => player.discordId === candidateId), 'O MVP precisa ter participado desta partida.');
      assert(voterId !== candidateId, 'Você não pode votar em si mesmo para MVP.');
      match.mvpBallots[voterId] = candidateId;
      if (Object.keys(match.mvpBallots).length === 12) await this.settle(match);
      await this.saveMatch(match);
      return this.publicMatch(match);
    });
  }

  private async settle(match: StoredMatch) {
    assert(match.status === 'mvp' && match.winner !== null, 'Resultado ainda não definido.');
    const counts = match.players.map(player => ({ id: player.discordId, votes: Object.values(match.mvpBallots).filter(id => id === player.discordId).length }));
    const tieKey = (id: string) => createHash('sha256').update(`mm42:${match.id}:${id}`).digest('hex');
    counts.sort((a, b) => b.votes - a.votes || tieKey(a.id).localeCompare(tieKey(b.id)));
    match.mvpId = counts[0].votes > 0 ? counts[0].id : null;
    const average = (team: Team) => match.players.filter(player => player.team === team).reduce((sum, player) => sum + player.elo, 0) / 6;
    const averages = { A: average('A'), B: average('B') };
    for (const participant of match.players) {
      assert(participant.team !== null, 'Jogador sem equipe.');
      const player = await this.requiredPlayer(participant.discordId);
      const won = participant.team === match.winner;
      const mvp = participant.discordId === match.mvpId;
      const base = calculateElo({
        elo: player.elo, teamAverage: averages[participant.team],
        opponentAverage: averages[participant.team === 'A' ? 'B' : 'A'],
        won, mvp, vip: participant.vip, calibrating: player.matches < 5,
      }).delta;
      // Elo secreto da role jogada: decide se o autofill ganha 2x (só quem é novo ou fraco nela).
      const role = await this.row<{ elo: number; games: number }>('SELECT elo, games FROM role_elo WHERE discord_id=? AND role=?', player.discordId, participant.position)
        ?? { elo: player.elo, games: participant.position === player.position ? player.matches : 0 };
      const delta = participant.autofill ? autofillGain(base, role, player.elo) : base;
      await this.run('INSERT INTO role_elo(discord_id,role,elo,games) VALUES(?,?,?,?) ON CONFLICT(discord_id,role) DO UPDATE SET elo=excluded.elo, games=excluded.games',
        player.discordId, participant.position, Math.max(0, role.elo + delta), role.games + 1);
      player.elo += delta;
      player.bestElo = Math.max(player.bestElo, player.elo);
      player.matches++;
      player.wins += Number(won);
      player.losses += Number(!won);
      player.mvps += Number(mvp);
      player.streak = won ? player.streak + 1 : 0;
      participant.eloDelta = delta;
      await this.savePlayer(player);
      await this.run('INSERT INTO elo_events(discord_id,match_id,at,elo,delta) VALUES(?,?,?,?,?)',
        player.discordId, match.id, this.now(), player.elo, delta);
    }
    match.status = 'completed';
    match.finishedAt = this.now();
    await this.audit('system', 'match.settled', { matchId: match.id, winner: match.winner, mvpId: match.mvpId });
  }

  async cancelMatch(id: number, actorId: string): Promise<Match> {
    return this.transaction(async () => {
      const match = await this.readStored(id);
      assert(match.status !== 'completed' && match.status !== 'cancelled', 'Esta partida já foi encerrada.');
      match.status = 'cancelled';
      match.finishedAt = this.now();
      await this.saveMatch(match);
      await this.audit(actorId, 'match.cancelled', { matchId: id });
      return this.publicMatch(match);
    });
  }

  async grantVip(actorId: string, playerId: string, tier: VipTier, days: number): Promise<Player> {
    return this.transaction(async () => {
      assert(['none', 'vip', 'vip_plus'].includes(tier), 'Plano VIP inválido.');
      assert(Number.isInteger(days) && days >= 1 && days <= 365, 'Informe de 1 a 365 dias.');
      const player = await this.requiredPlayer(playerId);
      const renewFrom = player.vip === tier ? Math.max(this.now(), player.vipExpiresAt ?? 0) : this.now();
      player.vip = tier;
      player.vipExpiresAt = tier === 'none' ? null : renewFrom + days * 86_400_000;
      await this.savePlayer(player);
      await this.audit(actorId, 'vip.updated', { playerId, tier, expiresAt: player.vipExpiresAt });
      return player;
    });
  }

  async adjustElo(actorId: string, playerId: string, amount: number, reason: string): Promise<Player> {
    return this.transaction(async () => {
      assert(this.ownerId && actorId === this.ownerId, 'Somente o proprietário pode ajustar Elo.');
      assert(Number.isInteger(amount) && amount !== 0 && Math.abs(amount) <= 500, 'O ajuste deve ser um inteiro entre -500 e 500, diferente de zero.');
      assert(reason.trim().length >= 5 && reason.length <= 500, 'Registre um motivo entre 5 e 500 caracteres.');
      assert(!await this.hasActiveMatch(playerId), 'Aguarde a partida deste jogador terminar antes de ajustar o Elo.');
      const player = await this.requiredPlayer(playerId);
      const delta = Math.max(0, player.elo + amount) - player.elo;
      player.elo += delta;
      player.bestElo = Math.max(player.bestElo, player.elo);
      await this.savePlayer(player);
      await this.run('INSERT INTO elo_events(discord_id,match_id,at,elo,delta) VALUES(?,NULL,?,?,?)', playerId, this.now(), player.elo, delta);
      await this.audit(actorId, 'elo.adjusted', { playerId, requestedAmount: amount, delta, reason: reason.trim() });
      return player;
    });
  }

  async tick(): Promise<Match[]> {
    return this.transaction(async () => {
      // Vaga parada na fila por mais de 30 minutos é liberada.
      await this.run('DELETE FROM queue WHERE queued_at < ?', this.now() - QUEUE_TTL_MS);
      const rows = await this.rows<JsonRow>(`SELECT data FROM matches WHERE status IN ${ACTIVE}`);
      const changed: Match[] = [];
      for (const row of rows) {
        const match = JSON.parse(row.data) as StoredMatch;
        let updated = false;
        if (match.status === 'voting' && this.now() >= match.modeDeadline) {
          this.resolveMode(match);
          updated = true;
        } else if (match.status === 'captains' && match.captainDeadline != null && this.now() >= match.captainDeadline) {
          this.resolveCaptains(match);
          updated = true;
        } else if (match.status === 'drafting' && match.draftDeadline !== null && this.now() >= match.draftDeadline) {
          // Tempo esgotado: pick aleatório entre os jogadores que ainda cabem na composição do time da vez.
          const options = match.players.filter(player => this.canPick(match, player)).sort((a, b) => a.discordId.localeCompare(b.discordId));
          assert(options.length > 0, 'Nenhum pick válido disponível.');
          this.applyPick(match, options[this.random(options.length)]);
          updated = true;
        } else if (match.status === 'mvp' && match.mvpDeadline !== null && this.now() >= match.mvpDeadline) {
          await this.settle(match);
          updated = true;
        }
        if (updated) {
          await this.saveMatch(match);
          changed.push(this.publicMatch(match));
        }
      }
      return changed;
    });
  }

  private async readReport(id: number): Promise<Report> {
    const row = await this.row<JsonRow>('SELECT data FROM reports WHERE id=?', id);
    assert(row, 'Denúncia não encontrada.');
    return JSON.parse(row.data) as Report;
  }

  private async saveReport(report: Report) {
    await this.run('UPDATE reports SET status=?,data=? WHERE id=?', report.status, JSON.stringify(report), report.id);
  }

  private assertOpenReport(report: Report) {
    assert(report.status === 'open', report.status === 'tied'
      ? 'A votação deste caso empatou. Agora um admin decide.' : 'Este caso já foi encerrado.');
  }

  async getReport(id: number): Promise<Report | null> {
    const row = await this.row<JsonRow>('SELECT data FROM reports WHERE id=?', id);
    return row ? JSON.parse(row.data) as Report : null;
  }

  /** Abre o ticket contra o acusado nesta partida ou junta o denunciante ao ticket que já existe. */
  async openReport(matchId: number, reporterId: string, accusedId: string, reason: string): Promise<{ report: Report; created: boolean }> {
    return this.transaction(async () => {
      const match = await this.readStored(matchId);
      const played = (id: string) => match.players.some(player => player.discordId === id);
      assert(played(reporterId), 'Somente os 12 jogadores desta partida podem denunciar.');
      assert(reporterId !== accusedId, 'Você não pode denunciar a si mesmo.');
      assert(played(accusedId), 'O jogador denunciado precisa estar nesta partida.');
      assert(match.status === 'live' || match.status === 'mvp'
        || (match.status === 'completed' && match.finishedAt !== null && this.now() - match.finishedAt <= REPORT_WINDOW_MS),
        'Denúncias só podem ser abertas durante a partida ou até 24 horas depois do fim. Partidas canceladas não aceitam denúncia.');
      const text = reason.trim();
      assert(text.length >= 10 && text.length <= 500, 'Escreva o motivo com 10 a 500 caracteres.');
      const entry = { id: reporterId, reason: text, at: this.now() };
      const row = await this.row<JsonRow>('SELECT data FROM reports WHERE match_id=? AND accused_id=?', matchId, accusedId);
      if (row) {
        const report = JSON.parse(row.data) as Report;
        assert(report.status !== 'closed', 'Este jogador já foi julgado por esta partida.');
        assert(!report.reporters.some(reporter => reporter.id === reporterId), 'Você já denunciou este jogador nesta partida. Mande as provas no canal do ticket.');
        assert(report.reporters.length < MAX_REPORTERS, 'Este jogador já tem 3 denúncias nesta partida. O Conselho já está analisando o caso.');
        report.reporters.push(entry);
        await this.saveReport(report);
        await this.audit(reporterId, 'report.joined', { reportId: report.id, matchId, accusedId });
        return { report, created: false };
      }
      const inserted = await this.run('INSERT INTO reports(status,match_id,accused_id,data) VALUES(?,?,?,?)', 'open', matchId, accusedId, '{}');
      const report: Report = {
        id: Number(inserted.lastInsertRowid), status: 'open', matchId, accusedId, reporters: [entry], ballots: {},
        verdict: null, decidedBy: null, closedBy: null, channelId: null, messageId: null, createdAt: this.now(), closedAt: null,
      };
      await this.saveReport(report);
      await this.audit(reporterId, 'report.opened', { reportId: report.id, matchId, accusedId });
      return { report, created: true };
    });
  }

  async attachReport(id: number, channelId: string, messageId: string): Promise<void> {
    await this.transaction(async () => {
      const report = await this.readReport(id);
      report.channelId = channelId;
      report.messageId = messageId;
      await this.saveReport(report);
    });
  }

  /** Voto de um conselheiro; pode ser trocado enquanto o caso está aberto. Quem o bot deixa votar é decidido pelo cargo. */
  async voteReport(id: number, voterId: string, verdict: Verdict): Promise<Report> {
    return this.transaction(async () => {
      const report = await this.readReport(id);
      this.assertOpenReport(report);
      assert(VERDICTS.includes(verdict), 'Voto inválido.');
      assert(voterId !== report.accusedId && !report.reporters.some(reporter => reporter.id === voterId), 'Você é parte deste caso e não pode votar.');
      report.ballots[voterId] = verdict;
      await this.saveReport(report);
      await this.audit(voterId, 'report.voted', { reportId: id, verdict });
      return report;
    });
  }

  /** Encerra pela maioria. Empate no topo deixa o caso para um admin decidir. */
  async closeReport(id: number, actorId: string): Promise<Report> {
    return this.transaction(async () => {
      const report = await this.readReport(id);
      this.assertOpenReport(report);
      const ballots = Object.values(report.ballots);
      assert(ballots.length >= MIN_BALLOTS, 'São necessários pelo menos 2 votos do Conselho para encerrar o caso.');
      const counts = new Map<Verdict, number>();
      for (const verdict of ballots) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
      const top = Math.max(...counts.values());
      const leaders = [...counts].filter(([, votes]) => votes === top).map(([verdict]) => verdict);
      if (leaders.length > 1) {
        report.status = 'tied';
        await this.saveReport(report);
        await this.audit(actorId, 'report.tied', { reportId: id, leaders });
        return report;
      }
      await this.applyVerdict(report, leaders[0], actorId, 'council');
      return report;
    });
  }

  async decideReport(id: number, actorId: string, verdict: Verdict): Promise<Report> {
    return this.transaction(async () => {
      const report = await this.readReport(id);
      assert(report.status === 'tied', report.status === 'open' ? 'Este caso ainda está em votação no Conselho.' : 'Este caso já foi encerrado.');
      assert(VERDICTS.includes(verdict), 'Decisão inválida.');
      await this.applyVerdict(report, verdict, actorId, 'admin');
      return report;
    });
  }

  private async applyVerdict(report: Report, verdict: Verdict, actorId: string, by: 'council' | 'admin') {
    const player = await this.requiredPlayer(report.accusedId);
    const details: Record<string, unknown> = { reportId: report.id, playerId: report.accusedId, verdict, by };
    if (verdict === 'warning') {
      player.warnings = (player.warnings ?? 0) + 1;
    } else if (verdict.startsWith('elo:')) {
      // Mesma conta do ajuste manual: nunca abaixo de 0. Vale em partida ativa porque o settle relê o jogador.
      const delta = Math.max(0, player.elo - Number(verdict.slice(4))) - player.elo;
      player.elo += delta;
      await this.run('INSERT INTO elo_events(discord_id,match_id,at,elo,delta) VALUES(?,?,?,?,?)', player.discordId, report.matchId, this.now(), player.elo, delta);
      details.delta = delta;
    } else if (verdict.startsWith('susp:')) {
      player.queueBanUntil = Math.max(this.now(), player.queueBanUntil ?? 0) + Number(verdict.slice(5)) * 86_400_000;
      await this.run('DELETE FROM queue WHERE discord_id=?', player.discordId);
      details.until = player.queueBanUntil;
    }
    if (verdict !== 'innocent') await this.savePlayer(player);
    Object.assign(report, { status: 'closed', verdict, decidedBy: by, closedBy: actorId, closedAt: this.now() });
    await this.saveReport(report);
    await this.audit(actorId, by === 'admin' ? 'report.decided' : 'report.closed', details);
  }
}

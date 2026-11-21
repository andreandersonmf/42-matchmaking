export type Position = 'spiker' | 'setter';
export type VipTier = 'none' | 'vip' | 'vip_plus';
export type Team = 'A' | 'B';
export type MatchMode = 'captains' | 'balanced' | 'random';
export type MatchStatus = 'voting' | 'captains' | 'drafting' | 'ready' | 'live' | 'mvp' | 'completed' | 'cancelled';

export interface Rank {
  name: string;
  tier: string;
  min: number;
  color: string;
}

export interface Player {
  discordId: string;
  name: string;
  robloxId: string;
  robloxName: string;
  position: Position;
  elo: number;
  wins: number;
  losses: number;
  matches: number;
  mvps: number;
  streak: number;
  bestElo: number;
  vip: VipTier;
  vipExpiresAt: number | null;
  joinedAt: number;
  /** Advertências aplicadas pelo Conselho. */
  warnings?: number;
  /** Suspenso da fila até este instante (ms). */
  queueBanUntil?: number | null;
}

export interface RankedPlayer extends Player {
  rank: Rank;
  nextRank: Rank | null;
  progress: number;
  standing: number;
}

export interface MatchPlayer {
  discordId: string;
  name: string;
  robloxId: string;
  robloxName: string;
  position: Position;
  /** Jogou fora da posição escolhida na fila. Ausente em partidas antigas. */
  autofill?: boolean;
  /** Confirmou presença antes do jogo. */
  ready?: boolean;
  /** Saiu da partida antes do jogo; pode ser trocado. */
  left?: boolean;
  elo: number;
  vip: VipTier;
  team: Team | null;
  isCaptain: boolean;
  eloDelta: number | null;
  mvpVotes: number;
}

export interface Match {
  id: number;
  status: MatchStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  initiatorId: string;
  mode: MatchMode | null;
  modeDeadline: number;
  mvpDeadline: number | null;
  draftDeadline: number | null;
  draftTurn: Team | null;
  /** Equipe que fez o primeiro pick do draft (sorteada 50/50). Nulo até o draft começar. */
  firstPick: Team | null;
  players: MatchPlayer[];
  votes: Record<MatchMode, number>;
  modeVoters: number;
  mvpVoters: number;
  winner: Team | null;
  mvpId: string | null;
  channelId: string | null;
  messageId: string | null;
  /** Prazo da votação de capitão. Ausente em partidas antigas. */
  captainDeadline?: number | null;
  /** Canal público onde a partida foi criada; recebe o resultado quando o painel vai para a sala privada. */
  resultChannelId?: string | null;
  /** Vencedor informado pelo capitão de cada time. */
  resultReports?: Partial<Record<Team, Team>>;
  /** Até quando os jogadores confirmam presença; depois disso quem não confirmou pode ser trocado. */
  readyDeadline?: number | null;
}

export interface QueueEntry extends Player { queuedAt: number }
export interface QueueState {
  players: QueueEntry[];
  spikers: number;
  setters: number;
  ready: boolean;
}

export interface LinkChallenge {
  discordId: string;
  name: string;
  robloxId: string;
  robloxName: string;
  position: Position;
  code: string;
  expiresAt: number;
}

export interface PublicConfig {
  name: string;
  demo: boolean;
  discordInvite: string | null;
  configured: boolean;
  ranks: Rank[];
}

export interface Overview {
  config: PublicConfig;
  stats: { players: number; completedMatches: number; activeMatches: number; queued: number };
  queue: QueueState;
  topPlayers: RankedPlayer[];
  recentMatches: Match[];
  activeMatches: Match[];
}

export interface PlayerProfile {
  player: RankedPlayer;
  history: Match[];
  eloHistory: { at: number; elo: number; delta: number; matchId: number | null }[];
}

export interface MatchFilter {
  status?: 'active' | 'completed';
  mode?: MatchMode;
  playerId?: string;
}

export const VERDICTS = ['innocent', 'warning', 'elo:25', 'elo:50', 'elo:100', 'susp:1', 'susp:3', 'susp:7'] as const;
/** Votos de um recurso de resultado: manter o resultado publicado ou inverter o vencedor. */
export const RESULT_VERDICTS = ['keep', 'reverse'] as const;
export type Verdict = typeof VERDICTS[number] | typeof RESULT_VERDICTS[number];
export type ReportStatus = 'open' | 'tied' | 'closed';

export interface Report {
  id: number;
  /** 'result' = recurso do capitão contra o resultado publicado. Ausente em denúncias antigas (= 'player'). */
  kind?: 'player' | 'result';
  /** No recurso: o time que o capitão diz ter vencido. */
  claimedWinner?: Team;
  status: ReportStatus;
  matchId: number;
  accusedId: string;
  reporters: { id: string; reason: string; at: number }[];
  /** Conselheiro -> veredito. Fica secreto no painel até o caso fechar. */
  ballots: Record<string, Verdict>;
  verdict: Verdict | null;
  decidedBy: 'council' | 'admin' | null;
  closedBy: string | null;
  channelId: string | null;
  messageId: string | null;
  createdAt: number;
  closedAt: number | null;
}

export interface ServiceContract {
  getPlayer(discordId: string): Promise<Player | null>;
  getRankedPlayer(discordId: string): Promise<RankedPlayer | null>;
  listPlayers(): Promise<RankedPlayer[]>;
  getProfile(discordId: string): Promise<PlayerProfile | null>;
  beginLink(discordId: string, name: string, robloxId: string, robloxName: string, position: Position): Promise<LinkChallenge>;
  manualLink(actorId: string, discordId: string, name: string, robloxId: string, robloxName: string, position: Position): Promise<Player>;
  getLink(discordId: string): Promise<LinkChallenge | null>;
  completeLink(discordId: string, robloxDescription: string): Promise<Player>;
  setPosition(discordId: string, position: Position): Promise<Player>;
  joinQueue(discordId: string, position?: Position): Promise<QueueState>;
  leaveQueue(discordId: string): Promise<QueueState>;
  getQueue(): Promise<QueueState>;
  createMatch(initiatorId: string, channelId: string): Promise<Match>;
  getMatch(id: number): Promise<Match | null>;
  listMatches(limit?: number, filter?: MatchFilter, offset?: number): Promise<Match[]>;
  countMatches(filter?: MatchFilter): Promise<number>;
  getActiveMatches(): Promise<Match[]>;
  attachMessage(id: number, channelId: string, messageId: string): Promise<void>;
  voteMode(id: number, discordId: string, mode: MatchMode): Promise<Match>;
  setCaptain(id: number, actorId: string, team: Team, playerId: string): Promise<Match>;
  voteCaptain(id: number, voterId: string, candidateId: string): Promise<Match>;
  reportResult(id: number, captainId: string, winner: Team): Promise<Match>;
  setReady(id: number, playerId: string): Promise<Match>;
  leaveMatch(id: number, playerId: string): Promise<Match>;
  substitute(id: number, actorId: string, outId: string, inId: string): Promise<Match>;
  moveToRoom(id: number, roomId: string): Promise<void>;
  pick(id: number, captainId: string, playerId: string): Promise<Match>;
  startMatch(id: number, actorId: string): Promise<Match>;
  finishMatch(id: number, actorId: string, winner: Team): Promise<Match>;
  voteMvp(id: number, voterId: string, candidateId: string): Promise<Match>;
  cancelMatch(id: number, actorId: string): Promise<Match>;
  grantVip(actorId: string, playerId: string, tier: VipTier, days: number): Promise<Player>;
  adjustElo(actorId: string, playerId: string, amount: number, reason: string): Promise<Player>;
  tick(): Promise<Match[]>;
  openReport(matchId: number, reporterId: string, accusedId: string, reason: string): Promise<{ report: Report; created: boolean }>;
  openContest(matchId: number, captainId: string, reason: string): Promise<Report>;
  attachReport(id: number, channelId: string, messageId: string): Promise<void>;
  getReport(id: number): Promise<Report | null>;
  voteReport(id: number, voterId: string, verdict: Verdict): Promise<Report>;
  closeReport(id: number, actorId: string): Promise<Report>;
  decideReport(id: number, actorId: string, verdict: Verdict): Promise<Report>;
}

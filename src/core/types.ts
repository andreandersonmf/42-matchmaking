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

export interface ServiceContract {
  getPlayer(discordId: string): Promise<Player | null>;
  getRankedPlayer(discordId: string): Promise<RankedPlayer | null>;
  listPlayers(): Promise<RankedPlayer[]>;
  getProfile(discordId: string): Promise<PlayerProfile | null>;
  beginLink(discordId: string, name: string, robloxId: string, robloxName: string, position: Position): Promise<LinkChallenge>;
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
  pick(id: number, captainId: string, playerId: string): Promise<Match>;
  startMatch(id: number, actorId: string): Promise<Match>;
  finishMatch(id: number, actorId: string, winner: Team): Promise<Match>;
  voteMvp(id: number, voterId: string, candidateId: string): Promise<Match>;
  cancelMatch(id: number, actorId: string): Promise<Match>;
  grantVip(actorId: string, playerId: string, tier: VipTier, days: number): Promise<Player>;
  adjustElo(actorId: string, playerId: string, amount: number, reason: string): Promise<Player>;
  tick(): Promise<Match[]>;
}

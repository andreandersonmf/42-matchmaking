import { rankFor } from '../core/ranks.js';
import type { Match, PlayerProfile, RankedPlayer, ServiceContract } from '../core/types.js';
import type { BotEnvironment } from './env.js';
import type { MessageTransport } from './publisher.js';
import type { PanelPayload } from './presentation.js';

export const config: BotEnvironment = {
  token: 'test-only-not-a-real-token', clientId: '100000000000000001', guildId: '100000000000000002',
  staffRoleId: '100000000000000003', ownerId: '100000000000000004', matchChannelId: '100000000000000005',
};
export const initiatorId = '100000000000000006';
export const messageId = '100000000000000007';
export const playerId = (index: number) => String(200000000000000000n + BigInt(index));

export function player(index = 0): RankedPlayer {
  return {
    discordId: playerId(index), name: `Jogador ${index}`, robloxId: String(1000 + index), robloxName: `Roblox_${index}`,
    position: index % 6 < 4 ? 'spiker' : 'setter', elo: 750 + index * 10, wins: 8, losses: 2, matches: 10,
    mvps: 3, streak: 2, bestElo: 900, vip: index === 0 ? 'vip_plus' : 'none', vipExpiresAt: 2_000_000_000_000,
    joinedAt: 1_800_000_000_000, standing: index + 1, ...rankFor(750 + index * 10),
  };
}

export function match(overrides: Partial<Match> = {}): Match {
  return {
    id: 42, status: 'voting', createdAt: 1_800_000_000_000, startedAt: null, finishedAt: null,
    initiatorId, mode: null, modeDeadline: 1_800_000_030_000, mvpDeadline: null, draftDeadline: null, draftTurn: null, firstPick: null,
    players: Array.from({ length: 12 }, (_, index) => ({ ...player(index), team: null, isCaptain: false, eloDelta: null, mvpVotes: 0 })),
    votes: { balanced: 0, captains: 0, random: 0 }, modeVoters: 0, mvpVoters: 0, winner: null, mvpId: null,
    channelId: config.matchChannelId!, messageId,
    ...overrides,
  };
}

export function profile(): PlayerProfile {
  return { player: player(), history: [], eloHistory: [{ at: 1_800_000_000_000, elo: 730, delta: 30, matchId: 1 }, { at: 1_800_000_100_000, elo: 750, delta: 20, matchId: 2 }] };
}

export function serviceStub(overrides: Partial<ServiceContract> = {}): ServiceContract {
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected service call'); };
  return {
    getPlayer: async id => id === playerId(0) ? player() : null,
    getRankedPlayer: async () => player(), listPlayers: async () => [player()], getProfile: async () => profile(),
    beginLink: unsupported, manualLink: unsupported, getLink: async () => null, completeLink: unsupported, setPosition: unsupported,
    joinQueue: unsupported, leaveQueue: unsupported, getQueue: async () => ({ players: [], spikers: 0, setters: 0, ready: false }),
    createMatch: unsupported, getMatch: async () => null, listMatches: async () => [], countMatches: async () => 0, getActiveMatches: async () => [], attachMessage: unsupported,
    voteMode: unsupported, setCaptain: unsupported, voteCaptain: unsupported, reportResult: unsupported, setReady: unsupported, leaveMatch: unsupported, substitute: unsupported, moveToRoom: unsupported, pick: unsupported, startMatch: unsupported, finishMatch: unsupported, voteMvp: unsupported,
    cancelMatch: unsupported, grantVip: unsupported, adjustElo: unsupported, tick: async () => [],
    openReport: unsupported, openContest: unsupported, attachReport: unsupported, getReport: async () => null, voteReport: unsupported, closeReport: unsupported, decideReport: unsupported, ...overrides,
  };
}

export class MemoryTransport implements MessageTransport {
  sent: { channel: string; payload: PanelPayload }[] = [];
  edited: { channel: string; id: string; payload: PanelPayload }[] = [];
  async assertChannel(): Promise<void> {}
  async send(channel: string, render: () => Promise<PanelPayload>): Promise<string> {
    this.sent.push({ channel, payload: await render() });
    return String(300000000000000000n + BigInt(this.sent.length));
  }
  async edit(channel: string, id: string, render: () => Promise<PanelPayload>): Promise<void> {
    this.edited.push({ channel, id, payload: await render() });
  }
}

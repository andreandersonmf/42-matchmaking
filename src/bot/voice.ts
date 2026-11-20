import { ChannelType, OverwriteType, PermissionFlagsBits, type CategoryChannel, type Guild, type GuildBasedChannel, type OverwriteResolvable, type TextChannel, type VoiceChannel } from 'discord.js';
import type { Match, ServiceContract, Team } from '../core/types.js';

export const CATEGORY = 'Matches';
export const QUEUE_CALL = 'queue';
const MATCH_CALL = /^#\d+ · (Partida|Equipe [AB])$/;
const ROOM = /^partida-\d+$/;
const P = PermissionFlagsBits;

const code = (matchId: number) => String(matchId).padStart(4, '0');
export const callName = (matchId: number, team: Team | null): string => `#${code(matchId)} · ${team ? `Equipe ${team}` : 'Partida'}`;
export const roomName = (matchId: number): string => `partida-${code(matchId)}`;

/** Para cada jogador de partida ativa, a call onde ele deve estar; e quem pode entrar em cada call. */
export function planCalls(matches: Match[]): { targets: Map<string, string>; members: Map<string, string[]> } {
  const targets = new Map<string, string>();
  const members = new Map<string, string[]>();
  // Na votação de MVP o jogo já acabou: as calls somem e todo mundo volta para a queue.
  for (const match of matches.filter(m => m.status !== 'mvp')) {
    for (const player of match.players) {
      const name = callName(match.id, player.team);
      targets.set(player.discordId, name);
      members.set(name, [...members.get(name) ?? [], player.discordId]);
    }
  }
  return { targets, members };
}

/** Só os jogadores (e a staff) veem e entram; o bot gerencia. */
function privateOverwrites(guild: Guild, playerIds: string[], staffRoleId: string, allow: bigint[]): OverwriteResolvable[] {
  return [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: guild.client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.Connect, P.MoveMembers, P.ManageChannels, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory] },
    { id: staffRoleId, type: OverwriteType.Role, allow },
    ...playerIds.map(id => ({ id, type: OverwriteType.Member, allow })),
  ];
}

async function category(guild: Guild): Promise<CategoryChannel> {
  const found = guild.channels.cache.find((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === CATEGORY.toLowerCase());
  return found ?? await guild.channels.create({ name: CATEGORY, type: ChannelType.GuildCategory });
}

/** Sala de texto privada da partida, na categoria Matches, visível só para os 12 jogadores e a staff. */
export async function createRoom(guild: Guild, match: Match, staffRoleId: string): Promise<TextChannel> {
  return guild.channels.create({
    name: roomName(match.id), type: ChannelType.GuildText, parent: await category(guild),
    permissionOverwrites: privateOverwrites(guild, match.players.map(p => p.discordId), staffRoleId, [P.ViewChannel, P.SendMessages, P.ReadMessageHistory]),
  });
}

/**
 * Deixa a categoria Matches de acordo com as partidas ativas: cria as calls privadas que faltam (6 por time,
 * 12 na call da partida), atualiza quem pode entrar, move quem está na queue (ou numa call errada) para a call
 * certa, devolve à queue quem estava numa call que deixou de existir e apaga calls e salas de partidas encerradas.
 * Tudo é achado pelo nome; nada vai para o banco.
 */
export async function syncCalls(guild: Guild, service: ServiceContract, staffRoleId: string, report: (message: string) => void): Promise<void> {
  const parent = await category(guild);
  const voice = () => guild.channels.cache.filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice);
  let queue = voice().find(c => c.name.toLowerCase() === QUEUE_CALL);
  if (!queue) queue = await guild.channels.create({ name: QUEUE_CALL, type: ChannelType.GuildVoice, parent });
  else if (queue.parentId !== parent.id) await queue.setParent(parent, { lockPermissions: false }).catch(() => report('Não foi possível mover a call queue para a categoria Matches.'));

  const active = await service.getActiveMatches();
  const { targets, members } = planCalls(active);
  const calls = new Map(voice().filter(c => MATCH_CALL.test(c.name)).map(c => [c.name, c]));
  const voiceAllow = [P.ViewChannel, P.Connect, P.Speak];

  for (const [name, ids] of members) {
    const overwrites = privateOverwrites(guild, ids, staffRoleId, voiceAllow);
    const existing = calls.get(name);
    try {
      if (!existing) {
        calls.set(name, await guild.channels.create({ name, type: ChannelType.GuildVoice, parent, userLimit: name.endsWith('Partida') ? 12 : 6, permissionOverwrites: overwrites }));
      } else {
        const current = existing.permissionOverwrites.cache.filter(o => o.type === OverwriteType.Member && o.id !== guild.client.user.id).map(o => o.id).sort();
        if (current.join() !== [...ids].sort().join()) await existing.permissionOverwrites.set(overwrites);
      }
    } catch {
      report(`Não foi possível criar ou ajustar a call ${name}. O bot precisa da permissão Gerenciar canais.`);
    }
  }

  for (const channel of [queue, ...calls.values()]) {
    for (const member of channel.members.values()) {
      const target = targets.get(member.id);
      const destination = target ? calls.get(target) : members.has(channel.name) || channel === queue ? undefined : queue;
      if (!destination || destination.id === channel.id) continue;
      await member.voice.setChannel(destination).catch(() => report(`Não foi possível mover um jogador para ${destination.name}. O bot precisa da permissão Mover membros.`));
    }
  }

  const rooms = new Set(active.map(match => roomName(match.id)));
  const stale: GuildBasedChannel[] = [
    ...[...calls].filter(([name, channel]) => !members.has(name) && !channel.members.size).map(([, channel]) => channel),
    ...guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.parentId === parent.id && ROOM.test(c.name) && !rooms.has(c.name)).values(),
  ];
  for (const channel of stale) await channel.delete().catch(() => report(`Não foi possível apagar ${channel.name}.`));
}

/** Evita duas sincronizações ao mesmo tempo; um pedido durante a execução roda de novo ao final. */
export function callSyncer(run: () => Promise<void>): () => Promise<void> {
  let running = false;
  let again = false;
  return async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await run(); } while (again);
    } finally {
      running = false;
    }
  };
}

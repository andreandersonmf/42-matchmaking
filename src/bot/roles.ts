import type { Guild, GuildMember } from 'discord.js';
import { rankFor } from '../core/ranks.js';
import type { ServiceContract } from '../core/types.js';

export const ELO_ROLES: Record<string, string> = {
  'Bronze I': '1408818973142941815',
  'Bronze II': '1408818973142941816',
  'Bronze III': '1408818973142941817',
  'Silver I': '1408818973142941818',
  'Silver II': '1408818973167976559',
  'Silver III': '1408818973167976560',
  'Gold I': '1408818973167976561',
  'Gold II': '1408818973167976562',
  'Gold III': '1408818973167976563',
  'Gold IV': '1408818973167976564',
  'Platinum I': '1408818973167976565',
  'Platinum II': '1408818973167976566',
  'Platinum III': '1408818973167976567',
  'Platinum IV': '1408818973167976568',
  'Emerald I': '1408818973205598238',
  'Emerald II': '1408818973205598239',
  'Emerald III': '1408818973205598240',
  'Emerald IV': '1408818973205598241',
  'Diamond I': '1408818973205598242',
  'Diamond II': '1408818973205598243',
  'Diamond III': '1408818973205598244',
  'Diamond IV': '1408818973205598245',
  Master: '1408818973226565632',
  Grandmaster: '1408818973226565636',
  Challenger: '1408818973226565638',
};

const ELO_ROLE_IDS = new Set(Object.values(ELO_ROLES));

export function rankRoleId(elo: number): string {
  return ELO_ROLES[rankFor(elo).rank.name] ?? ELO_ROLES['Bronze I'];
}

export async function syncEloRoles(guild: Guild, member: GuildMember, elo: number): Promise<string | undefined> {
  const expected = rankRoleId(elo);
  const extra = member.roles.cache.filter(role => ELO_ROLE_IDS.has(role.id) && role.id !== expected);
  try {
    if (extra.size) await member.roles.remove([...extra.keys()]);
    if (!member.roles.cache.has(expected)) await member.roles.add(expected);
  } catch {
    return 'os cargos de Elo não puderam ser sincronizados agora (o cargo do bot precisa estar acima dos cargos de Elo na hierarquia)';
  }
  return undefined;
}

export async function syncAllEloRoles(service: ServiceContract, guild: Guild, report: (message: string) => void): Promise<void> {
  const players = await service.listPlayers();
  for (const player of players) {
    try {
      const member = await guild.members.fetch({ user: player.discordId, force: true });
      const warning = await syncEloRoles(guild, member, player.elo);
      if (warning) report(`Cargo de Elo pendente para ${player.robloxName}: ${warning}`);
    } catch {
      report(`Não foi possível sincronizar o cargo de Elo de ${player.robloxName}.`);
    }
  }
}

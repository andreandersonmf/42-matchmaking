import type { Guild, GuildMember } from 'discord.js';
import { rankFor } from '../core/ranks.js';
import type { ServiceContract } from '../core/types.js';

// IDs fixos; os nomes foram trocados no servidor para seguir o LoL (III/IV é a divisão mais baixa, I a mais alta).
export const ELO_ROLES: Record<string, string> = {
  'Bronze III': '1408818973142941815',
  'Bronze II': '1408818973142941816',
  'Bronze I': '1408818973142941817',
  'Silver III': '1408818973142941818',
  'Silver II': '1408818973167976559',
  'Silver I': '1408818973167976560',
  'Gold IV': '1408818973167976561',
  'Gold III': '1408818973167976562',
  'Gold II': '1408818973167976563',
  'Gold I': '1408818973167976564',
  'Platinum IV': '1408818973167976565',
  'Platinum III': '1408818973167976566',
  'Platinum II': '1408818973167976567',
  'Platinum I': '1408818973167976568',
  'Emerald IV': '1408818973205598238',
  'Emerald III': '1408818973205598239',
  'Emerald II': '1408818973205598240',
  'Emerald I': '1408818973205598241',
  'Diamond IV': '1408818973205598242',
  'Diamond III': '1408818973205598243',
  'Diamond II': '1408818973205598244',
  'Diamond I': '1408818973205598245',
  // O rank Master/Grandmaster é único; o servidor tem divisões I–IV e usa a I.
  Master: '1408818973205598246',
  Grandmaster: '1408818973226565634',
  Challenger: '1408818973226565638',
};

// Inclui as divisões II–IV de Master e Grandmaster para remover cargos antigos.
const ELO_ROLE_IDS = new Set([...Object.values(ELO_ROLES), '1408818973205598247', '1408818973226565632', '1408818973226565633', '1408818973226565635', '1408818973226565636', '1408818973226565637']);

export function rankRoleId(rankName: string): string {
  return ELO_ROLES[rankName] ?? ELO_ROLES['Bronze III'];
}

/** `rank` vem do ranking (Desafiante/Grão-Mestre dependem da posição); um número usa só a escada. */
export async function syncEloRoles(guild: Guild, member: GuildMember, rank: string | number): Promise<string | undefined> {
  const expected = rankRoleId(typeof rank === 'number' ? rankFor(rank).rank.name : rank);
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
      const warning = await syncEloRoles(guild, member, player.rank.name);
      if (warning) report(`Cargo de Elo pendente para ${player.robloxName}: ${warning}`);
    } catch {
      report(`Não foi possível sincronizar o cargo de Elo de ${player.robloxName}.`);
    }
  }
}

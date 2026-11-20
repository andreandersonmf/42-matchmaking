import { EmbedBuilder, type Client } from 'discord.js';
import type { Player } from '../core/types.js';
import type { BotEnvironment } from './env.js';
import { COLOR } from './presentation.js';
import { syncEloRoles } from './roles.js';

export const VERIFY_EMBED_TITLE = 'VERIFICAÇÃO 4.2 MATCHMAKING';

export function verifyGuideEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(VERIFY_EMBED_TITLE)
    .setDescription('Boas-vindas à comunidade **4.2 Matchmaking**! Para liberar o acesso ao servidor, vincule sua conta Roblox em menos de um minuto. O processo é feito pelo bot, sem pedir senha, cookie ou token.')
    .addFields(
      { name: '1 · Registre sua conta', value: 'Use **/register roblox:SeuUsuario posicao:spiker** (ou **setter**). O bot gera um código único e temporário para você.', inline: false },
      { name: '2 · Cole o código na descrição', value: 'Abra seu perfil no Roblox, edite o campo **Sobre (About)** e cole exatamente o código recebido. Depois, salve.', inline: false },
      { name: '3 · Confirme a verificação', value: 'Volte aqui e use **/verificar**. Se a descrição estiver correta, você recebe o cargo **Verified**, seu apelido passa a ser seu nome Roblox e o servidor inteiro é liberado.', inline: false },
    )
    .setFooter({ text: 'O código expira em 15 minutos. Dúvidas? Chame a staff.' });
}

export async function publishVerifyGuide(client: Client, channelId: string, guildId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) {
    throw new Error('Canal de verificação indisponível.');
  }
  const messages = await channel.messages.fetch({ limit: 10 });
  const existing = messages.find(message => message.author.id === client.user?.id && message.embeds.some(embed => embed.title === VERIFY_EMBED_TITLE));
  if (existing) {
    await existing.edit({ embeds: [verifyGuideEmbed()] });
    return;
  }
  await channel.send({ embeds: [verifyGuideEmbed()] });
}

export type VerificationApplier = (userId: string, player: Player) => Promise<string | undefined>;

export function verificationApplier(client: Client, config: BotEnvironment): VerificationApplier {
  return async (userId, player) => {
    const warnings: string[] = [];
    try {
      const guild = await client.guilds.fetch(config.guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      if (config.verifiedRoleId && !member.roles.cache.has(config.verifiedRoleId)) {
        try {
          await member.roles.add(config.verifiedRoleId);
        } catch {
          warnings.push('o cargo Verified não pôde ser aplicado agora');
        }
      }
      if (player.robloxName && (member.nickname ?? member.user.username) !== player.robloxName) {
        try {
          await member.setNickname(player.robloxName, 'Conta Roblox vinculada via /verificar');
        } catch {
          warnings.push('o apelido não pôde ser alterado para o nome Roblox (o bot precisa estar acima do jogador na hierarquia)');
        }
      }
      const eloWarning = await syncEloRoles(guild, member, player.elo);
      if (eloWarning) warnings.push(eloWarning);
    } catch {
      return 'A verificação foi salva, mas cargo e apelido não puderam ser aplicados agora. A staff pode sincronizar manualmente.';
    }
    return warnings.length ? `Avisos: ${warnings.join('; ')}.` : undefined;
  };
}

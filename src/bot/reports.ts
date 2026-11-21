import {
  ActionRowBuilder, ChannelType, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type Guild, type ModalSubmitInteraction, type Role, type StringSelectMenuInteraction, type TextChannel,
} from 'discord.js';
import { RESULT_VERDICTS, VERDICTS, type Report, type ServiceContract, type Verdict } from '../core/types.js';
import { BotError, requireStaff, selectedPlayer, type Actor, type ComponentAction } from './access.js';
import type { BotEnvironment } from './env.js';
import { baseEmbed, matchPresentation, NO_MENTIONS, plain, reportCode, reportPresentation, text, verdictLabel } from './presentation.js';
import { renderResult } from './result.js';
import { category, privateOverwrites } from './voice.js';

export const COUNCIL_ROLE = 'Conselho';
export const REPORT_CATEGORY = 'Denúncias';
const P = PermissionFlagsBits;
const TICKET_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

/** Acha o cargo do Conselho pelo nome ou cria. Quem recebe o cargo é escolhido pelo dono no Discord. */
export async function ensureCouncilRole(guild: Guild): Promise<Role> {
  const roles = await guild.roles.fetch();
  return roles.find(role => role.name === COUNCIL_ROLE)
    ?? guild.roles.create({ name: COUNCIL_ROLE, reason: 'Conselho que julga as denúncias do 4.2 Matchmaking' });
}

export interface ReportDependencies {
  service: ServiceContract;
  config: Pick<BotEnvironment, 'ownerId' | 'staffRoleId' | 'resultChannelId' | 'siteUrl'>;
  resolveActor(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<Actor>;
  syncRoles?: (userId: string, elo: number) => Promise<string | undefined>;
  report: (message: string) => void;
}

export type ReportAction = Extract<ComponentAction, { kind: 'report' | 'reportpick' | 'contest' | 'contestform' } | { kind: 'reportform' } | { kind: 'ticket' }>;
const ALL_VERDICTS: readonly string[] = [...VERDICTS, ...RESULT_VERDICTS];

export function createReportHandler(deps: ReportDependencies) {
  const { service, config, report } = deps;
  // Um ticket por vez: dois denunciantes ao mesmo tempo não criam dois canais.
  const locks = new Map<number, Promise<unknown>>();
  const serial = <T>(id: number, run: () => Promise<T>): Promise<T> => {
    const next = (locks.get(id) ?? Promise.resolve()).then(run, run);
    locks.set(id, next.catch(() => undefined));
    return next;
  };

  const loadMatch = async (id: number) => {
    const match = await service.getMatch(id);
    if (!match) throw new BotError('Partida não encontrada.');
    return match;
  };
  const accusedName = async (value: Report) =>
    (await service.getMatch(value.matchId))?.players.find(player => player.discordId === value.accusedId)?.robloxName ?? 'Jogador';
  const councilRole = (guild: Guild) => guild.roles.cache.find(role => role.name === COUNCIL_ROLE);

  /** Botão Denunciar: mostra só para quem clicou o menu com os outros 11 jogadores. */
  async function button(interaction: ButtonInteraction, matchId: number) {
    const match = await loadMatch(matchId);
    if (!match.players.some(player => player.discordId === interaction.user.id)) throw new BotError('Somente os 12 jogadores desta partida podem denunciar.');
    if (!['live', 'mvp', 'completed'].includes(match.status)) throw new BotError('Esta partida não aceita denúncias.');
    const others = match.players.filter(player => player.discordId !== interaction.user.id);
    await interaction.editReply({
      content: '', allowedMentions: NO_MENTIONS,
      embeds: [baseEmbed('DENUNCIAR JOGADOR', 'Escolha quem você quer denunciar. Depois escreva o motivo; as provas (prints, clipes, links) vão no canal do ticket.')],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`mm:m:${match.id}:reportpick`).setPlaceholder('Jogador denunciado').setMinValues(1).setMaxValues(1)
        .addOptions(others.map(player => ({
          label: plain(player.robloxName, 40), value: player.discordId,
          description: `${player.team ? `Equipe ${player.team} · ` : ''}${player.position === 'spiker' ? 'Spiker' : 'Setter'}${player.isCaptain ? ' · Capitão' : ''}`,
        }))))],
    });
  }

  /** Menu do jogador: abre o formulário do motivo. Roda sem deferReply, senão o Discord não aceita o modal. */
  async function pick(interaction: StringSelectMenuInteraction, matchId: number) {
    const accusedId = selectedPlayer(interaction.values);
    const match = await loadMatch(matchId);
    if (!match.players.some(player => player.discordId === accusedId)) throw new BotError('Esse jogador não está nesta partida.');
    const name = match.players.find(player => player.discordId === accusedId)!.robloxName;
    await interaction.showModal(new ModalBuilder().setCustomId(`mm:r:${match.id}:${accusedId}`).setTitle(`Denunciar ${plain(name, 30)}`)
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason')
        .setLabel('O que aconteceu?').setPlaceholder('Descreva a conduta. As provas você manda no canal do ticket.')
        .setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(500).setRequired(true))));
  }

  /** Formulário enviado: registra no motor e cria o canal (ou coloca o novo denunciante no canal que já existe). */
  async function form(interaction: ModalSubmitInteraction, matchId: number, accusedId: string) {
    const guild = interaction.guild;
    if (!guild) throw new BotError('Use a denúncia dentro do servidor.');
    const reporterId = interaction.user.id;
    const { report: opened } = await service.openReport(matchId, reporterId, accusedId, interaction.fields.getTextInputValue('reason'));
    const channelId = await serial(opened.id, async () => {
      const current = (await service.getReport(opened.id))!;
      const name = await accusedName(current);
      if (current.channelId) {
        const channel = await guild.channels.fetch(current.channelId) as TextChannel | null;
        if (!channel) throw new BotError('O canal deste ticket foi apagado. Avise a staff.');
        await channel.permissionOverwrites.create(reporterId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
        if (current.messageId) await channel.messages.edit(current.messageId, reportPresentation(current, name)).catch(() => report('Não foi possível atualizar o painel de um ticket.'));
        await channel.send({ content: `<@${reporterId}> também denunciou. Mande suas provas aqui.`, allowedMentions: { users: [reporterId] } });
        return channel.id;
      }
      const council = await ensureCouncilRole(guild);
      const channel = await guild.channels.create({
        name: `denuncia-${reportCode(current.id)}`, type: ChannelType.GuildText, parent: await category(guild, REPORT_CATEGORY),
        permissionOverwrites: privateOverwrites(guild, current.reporters.map(reporter => reporter.id), [council.id, config.staffRoleId], TICKET_ALLOW),
      });
      const panel = await channel.send(reportPresentation(current, name));
      await service.attachReport(current.id, channel.id, panel.id);
      await channel.send({
        content: `<@&${council.id}> nova denúncia contra **${text(name, 20)}**. ${current.reporters.map(reporter => `<@${reporter.id}>`).join(' ')}, mandem as provas aqui.`,
        allowedMentions: { roles: [council.id], users: current.reporters.map(reporter => reporter.id) },
      });
      return channel.id;
    }).catch(error => {
      report(`A denúncia #${opened.id} foi salva, mas o canal do ticket não pôde ser criado ou atualizado.`);
      throw error instanceof BotError ? error : new BotError('Sua denúncia foi registrada, mas o canal do ticket não pôde ser aberto agora. Avise a staff.');
    });
    await interaction.editReply({ content: '', components: [], allowedMentions: NO_MENTIONS,
      embeds: [baseEmbed('DENÚNCIA REGISTRADA', `Mande as provas (prints, clipes, links) em <#${channelId}>. O Conselho vai analisar e votar.`)] });
  }

  /** Botão Contestar resultado: só o capitão do time que perdeu; abre o formulário (sem deferReply). */
  async function contest(interaction: ButtonInteraction, matchId: number) {
    const match = await loadMatch(matchId);
    const captain = match.players.find(player => player.discordId === interaction.user.id && player.isCaptain);
    if (match.status !== 'completed' || !captain || captain.team === match.winner) throw new BotError('Somente o capitão do time que perdeu pode contestar o resultado.');
    await interaction.showModal(new ModalBuilder().setCustomId(`mm:c:${match.id}`).setTitle(`Contestar a partida #${String(match.id).padStart(4, '0')}`)
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason')
        .setLabel(`Por que a Equipe ${captain.team} venceu?`).setPlaceholder('Conte o placar real. Os prints ou clipes do placar você manda no canal do recurso.')
        .setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(500).setRequired(true))));
  }

  /** Formulário do recurso: registra e abre o canal para os dois capitães, o Conselho e a staff. */
  async function contestForm(interaction: ModalSubmitInteraction, matchId: number) {
    const guild = interaction.guild;
    if (!guild) throw new BotError('Use o recurso dentro do servidor.');
    const opened = await service.openContest(matchId, interaction.user.id, interaction.fields.getTextInputValue('reason'));
    const match = await loadMatch(matchId);
    const captains = match.players.filter(player => player.isCaptain).map(player => player.discordId);
    const channelId = await (async () => {
      const council = await ensureCouncilRole(guild);
      const channel = await guild.channels.create({
        name: `recurso-${reportCode(opened.id)}`, type: ChannelType.GuildText, parent: await category(guild, REPORT_CATEGORY),
        permissionOverwrites: privateOverwrites(guild, captains, [council.id, config.staffRoleId], TICKET_ALLOW),
      });
      const panel = await channel.send(reportPresentation(opened, ''));
      await service.attachReport(opened.id, channel.id, panel.id);
      await channel.send({
        content: `<@&${council.id}> recurso contra o resultado da partida #${String(matchId).padStart(4, '0')}. ${captains.map(id => `<@${id}>`).join(' ')}, mandem aqui os prints ou clipes do placar, de preferência com o horário da partida.`,
        allowedMentions: { roles: [council.id], users: captains },
      });
      return channel.id;
    })().catch(() => {
      report(`O recurso #${opened.id} foi salvo, mas o canal não pôde ser criado.`);
      throw new BotError('Seu recurso foi registrado, mas o canal não pôde ser aberto agora. Avise a staff.');
    });
    await interaction.editReply({ content: '', components: [], allowedMentions: NO_MENTIONS,
      embeds: [baseEmbed('RECURSO REGISTRADO', `Mande os prints ou clipes do placar em <#${channelId}>. O Conselho vai analisar e votar.`)] });
  }

  /** Votar, encerrar ou desempatar no painel do ticket. */
  async function ticket(interaction: ButtonInteraction | StringSelectMenuInteraction, reportId: number, action: 'vote' | 'close' | 'decide') {
    const guild = interaction.guild;
    if (!guild) throw new BotError('Use o painel dentro do servidor.');
    const current = await service.getReport(reportId);
    if (!current || current.messageId !== interaction.message.id) throw new BotError('Este painel de denúncia não é o atual.');
    const actor = await deps.resolveActor(interaction);
    const verdict = (): Verdict => {
      if (!interaction.isStringSelectMenu() || interaction.values.length !== 1 || !ALL_VERDICTS.includes(interaction.values[0])) throw new BotError('Escolha uma opção do menu.');
      return interaction.values[0] as Verdict;
    };
    let updated: Report;
    let confirmation: string;
    if (action === 'decide') {
      requireStaff(actor, config);
      updated = await service.decideReport(reportId, actor.id, verdict());
      confirmation = `Decisão registrada: **${verdictLabel(updated, updated.verdict!)}**.`;
    } else {
      const council = councilRole(guild);
      if (!council || !actor.roles.includes(council.id)) throw new BotError(`Somente quem tem o cargo ${COUNCIL_ROLE} pode votar e encerrar casos.`);
      if (action === 'vote') {
        updated = await service.voteReport(reportId, actor.id, verdict());
        confirmation = `Seu voto foi registrado: **${verdictLabel(updated, updated.ballots[actor.id])}**. Você pode trocar até o caso fechar.`;
      } else {
        updated = await service.closeReport(reportId, actor.id);
        confirmation = updated.status === 'tied' ? 'A votação empatou. Um admin vai decidir.' : `Caso encerrado: **${verdictLabel(updated, updated.verdict!)}**.`;
      }
    }
    const name = await accusedName(updated);
    await interaction.message.edit(reportPresentation(updated, name)).catch(() => report('Não foi possível atualizar o painel de um ticket.'));
    const channel = interaction.channel as TextChannel | null;
    if (updated.status === 'tied' && action === 'close') {
      await channel?.send({ content: `<@&${config.staffRoleId}> a votação do caso #${reportCode(updated.id)} empatou. Um admin escolhe a decisão no painel.`, allowedMentions: { roles: [config.staffRoleId] } })
        .catch(() => report('Não foi possível avisar a staff do empate.'));
    }
    if (updated.status === 'closed') await finalize(updated, name, channel, guild);
    await interaction.editReply({ content: '', components: [], allowedMentions: NO_MENTIONS, embeds: [baseEmbed('AÇÃO CONFIRMADA', confirmation)] });
  }

  async function finalize(closed: Report, name: string, channel: TextChannel | null, guild: Guild) {
    const verdict = verdictLabel(closed, closed.verdict!);
    await channel?.send({ content: `Caso encerrado. Decisão${closed.decidedBy === 'admin' ? ' do admin' : ' do Conselho'}: **${verdict}**. O canal fica arquivado.`, allowedMentions: NO_MENTIONS })
      .catch(() => undefined);
    for (const reporter of closed.reporters) {
      await channel?.permissionOverwrites.edit(reporter.id, { SendMessages: false }).catch(() => report('Não foi possível fechar o ticket para um denunciante.'));
    }
    if (closed.kind === 'result') {
      if (closed.verdict === 'reverse') await publishCorrection(closed, guild);
      return;
    }
    if (closed.verdict!.startsWith('elo:') && deps.syncRoles) {
      const player = await service.getPlayer(closed.accusedId);
      if (player) await deps.syncRoles(closed.accusedId, player.elo);
    }
    const accused = await guild.client.users.fetch(closed.accusedId).catch(() => null);
    await accused?.send({ allowedMentions: NO_MENTIONS, embeds: [baseEmbed('DECISÃO DO CONSELHO',
      `Você (**${text(name, 20)}**) foi denunciado na partida #${String(closed.matchId).padStart(4, '0')}.\nDecisão: **${verdict}**.`)] })
      .catch(() => report(`Não foi possível mandar DM com a decisão da denúncia #${closed.id}.`));
  }

  /** Recurso aceito: posta o resultado corrigido no canal de resultados e atualiza os cargos de Elo dos 12. */
  async function publishCorrection(closed: Report, guild: Guild) {
    const match = await loadMatch(closed.matchId);
    const channelId = config.resultChannelId ?? match.resultChannelId ?? match.channelId;
    try {
      const target = channelId ? await guild.channels.fetch(channelId) as TextChannel | null : null;
      if (!target) throw new Error('sem canal');
      const payload = matchPresentation(match, config.siteUrl, false);
      await target.send({ ...payload, content: `**Resultado corrigido pelo Conselho** (recurso #${reportCode(closed.id)}): a **Equipe ${match.winner}** venceu a partida #${String(match.id).padStart(4, '0')}. O Elo foi refeito.`, files: [await renderResult(match)] });
    } catch {
      report(`O resultado da partida #${match.id} foi invertido, mas a correção não pôde ser publicada no canal de resultados.`);
    }
    if (deps.syncRoles) {
      for (const participant of match.players) {
        const player = await service.getPlayer(participant.discordId);
        if (player) await deps.syncRoles(player.discordId, player.elo).catch(() => undefined);
      }
    }
  }

  return {
    pick,
    form,
    contest,
    contestForm,
    /** Botão Denunciar e controles do ticket (já com deferReply). */
    async component(interaction: ButtonInteraction | StringSelectMenuInteraction, action: ReportAction) {
      if (action.kind === 'report' && interaction.isButton()) return button(interaction, action.matchId);
      if (action.kind === 'ticket') return ticket(interaction, action.reportId, action.action);
      throw new BotError('Controle de denúncia inválido. Use o painel atualizado.');
    },
  };
}

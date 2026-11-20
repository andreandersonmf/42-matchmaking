import { AttachmentBuilder, ChannelType, MessageFlags, type Guild, type ChatInputCommandInteraction, type Client, type Interaction, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { DomainError } from '../core/engine.js';
import type { Match, Position, ServiceContract, Team, VipTier } from '../core/types.js';
import type { BotEnvironment } from './env.js';
import { BotError, errorDetail, parseCustomId, requireOwner, requireParticipant, requireStaff, safeError, selectedPlayer, type Actor } from './access.js';
import { baseEmbed, draftCandidates, NO_MENTIONS, queuePresentation, relativeTime, rolePrompt, text, vipNames } from './presentation.js';
import { createRoom } from './voice.js';
import { renderProfile } from './profile.js';
import { renderRanking } from './ranking.js';
import { getDescription, lookupUsername } from './roblox.js';
import type { MessageTransport, Publisher } from './publisher.js';
import type { VerificationApplier } from './verify.js';

type SupportedInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

const commandErrors: Record<string, string> = {
  register: 'Não foi possível iniciar o vínculo. Confira o nome Roblox e consulte /profile: a conta pode já estar vinculada. Se precisar trocar de conta, procure a staff.',
  verificar: 'Não foi possível confirmar o vínculo. Confira se o código mais recente está completo na descrição Roblox e se ainda está no prazo. Para gerar outro código, use /register.',
  posicao: 'Não foi possível alterar sua posição. Confira seu cadastro com /profile e se você está em uma partida ativa. Consulte o painel antes de tentar novamente.',
  fila: 'Não foi possível entrar na fila. Confira seu cadastro com /profile e se você já está em uma partida ativa. O painel público mostra a fila atual.',
  iniciar: 'Não foi possível formar a partida. A fila precisa de pelo menos 8 spikers e 4 setters elegíveis. Confira o painel e as permissões do bot no canal.',
  finalizar: 'Não foi possível registrar o resultado. Confira se a partida ainda está ao vivo e se você é o iniciador autorizado como staff. Consulte o painel antes de repetir a ação.',
  vip: 'Não foi possível atualizar o plano. Confira se o jogador possui uma conta verificada e se o prazo está entre 1 e 365 dias.',
  'ajustar-elo': 'Não foi possível ajustar o Elo. Confira o cadastro do jogador, o limite de -500 a 500 e o motivo. Consulte o perfil antes de repetir a ação.',
};

function position(value: string): Position {
  if (value !== 'spiker' && value !== 'setter') throw new BotError('Escolha uma posição válida: spiker ou setter.');
  return value;
}

async function matchById(service: ServiceContract, id: number): Promise<Match> {
  if (!Number.isSafeInteger(id) || id < 1) throw new BotError('Informe um número de partida válido.');
  const match = await service.getMatch(id);
  if (!match) throw new BotError('Partida não encontrada. Confira o número exibido no painel.');
  return match;
}

export interface HandlerDependencies {
  service: ServiceContract;
  config: BotEnvironment;
  publisher: Publisher;
  transport: MessageTransport;
  resolveActor(interaction: SupportedInteraction): Promise<Actor>;
  lookup?: typeof lookupUsername;
  description?: typeof getDescription;
  profile?: typeof renderProfile;
  ranking?: typeof renderRanking;
  applyVerification?: VerificationApplier;
  syncRoles?: (userId: string, elo: number) => Promise<string | undefined>;
  /** Guarda o avatar Roblox do jogador recém-vinculado para o site exibir. */
  refreshAvatar?: (robloxId: string) => Promise<unknown>;
  report?: (message: string) => void;
}

export function actorResolver(client: Client, config: BotEnvironment): HandlerDependencies['resolveActor'] {
  return async interaction => {
    const guild = await client.guilds.fetch(config.guildId);
    const member = await guild.members.fetch({ user: interaction.user.id, force: true });
    return { id: member.id, roles: [...member.roles.cache.keys()], permissions: member.permissions.bitfield };
  };
}

export function createInteractionHandler(deps: HandlerDependencies): (interaction: Interaction) => Promise<void> {
  const { service, config, publisher, transport } = deps;
  const report = deps.report ?? console.warn;
  const info = async (interaction: SupportedInteraction, title: string, body: string) => {
    await interaction.editReply({ content: '', embeds: [baseEmbed(title, body)], components: [], allowedMentions: NO_MENTIONS });
  };
  const updateQueue = async () => {
    try { await publisher.refreshQueues(); }
    catch (error) { report(`Não foi possível atualizar um painel de fila. O próximo ciclo tentará novamente.${errorDetail(error)}`); }
  };
  const updateMatch = async (id: number): Promise<string> => {
    try { await publisher.refreshMatch(id); return ''; }
    catch {
      report('A alteração foi salva, mas a mensagem da partida ainda não pôde ser atualizada.');
      return '\n\nA alteração foi salva. O painel será atualizado assim que o canal estiver disponível; não repita a ação.';
    }
  };
  const assertRegistered = async (id: string) => {
    if (!await service.getPlayer(id)) throw new BotError('Você ainda não possui uma conta verificada. Use /register roblox:seu_usuario posicao:spiker, coloque o código na descrição Roblox e execute /verificar.');
  };

  let queueOwner: string | undefined;
  /** Cria a partida com a fila atual, abre a sala privada e devolve o texto de confirmação. */
  const formMatch = async (guild: Guild | null, initiatorId: string, fallbackChannelId: string): Promise<string> => {
    const results = guild?.channels.cache.find(c => c.type === ChannelType.GuildText && c.name.toLowerCase().includes('results'));
    const match = await service.createMatch(initiatorId, results?.id ?? fallbackChannelId);
    let room = '';
    if (guild) {
      try {
        const created = await createRoom(guild, match, config.staffRoleId);
        await service.moveToRoom(match.id, created.id);
        room = ` Sala privada: <#${created.id}>.`;
      } catch {
        report('Não foi possível criar a sala privada da partida; o painel fica no canal de resultados.');
      }
    }
    const note = await updateMatch(match.id);
    await updateQueue();
    return `**Partida #${match.id}** formada com times balanceados por Elo.${room} Cada time vota no seu capitão; um capitão manda o link e inicia o jogo.${note}`;
  };

  async function command(interaction: ChatInputCommandInteraction): Promise<void> {
    const { options, user } = interaction;
    const name = interaction.commandName;
    let actor: Actor | undefined;
    if (['setup', 'iniciar', 'finalizar', 'cancelar', 'vip', 'ajustar-elo'].includes(name)) {
      actor = await deps.resolveActor(interaction);
      if (name === 'ajustar-elo') requireOwner(actor, config);
      else requireStaff(actor, config);
    }
    switch (name) {
      case 'register': {
        const pos = position(options.getString('posicao', true));
        const roblox = await (deps.lookup ?? lookupUsername)(options.getString('roblox', true));
        const challenge = await service.beginLink(user.id, user.globalName ?? user.username, roblox.id, roblox.name, pos);
        await info(interaction, 'VERIFIQUE SUA CONTA', `Conta: **${text(challenge.robloxName)}** · Posição: **${pos === 'spiker' ? 'Spiker' : 'Setter'}**\n\n1. Abra a descrição do seu perfil no Roblox.\n2. Cole este código exatamente:\n\n${text(challenge.code, 160)}\n\n3. Salve a descrição e execute **/verificar**.\n\nO código expira ${relativeTime(challenge.expiresAt)}. Nunca informe senha, cookie ou token. Após verificar, entre com **/fila** e consulte **/profile**.`);
        return;
      }
      case 'verificar': {
        const challenge = await service.getLink(user.id);
        if (!challenge) throw new BotError('Nenhuma verificação pendente. Comece com /register roblox:seu_usuario posicao:spiker.');
        const description = await (deps.description ?? getDescription)(challenge.robloxId);
        const current = await service.getLink(user.id);
        if (!current || current.code !== challenge.code || current.robloxId !== challenge.robloxId) throw new BotError('Seu código mudou durante a consulta. Use o código mais recente e execute /verificar novamente.');
        const player = await service.completeLink(user.id, description);
        const note = deps.applyVerification ? await deps.applyVerification(user.id, player) : undefined;
        void Promise.resolve(deps.refreshAvatar?.(player.robloxId)).catch(() => undefined);
        await info(interaction, 'CONTA VERIFICADA', `**${text(player.robloxName)}** foi vinculado com segurança.${note ? `\n${note}` : ''}\nEntre com **/fila**, altere a posição com **/posicao** e veja seu cartão com **/profile**.`);
        return;
      }
      case 'posicao': {
        await assertRegistered(user.id);
        const player = await service.setPosition(user.id, position(options.getString('posicao', true)));
        await updateQueue();
        await info(interaction, 'POSIÇÃO ATUALIZADA', `Sua posição principal agora é **${player.position === 'spiker' ? 'Spiker' : 'Setter'}**. Use **/fila** para jogar.`);
        return;
      }
      case 'fila':
      case 'sair': {
        await assertRegistered(user.id);
        const queue = name === 'fila' ? await service.joinQueue(user.id) : await service.leaveQueue(user.id);
        await updateQueue();
        await interaction.editReply(queuePresentation(queue, config.siteUrl));
        return;
      }
      case 'setup': {
        if (!interaction.channelId) throw new BotError('Execute /setup em um canal de texto do servidor.');
        await transport.assertChannel(interaction.channelId);
        await publisher.publishQueue(interaction.channelId);
        await info(interaction, 'PAINEL PUBLICADO', 'O painel público de fila está pronto neste canal. Ele será atualizado conforme a fila mudar. Não é necessária a permissão Administrador.');
        return;
      }
      case 'iniciar': {
        const channelId = config.matchChannelId ?? interaction.channelId;
        if (!channelId) throw new BotError('Não foi possível identificar um canal para a partida.');
        await transport.assertChannel(channelId);
        await info(interaction, 'PARTIDA CRIADA', await formMatch(interaction.guild, actor!.id, channelId));
        return;
      }
      case 'finalizar': {
        const match = await matchById(service, options.getInteger('partida', true));
        if (match.status !== 'live') throw new BotError('Somente partidas ao vivo podem ser finalizadas. Confira o estado atual no painel.');
        const winner = options.getString('vencedor', true);
        if (winner !== 'A' && winner !== 'B') throw new BotError('Informe a equipe vencedora: A ou B.');
        await service.finishMatch(match.id, actor!.id, winner as Team);
        const note = await updateMatch(match.id);
        await info(interaction, 'RESULTADO REGISTRADO', `**Partida #${match.id}** · vitória da **Equipe ${winner}**.\nA votação de MVP está aberta por até 60 segundos. O Elo será processado pela engine ao fechar a votação.${note}`);
        return;
      }
      case 'cancelar': {
        const match = await matchById(service, options.getInteger('partida', true));
        if (match.status === 'completed' || match.status === 'cancelled') throw new BotError('Esta partida já foi encerrada e não pode ser cancelada.');
        await service.cancelMatch(match.id, actor!.id);
        const note = await updateMatch(match.id);
        await updateQueue();
        await info(interaction, 'PARTIDA CANCELADA', `**Partida #${match.id}** cancelada sem registrar um resultado.${note}`);
        return;
      }
      case 'profile': {
        const target = options.getUser('usuario') ?? user;
        const profile = await service.getProfile(target.id);
        if (!profile) throw new BotError('Este jogador ainda não possui perfil verificado. Para criar o seu, use /register e /verificar.');
        const png = await (deps.profile ?? renderProfile)(profile);
        await interaction.editReply({ content: '', embeds: [], components: [], files: [new AttachmentBuilder(png, { name: `4-2-profile-${target.id}.png`, description: `Perfil competitivo de ${profile.player.robloxName}` })], allowedMentions: NO_MENTIONS });
        return;
      }
      case 'ranking': {
        const png = await (deps.ranking ?? renderRanking)(await service.listPlayers());
        await interaction.editReply({ content: '', embeds: [], components: [], files: [new AttachmentBuilder(png, { name: '4-2-ranking.png', description: 'Ranking competitivo 4.2 Matchmaking · Top 10 por Elo' })], allowedMentions: NO_MENTIONS });
        return;
      }
      case 'vip': {
        const target = options.getUser('usuario', true);
        const tier = options.getString('plano', true);
        const days = options.getInteger('dias', true);
        if (!['none', 'vip', 'vip_plus'].includes(tier) || !Number.isInteger(days) || days < 1 || days > 365) throw new BotError('Escolha um plano válido e uma duração de 1 a 365 dias.');
        const player = await service.grantVip(actor!.id, target.id, tier as VipTier, days);
        await updateQueue();
        await info(interaction, 'PLANO ATUALIZADO', `**${text(player.robloxName)}** · **${vipNames[player.vip]}**${player.vip !== 'none' ? ` · expira ${relativeTime(player.vipExpiresAt)}` : ''}.\nA alteração foi registrada pela engine.`);
        return;
      }
      case 'ajustar-elo': {
        const amount = options.getInteger('quantidade', true);
        const reason = options.getString('motivo', true).trim();
        if (!Number.isInteger(amount) || amount < -500 || amount > 500 || reason.length < 3 || reason.length > 300) throw new BotError('Use um ajuste de -500 a 500 e um motivo de 3 a 300 caracteres.');
        const player = await service.adjustElo(actor!.id, options.getUser('usuario', true).id, amount, reason);
        await updateQueue();
        const note = deps.syncRoles ? await deps.syncRoles(player.discordId, player.elo) : undefined;
        await info(interaction, 'ELO AJUSTADO', `**${text(player.robloxName)}** agora tem **${player.elo} Elo**.${note ? `\n${note}` : ''}\nVariação solicitada: **${amount >= 0 ? '+' : ''}${amount}**.\nMotivo: ${text(reason, 300)}\n\nAutor e motivo foram enviados à auditoria da engine.`);
        return;
      }
      default:
        throw new BotError('Comando não reconhecido. Peça à staff para registrar a lista atual de comandos.');
    }
  }

  async function component(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    const action = parseCustomId(interaction.customId);
    if (!action) throw new BotError('Este controle é inválido ou está desatualizado. Use o painel mais recente.');
    if (action.kind === 'queue') {
      if (!interaction.isButton()) throw new BotError('Controle de fila inválido.');
      if (action.action === 'open') {
        const actor = await deps.resolveActor(interaction);
        requireStaff(actor, config);
        if (!interaction.channelId) throw new BotError('Use o painel em um canal de texto do servidor.');
        queueOwner = actor.id;
        await publisher.publishQueue(interaction.channelId);
        await info(interaction, 'FILA ABERTA', 'O painel da fila está logo abaixo. Com 12 jogadores a partida é criada sozinha.');
        return;
      }
      if (action.action !== 'status') await assertRegistered(interaction.user.id);
      if (action.action === 'join') { await interaction.editReply(rolePrompt()); return; }
      const queue = action.action === 'status' ? await service.getQueue() : action.action === 'leave'
        ? await service.leaveQueue(interaction.user.id) : await service.joinQueue(interaction.user.id, action.action);
      if (queue.ready && (action.action === 'spiker' || action.action === 'setter')) {
        try {
          await info(interaction, 'FILA COMPLETA', await formMatch(interaction.guild, queueOwner ?? config.ownerId, interaction.channelId!));
          return;
        } catch {
          report('A fila completou, mas a partida não pôde ser criada. A staff pode usar /iniciar.');
        }
      }
      await updateQueue();
      if (action.action === 'status') await interaction.editReply(queuePresentation(queue, config.siteUrl));
      else await info(interaction, action.action === 'leave' ? 'VOCÊ SAIU DA FILA' : 'VOCÊ ESTÁ NA FILA', `**${queue.players.length}/12** na fila. Com 12 jogadores a partida começa sozinha.`);
      return;
    }
    let actor: Actor | undefined;
    if (action.kind === 'start') actor = await deps.resolveActor(interaction);
    const match = await matchById(service, action.matchId);
    if (!match.messageId || match.messageId !== interaction.message.id || match.channelId !== interaction.channelId) {
      throw new BotError('Este painel foi substituído. Use a mensagem atual da partida no canal original.');
    }
    const id = interaction.user.id;
    let confirmation: string;
    if (action.kind === 'mode') {
      if (!interaction.isButton() || match.status !== 'voting') throw new BotError('A votação de modo já terminou ou este controle está desatualizado.');
      requireParticipant(match, id);
      await service.voteMode(match.id, id, action.mode);
      confirmation = 'Seu voto de modo foi registrado. A contagem pública será atualizada, sem expor sua escolha individual.';
    } else if (action.kind === 'captain') {
      if (!interaction.isStringSelectMenu()) throw new BotError('Controle de capitão inválido. Use o painel atualizado.');
      requireParticipant(match, id);
      if (match.status !== 'captains') throw new BotError('A votação de capitão já terminou. Confira o painel atualizado.');
      await service.voteCaptain(match.id, id, selectedPlayer(interaction.values));
      confirmation = 'Seu voto de capitão foi registrado.';
    } else if (action.kind === 'win') {
      if (!interaction.isButton() || match.status !== 'live') throw new BotError('A partida não está ao vivo. Confira o painel atualizado.');
      const updated = await service.reportResult(match.id, id, action.team);
      const reports = updated.resultReports ?? {};
      confirmation = updated.status === 'mvp' ? `Resultado confirmado pelos dois capitães: **Equipe ${action.team}** venceu. A votação de MVP começou.`
        : reports.A && reports.B ? 'Os capitães marcaram vencedores diferentes. Um Match Organizer precisa usar /finalizar.'
        : 'Seu resultado foi registrado. Falta o capitão do outro time confirmar.';
    } else if (action.kind === 'pick') {
      if (!interaction.isStringSelectMenu() || match.status !== 'drafting') throw new BotError('O draft não está ativo. Use o painel atualizado.');
      const captain = match.players.find(player => player.isCaptain && player.team === match.draftTurn);
      if (captain?.discordId !== id) throw new BotError('Somente o capitão da equipe que está na vez pode escolher.');
      const candidateId = selectedPlayer(interaction.values);
      if (!draftCandidates(match).some(player => player.discordId === candidateId)) throw new BotError('Esse jogador já foi escolhido ou não cabe na composição da sua equipe. Selecione uma opção do painel atualizado.');
      await service.pick(match.id, id, candidateId);
      confirmation = 'Escolha registrada. O painel mostra a próxima etapa do draft.';
    } else if (action.kind === 'start') {
      if (!interaction.isButton()) throw new BotError('Controle de início inválido.');
      if (!match.players.some(player => player.isCaptain && player.discordId === id)) requireStaff(actor!, config);
      if (match.status !== 'ready') throw new BotError('A partida ainda não está pronta ou já começou. Confira o painel atualizado.');
      await service.startMatch(match.id, id);
      confirmation = `Partida ao vivo. Ao terminar, informe o resultado com /finalizar partida:${match.id} vencedor:A ou vencedor:B.`;
    } else {
      if (!interaction.isStringSelectMenu() || match.status !== 'mvp') throw new BotError('A votação de MVP já terminou ou ainda não foi aberta.');
      requireParticipant(match, id);
      const candidateId = selectedPlayer(interaction.values);
      if (candidateId === id) throw new BotError('Você não pode votar em si mesmo. Escolha outro participante, de qualquer equipe.');
      if (!match.players.some(player => player.discordId === candidateId)) throw new BotError('O candidato deve estar entre os 12 jogadores desta partida.');
      await service.voteMvp(match.id, id, candidateId);
      confirmation = 'Seu voto de MVP foi registrado em sigilo. Obrigado por reconhecer o destaque da partida.';
    }
    const note = await updateMatch(match.id);
    await updateQueue();
    await info(interaction, 'AÇÃO CONFIRMADA', `${confirmation}${note}`);
  }

  return async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return;
    try {
      if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
        await interaction.reply({ content: 'Este bot funciona somente no servidor configurado. Não é possível usar comandos por DM ou em outro servidor.', flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.isChatInputCommand()) await command(interaction);
      else await component(interaction);
    } catch (error) {
      if (!(error instanceof BotError || error instanceof DomainError)) report(`Erro inesperado em uma interação.${errorDetail(error)}`);
      const fallback = interaction.isChatInputCommand() ? commandErrors[interaction.commandName] : undefined;
      const payload = { content: '', embeds: [baseEmbed('NÃO FOI POSSÍVEL CONCLUIR', safeError(error, fallback))], components: [], allowedMentions: NO_MENTIONS };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        report(`Não foi possível responder a uma interação.${errorDetail(replyError)}`);
      }
    }
  };
}

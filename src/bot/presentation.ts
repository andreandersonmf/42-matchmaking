import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { rankFor } from '../core/ranks.js';
import type { Match, MatchMode, MatchPlayer, MatchStatus, QueueState, Report, Team, Verdict, VipTier } from '../core/types.js';
import { VERDICTS } from '../core/types.js';
import { safeSiteUrl } from './env.js';

export const COLOR = 0xef4053;
export const NO_MENTIONS = { parse: [] as [], repliedUser: false };
export const modeNames: Record<MatchMode, string> = { balanced: 'Equilibrado', captains: 'Capitães', random: 'Aleatório' };
export const vipNames: Record<VipTier, string> = { none: 'SEM VIP', vip: 'VIP', vip_plus: 'VIP+' };
const statusNames: Record<MatchStatus, string> = {
  voting: 'VOTAÇÃO DE MODO', captains: 'ESCOLHA DOS CAPITÃES', drafting: 'ESCOLHA DOS JOGADORES', ready: 'PRONTA PARA COMEÇAR', live: 'AO VIVO',
  mvp: 'VOTAÇÃO DE MVP', completed: 'RESULTADO FINAL', cancelled: 'CANCELADA',
};

const rankNamesPt: Record<string, string> = {
  Bronze: 'Bronze', Silver: 'Prata', Gold: 'Ouro', Platinum: 'Platina', Emerald: 'Esmeralda',
  Diamond: 'Diamante', Master: 'Mestre', Grandmaster: 'Grão-Mestre', Challenger: 'Desafiante',
};

export function rankNamePt(name: string): string {
  const [tier, numeral] = name.split(' ');
  const translated = rankNamesPt[tier] ?? tier;
  return numeral ? `${translated} ${numeral}` : translated;
}

export function plain(value: string, max = 80): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/@/g, '＠')).slice(0, max).join('');
}

export function text(value: string, max = 80): string {
  return escapeMarkdown(plain(value, max));
}

export function relativeTime(ms: number | null): string {
  return ms === null || !Number.isFinite(ms) ? 'Aguardando' : `<t:${Math.floor(ms / 1000)}:R>`;
}

export function baseEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOR).setTitle(`4.2 MATCHMAKING · ${title}`).setDescription(description)
    .setFooter({ text: '4.2 Matchmaking • 6v6 • 4 spikers + 2 setters por equipe' }).setTimestamp();
}

type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
export interface PanelPayload {
  content: string;
  embeds: EmbedBuilder[];
  components: Row[];
  files?: Buffer[];
  allowedMentions: typeof NO_MENTIONS;
}

function siteRow(siteUrl?: string): Row[] {
  const url = safeSiteUrl(siteUrl);
  return url ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir o site 4.2').setURL(url))] : [];
}

export function queuePresentation(queue: QueueState, siteUrl?: string): PanelPayload {
  const positions = (position: 'spiker' | 'setter') => {
    const players = queue.players.filter(player => player.position === position);
    const visible = players.slice(0, 10).map((player, index) => `${index + 1}. **${text(player.robloxName, 20)}** · ${player.elo} Elo${player.vip !== 'none' ? ` · ${vipNames[player.vip]}` : ''}`);
    if (players.length > 10) visible.push(`E mais ${players.length - 10} jogador(es).`);
    return visible.join('\n') || 'Nenhum jogador nesta posição.';
  };
  const embed = baseEmbed('FILA 6v6', [
    queue.ready ? '**Fila pronta.** A staff pode formar a próxima partida com /iniciar.' : '**Seu próximo jogo começa aqui.** Aguardando 12 jogadores.',
    `**${queue.players.length}/12 na fila** · Spikers **${queue.spikers}** · Setters **${queue.setters}**`,
    '',
    'Primeira vez? Use **/register roblox:seu_usuario posicao:spiker**, coloque o código na descrição Roblox e execute **/verificar**.',
    'Clique em **Entrar na fila** e escolha sua posição de prioridade. Com **12 jogadores** a partida começa sozinha. Use **/profile** e **/ranking** quando precisar.',
    'Cada equipe tem 4 spikers e 2 setters, e os mais antigos de cada posição entram primeiro. Se faltar uma posição, os últimos a entrar da outra tomam **autofill**: perdem só metade na derrota e ganham o dobro na vitória se forem novos ou fracos naquela posição.',
  ].join('\n')).addFields(
    { name: `SPIKERS · ${queue.spikers}`, value: positions('spiker'), inline: true },
    { name: `SETTERS · ${queue.setters}`, value: positions('setter'), inline: true },
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('mm:q:join').setLabel('Entrar na fila').setStyle(ButtonStyle.Danger).setDisabled(queue.players.length >= 12),
    new ButtonBuilder().setCustomId('mm:q:leave').setLabel('Sair da fila').setStyle(ButtonStyle.Secondary),
  );
  return { content: '', embeds: [embed], components: [row, ...siteRow(siteUrl)], allowedMentions: NO_MENTIONS };
}

function playerLine(player: MatchPlayer): string {
  const captain = player.isCaptain ? ' [C]' : '';
  const vip = (player.vip !== 'none' ? ` · ${vipNames[player.vip]}` : '') + (player.autofill ? ' · Autofill' : '');
  const delta = player.eloDelta === null ? '' : ` · ${player.eloDelta >= 0 ? '+' : ''}${player.eloDelta}`;
  return `**${text(player.robloxName, 20)}**${captain}${vip}\n${player.position === 'spiker' ? 'Spiker' : 'Setter'} · ${rankNamePt(rankFor(player.elo).rank.name)} · ${player.elo} Elo${delta}`;
}

export function draftCandidates(match: Match): MatchPlayer[] {
  if (match.status !== 'drafting' || !match.draftTurn) return [];
  const team = match.players.filter(player => player.team === match.draftTurn);
  return match.players.filter(player => player.team === null && team.filter(member => member.position === player.position).length < (player.position === 'spiker' ? 4 : 2));
}

/** Candidatos a capitão: todos no modo capitães (team null), ou os jogadores do time nos outros modos. */
export function captainCandidates(match: Match, team: Team | null): MatchPlayer[] {
  if (match.status !== 'captains') return [];
  return match.players.filter(player => team === null || player.team === team);
}

export function matchPresentation(match: Match, siteUrl?: string, interactive = true): PanelPayload {
  const code = String(match.id).padStart(4, '0');
  const description = [`**PARTIDA #${code}** · ${statusNames[match.status]}`, `Modo: **${match.mode ? modeNames[match.mode] : 'Em votação'}** · Responsável: ID ${match.initiatorId}`];
  const components: Row[] = [];
  if (match.status === 'voting') {
    description.push('', `Escolha o modo até ${relativeTime(match.modeDeadline)}. **${match.modeVoters}/12** votos.`,
      'Somente participantes votam. Encerra também quando todos votarem. Empate: equilibrado, capitães, aleatório.');
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(['balanced', 'captains', 'random'] as const).map(mode => new ButtonBuilder().setCustomId(`mm:m:${match.id}:mode:${mode}`)
        .setLabel(`${modeNames[mode]} · ${match.votes[mode]}`).setStyle(mode === 'balanced' ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(!interactive)),
    ));
  } else if (match.status === 'captains') {
    const teams = match.mode === 'captains' ? [null] : (['A', 'B'] as const);
    description.push('', match.mode === 'captains'
      ? '**Vote no capitão.** Os 2 mais votados viram capitães e montam os times no draft.'
      : '**Vote no capitão do seu time.** O mais votado de cada time vira capitão.',
      `Votação até ${relativeTime(match.captainDeadline ?? null)}. Sem voto, o capitão é sorteado. Os capitães iniciam o jogo e mandam o link do servidor aqui.`);
    for (const team of teams) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`mm:m:${match.id}:cap:${team ?? 'A'}`).setPlaceholder(team ? `Time ${team}: vote no capitão` : 'Vote no capitão')
          .setMinValues(1).setMaxValues(1).setDisabled(!interactive).addOptions(captainCandidates(match, team).map(player => ({
            label: plain(player.robloxName, 40), value: player.discordId,
            description: `${player.position === 'spiker' ? 'Spiker' : 'Setter'} · ${player.elo} Elo · ${rankNamePt(rankFor(player.elo).rank.name)}`,
          }))),
      ));
    }
  } else if (match.status === 'drafting') {
    const captain = match.players.find(player => player.isCaptain && player.team === match.draftTurn);
    description.push('', `Primeiro pick sorteado: **Equipe ${match.firstPick ?? '—'}**`,
      `Vez da **Equipe ${match.draftTurn ?? '—'}** · Capitão: **${captain ? text(captain.robloxName, 20) : 'Aguardando'}**`,
      `Escolha até ${relativeTime(match.draftDeadline)}. Sem escolha em 45s, a engine sorteia um jogador para a equipe.`, 'Os dois capitães escolhem por turnos (serpente); composição 4 spikers + 2 setters por equipe.');
    const candidates = draftCandidates(match);
    if (candidates.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`mm:m:${match.id}:pick`).setPlaceholder(`Capitão da equipe ${match.draftTurn}: escolha um jogador`)
        .setMinValues(1).setMaxValues(1).setDisabled(!interactive).addOptions(candidates.map(player => ({
          label: plain(player.robloxName, 40), value: player.discordId,
          description: `${player.position === 'spiker' ? 'Spiker' : 'Setter'} · ${player.elo} Elo · ${rankNamePt(rankFor(player.elo).rank.name)}`,
        }))),
    ));
  } else if (match.status === 'ready') {
    const captains = match.players.filter(player => player.isCaptain).map(player => `**${text(player.robloxName, 20)}**`).join(' e ');
    description.push('', `Equipes definidas. Capitães: ${captains || '—'}. Um capitão manda o link do servidor aqui e clica em **Iniciar jogo**.`);
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`mm:m:${match.id}:start`)
      .setLabel('Iniciar jogo · capitães').setStyle(ButtonStyle.Danger).setDisabled(!interactive)));
  } else if (match.status === 'live') {
    const reports = match.resultReports ?? {};
    const reported = (team: Team) => reports[team] ? `Equipe ${reports[team]}` : 'aguardando';
    description.push('', `Iniciada ${relativeTime(match.startedAt)}. Bom jogo!`,
      'Ao terminar, **os dois capitães** marcam o vencedor nos botões abaixo. Se discordarem, um Match Organizer usa **/finalizar**.',
      `Capitão A: ${reported('A')} · Capitão B: ${reported('B')}`, 'O resultado abre 60 segundos de votação de MVP antes do fechamento de Elo.');
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(['A', 'B'] as const).map(team => new ButtonBuilder().setCustomId(`mm:m:${match.id}:win:${team}`).setLabel(`Equipe ${team} venceu`).setStyle(ButtonStyle.Primary).setDisabled(!interactive))));
  } else if (match.status === 'mvp') {
    description.push('', `Vitória da **Equipe ${match.winner}**. Vote no destaque até ${relativeTime(match.mvpDeadline)}. **${match.mvpVoters}/12** votos.`,
      'Um candidato de qualquer equipe. Não é permitido votar em si mesmo. Zero votos: sem MVP. Empates são resolvidos pela engine.');
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`mm:m:${match.id}:mvp`).setPlaceholder('Escolha o MVP · não vote em si mesmo').setMinValues(1).setMaxValues(1).setDisabled(!interactive)
      .addOptions(match.players.map(player => ({ label: plain(player.robloxName, 40), value: player.discordId, description: `Equipe ${player.team} · ${player.position === 'spiker' ? 'Spiker' : 'Setter'}` }))),
    ));
  }
  if (match.status === 'live' || match.status === 'mvp' || match.status === 'completed') {
    // Fica ativo também na mensagem de resultado (não interativa): o prazo de 24h é conferido pela engine.
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`mm:m:${match.id}:report`)
      .setLabel('Denunciar jogador').setStyle(ButtonStyle.Secondary).setDisabled(!interactive && match.status !== 'completed')));
  }
  if (match.status === 'completed') {
    const mvp = match.players.find(player => player.discordId === match.mvpId);
    description.push('', `Vitória da **Equipe ${match.winner}** · MVP: **${mvp ? text(mvp.robloxName, 20) : 'Sem MVP'}**`,
      'Partida encerrada. Elo e estatísticas processados pela engine. Consulte seu novo cartão com **/profile**.');
  } else if (match.status === 'cancelled') {
    description.push('', 'Esta partida foi cancelada. Nenhum resultado foi contabilizado. Consulte o painel para entrar novamente na fila.');
  }
  const embed = baseEmbed(`PARTIDA #${code}`, description.join('\n'));
  if (match.players.some(player => player.team !== null)) {
    for (const team of ['A', 'B'] as const) {
      const players = match.players.filter(player => player.team === team);
      const average = players.length ? Math.round(players.reduce((sum, player) => sum + player.elo, 0) / players.length) : 0;
      embed.addFields({ name: `EQUIPE ${team} · ${players.length}/6 · ${players.filter(player => player.position === 'spiker').length}S / ${players.filter(player => player.position === 'setter').length}L · ${average} Elo`, value: players.map(playerLine).join('\n\n') || 'Aguardando jogadores.', inline: true });
    }
    const available = match.players.filter(player => player.team === null);
    if (available.length) embed.addFields({ name: `DISPONÍVEIS · ${available.length}`, value: available.map(player => `${text(player.robloxName, 20)} · ${player.position === 'spiker' ? 'Spiker' : 'Setter'} · ${player.elo} Elo`).join('\n') });
  } else {
    for (const position of ['spiker', 'setter'] as const) {
      const players = match.players.filter(player => player.position === position);
      embed.addFields({ name: `${position === 'spiker' ? 'SPIKERS' : 'SETTERS'} · ${players.length}`, value: players.map(playerLine).join('\n\n') || 'Nenhum jogador.', inline: true });
    }
  }
  embed.addFields({ name: 'COMPOSIÇÃO', value: `${match.players.length}/12 jogadores · ${match.players.filter(player => player.position === 'spiker').length} spikers + ${match.players.filter(player => player.position === 'setter').length} setters\nPor equipe: 4 spikers (S) + 2 setters (L). Capitão: [C].` });
  if (['captains', 'drafting', 'ready'].includes(match.status) && match.readyDeadline != null) {
    const waiting = match.players.filter(player => !player.ready);
    const swappable = replaceable(match);
    embed.addFields({ name: `PRESENÇA · ${12 - waiting.length}/12`, value: waiting.length
      ? `Faltam confirmar: ${waiting.map(player => `${text(player.robloxName, 20)}${player.left ? ' (saiu)' : ''}`).join(', ')}.\nQuem sair ou não confirmar ${relativeTime(match.readyDeadline)} pode ser trocado pelos capitães.`
      : 'Todos confirmaram.' });
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mm:m:${match.id}:ready`).setLabel('Pronto').setStyle(ButtonStyle.Success).setDisabled(!interactive),
      new ButtonBuilder().setCustomId(`mm:m:${match.id}:leave`).setLabel('Sair da partida').setStyle(ButtonStyle.Secondary).setDisabled(!interactive)));
    if (swappable.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`mm:m:${match.id}:sub`).setPlaceholder('Capitães: trocar jogador que saiu ou está inativo')
        .setMinValues(1).setMaxValues(1).setDisabled(!interactive).addOptions(swappable.map(player => ({
          label: plain(player.robloxName, 40), value: player.discordId, description: player.left ? 'Saiu da partida' : 'Não confirmou presença',
        })))));
  }
  return { content: '', embeds: [embed], components: [...components, ...siteRow(siteUrl)].slice(0, 5), allowedMentions: NO_MENTIONS };
}

/** Resposta privada ao clicar em Entrar na fila: a pessoa escolhe a posição de prioridade. */
export function rolePrompt(): PanelPayload {
  return {
    content: '', allowedMentions: NO_MENTIONS,
    embeds: [baseEmbed('ESCOLHA SUA POSIÇÃO', 'Qual posição você prefere jogar? Se faltar gente na outra posição, você pode tomar **autofill**: perde só metade na derrota e ganha o dobro na vitória se for novo ou fraco naquela posição.')],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('mm:q:spiker').setLabel('Spiker').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mm:q:setter').setLabel('Setter').setStyle(ButtonStyle.Danger),
    )],
  };
}

/** Mensagem fixa do canal host: só o Match Organizer abre a fila. */
export function hostPanel(): PanelPayload {
  return {
    content: '', allowedMentions: NO_MENTIONS,
    embeds: [baseEmbed('PAINEL DO MATCH ORGANIZER', 'Somente quem tem o cargo **Match Organizer** pode abrir a fila. O painel da fila aparece logo abaixo; com 12 jogadores a partida é criada sozinha, com sala e calls privadas.')],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('mm:q:open').setLabel('Abrir fila').setStyle(ButtonStyle.Success),
    )],
  };
}

/** Jogadores que podem ser trocados: saíram, ou não confirmaram presença dentro do prazo. Capitão nunca. */
export function replaceable(match: Match, now = Date.now()): MatchPlayer[] {
  return match.players.filter(player => !player.isCaptain && (player.left || (!player.ready && match.readyDeadline != null && now >= match.readyDeadline)));
}

export const verdictNames: Record<Verdict, string> = {
  innocent: 'Inocente', warning: 'Advertência', 'elo:25': 'Perder 25 de Elo', 'elo:50': 'Perder 50 de Elo', 'elo:100': 'Perder 100 de Elo',
  'susp:1': 'Suspensão da fila: 1 dia', 'susp:3': 'Suspensão da fila: 3 dias', 'susp:7': 'Suspensão da fila: 7 dias',
};

export const reportCode = (id: number): string => String(id).padStart(4, '0');

/** Painel do ticket. O voto de cada conselheiro só aparece depois que o caso sai da votação. */
export function reportPresentation(report: Report, accusedName: string): PanelPayload {
  const status = report.status === 'open' ? 'EM VOTAÇÃO' : report.status === 'tied' ? 'EMPATE · AGUARDANDO UM ADMIN' : 'ENCERRADO';
  const voters = Object.entries(report.ballots);
  const description = [
    `**DENÚNCIA #${reportCode(report.id)}** · ${status}`,
    `Acusado: <@${report.accusedId}> (**${text(accusedName, 20)}**) · Partida #${String(report.matchId).padStart(4, '0')}`,
  ];
  if (report.status === 'open') description.push('', 'Denunciantes: mandem aqui os prints, clipes e links que provam a conduta.',
    'Conselho: vote no menu abaixo. Com **2 votos ou mais**, qualquer conselheiro encerra o caso e vale a opção mais votada. Empate vai para um admin.');
  if (report.status === 'tied') description.push('', 'A votação empatou. Um admin escolhe a decisão final no menu abaixo.');
  if (report.status === 'closed' && report.verdict) description.push('', `Decisão${report.decidedBy === 'admin' ? ' do admin' : ' do Conselho'}: **${verdictNames[report.verdict]}**.`);
  const embed = baseEmbed(`DENÚNCIA #${reportCode(report.id)}`, description.join('\n')).addFields(
    { name: `DENÚNCIAS · ${report.reporters.length}/3`, value: report.reporters.map(reporter => `<@${reporter.id}>: ${text(reporter.reason, 280)}`).join('\n\n') },
    { name: `VOTOS DO CONSELHO · ${voters.length}`, value: !voters.length ? 'Nenhum voto ainda.' : report.status === 'open'
      ? `Já votaram: ${voters.map(([id]) => `<@${id}>`).join(', ')}. Os votos aparecem quando o caso fechar.`
      : voters.map(([id, verdict]) => `<@${id}>: ${verdictNames[verdict]}`).join('\n') },
  );
  const options = VERDICTS.map(verdict => ({ label: verdictNames[verdict], value: verdict }));
  const components: Row[] = [];
  if (report.status === 'open') components.push(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`mm:t:${report.id}:vote`)
      .setPlaceholder('Conselho: seu voto (pode trocar até o fechamento)').setMinValues(1).setMaxValues(1).addOptions(options)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`mm:t:${report.id}:close`)
      .setLabel('Encerrar caso').setStyle(ButtonStyle.Danger).setDisabled(voters.length < 2)));
  if (report.status === 'tied') components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`mm:t:${report.id}:decide`).setPlaceholder('Admin: decisão final').setMinValues(1).setMaxValues(1).addOptions(options)));
  return { content: '', embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

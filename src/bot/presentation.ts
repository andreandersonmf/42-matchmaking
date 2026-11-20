import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { rankFor } from '../core/ranks.js';
import type { Match, MatchMode, MatchPlayer, MatchStatus, QueueState, Team, VipTier } from '../core/types.js';
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
    queue.ready ? '**Fila pronta.** A staff pode formar a próxima partida com /iniciar.' : '**Seu próximo jogo começa aqui.** Aguardando a composição completa.',
    `**${queue.players.length} na fila** · Spikers **${queue.spikers}/8** · Setters **${queue.setters}/4**`,
    '',
    'Primeira vez? Use **/register roblox:seu_usuario posicao:spiker**, coloque o código na descrição Roblox e execute **/verificar**.',
    'Entre com **/fila** ou escolha sua posição abaixo. Use **/sair**, **/posicao**, **/profile** e **/ranking** quando precisar.',
    'A engine seleciona os mais antigos por posição. Cada equipe recebe 4 spikers e 2 setters.',
  ].join('\n')).addFields(
    { name: `SPIKERS · ${queue.spikers}`, value: positions('spiker'), inline: true },
    { name: `SETTERS · ${queue.setters}`, value: positions('setter'), inline: true },
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('mm:q:spiker').setLabel('Entrar como spiker').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mm:q:setter').setLabel('Entrar como setter').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mm:q:leave').setLabel('Sair da fila').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mm:q:status').setLabel('Ver fila').setStyle(ButtonStyle.Secondary),
  );
  return { content: '', embeds: [embed], components: [row, ...siteRow(siteUrl)], allowedMentions: NO_MENTIONS };
}

function playerLine(player: MatchPlayer): string {
  const captain = player.isCaptain ? ' [C]' : '';
  const vip = player.vip !== 'none' ? ` · ${vipNames[player.vip]}` : '';
  const delta = player.eloDelta === null ? '' : ` · ${player.eloDelta >= 0 ? '+' : ''}${player.eloDelta}`;
  return `**${text(player.robloxName, 20)}**${captain}${vip}\n${player.position === 'spiker' ? 'Spiker' : 'Setter'} · ${rankNamePt(rankFor(player.elo).rank.name)} · ${player.elo} Elo${delta}`;
}

export function draftCandidates(match: Match): MatchPlayer[] {
  if (match.status !== 'drafting' || !match.draftTurn) return [];
  const team = match.players.filter(player => player.team === match.draftTurn);
  return match.players.filter(player => player.team === null && team.filter(member => member.position === player.position).length < (player.position === 'spiker' ? 4 : 2));
}

export function captainCandidates(match: Match, team: Team): MatchPlayer[] {
  if (match.status !== 'captains') return [];
  const other = match.players.find(player => player.isCaptain && player.team !== team);
  return match.players.filter(player => player.discordId !== other?.discordId);
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
    const captainOf = (team: Team) => match.players.find(player => player.isCaptain && player.team === team);
    const label = (team: Team) => { const captain = captainOf(team); return captain ? `**${text(captain.robloxName, 20)}**` : 'aguardando a staff'; };
    description.push('', '**A staff escolhe os capitães.** Selecione um capitão para o **Time A** e outro para o **Time B** nos menus abaixo.',
      `Capitão do Time A: ${label('A')} · Capitão do Time B: ${label('B')}`,
      'Assim que os dois estiverem definidos, o draft começa. O primeiro pick é sorteado: 50% de chance para cada time. Cada pick tem 45s; sem escolha, o jogador é sorteado.');
    for (const team of ['A', 'B'] as const) {
      const chosen = captainOf(team);
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`mm:m:${match.id}:cap:${team}`).setPlaceholder(chosen ? `Capitão do Time ${team}: ${plain(chosen.robloxName, 40)} · trocar` : `Staff: escolha o capitão do Time ${team}`)
          .setMinValues(1).setMaxValues(1).setDisabled(!interactive).addOptions(captainCandidates(match, team).map(player => ({
            label: plain(player.robloxName, 40), value: player.discordId, default: chosen?.discordId === player.discordId,
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
    description.push('', 'Equipes definidas. Somente o iniciador, ainda autorizado como staff, pode colocar a partida ao vivo.');
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`mm:m:${match.id}:start`)
      .setLabel('Iniciar jogo · somente iniciador').setStyle(ButtonStyle.Danger).setDisabled(!interactive)));
  } else if (match.status === 'live') {
    description.push('', `Iniciada ${relativeTime(match.startedAt)}. Bom jogo!`, `Ao terminar, o iniciador deve usar **/finalizar partida:${match.id} vencedor:A** ou **vencedor:B**.`, 'O resultado abre 60 segundos de votação de MVP antes do fechamento de Elo.');
  } else if (match.status === 'mvp') {
    description.push('', `Vitória da **Equipe ${match.winner}**. Vote no destaque até ${relativeTime(match.mvpDeadline)}. **${match.mvpVoters}/12** votos.`,
      'Um candidato de qualquer equipe. Não é permitido votar em si mesmo. Zero votos: sem MVP. Empates são resolvidos pela engine.');
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`mm:m:${match.id}:mvp`).setPlaceholder('Escolha o MVP · não vote em si mesmo').setMinValues(1).setMaxValues(1).setDisabled(!interactive)
      .addOptions(match.players.map(player => ({ label: plain(player.robloxName, 40), value: player.discordId, description: `Equipe ${player.team} · ${player.position === 'spiker' ? 'Spiker' : 'Setter'}` }))),
    ));
  } else if (match.status === 'completed') {
    const mvp = match.players.find(player => player.discordId === match.mvpId);
    description.push('', `Vitória da **Equipe ${match.winner}** · MVP: **${mvp ? text(mvp.robloxName, 20) : 'Sem MVP'}**`,
      'Partida encerrada. Elo e estatísticas processados pela engine. Consulte seu novo cartão com **/profile**.');
  } else {
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
  return { content: '', embeds: [embed], components: [...components, ...siteRow(siteUrl)], allowedMentions: NO_MENTIONS };
}

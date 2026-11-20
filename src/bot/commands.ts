import { SlashCommandBuilder } from 'discord.js';

const command = (name: string, description: string) => new SlashCommandBuilder()
  .setName(name).setDescription(description).setDMPermission(false);

export const commands = [
  command('register', 'Vincule sua conta Roblox ao 4.2 Matchmaking.')
    .addStringOption(o => o.setName('roblox').setDescription('Nome de usuário Roblox, não o nome de exibição.').setRequired(true).setMinLength(3).setMaxLength(20))
    .addStringOption(o => o.setName('posicao').setDescription('Sua posição principal.').setRequired(true).addChoices({ name: 'Spiker', value: 'spiker' }, { name: 'Setter', value: 'setter' })),
  command('verificar', 'Confirme o código colocado na descrição do seu perfil Roblox.'),
  command('posicao', 'Altere sua posição principal.')
    .addStringOption(o => o.setName('posicao').setDescription('Sua posição principal.').setRequired(true).addChoices({ name: 'Spiker', value: 'spiker' }, { name: 'Setter', value: 'setter' })),
  command('fila', 'Entre na fila 6v6 usando sua posição principal.'),
  command('sair', 'Saia da fila de matchmaking.'),
  command('setup', 'Staff: publique o painel de fila neste canal.'),
  command('iniciar', 'Staff: forme uma partida com os 12 primeiros elegíveis da fila.'),
  command('finalizar', 'Staff iniciador: informe o vencedor de uma partida ao vivo.')
    .addIntegerOption(o => o.setName('partida').setDescription('Número da partida.').setRequired(true).setMinValue(1).setMaxValue(Number.MAX_SAFE_INTEGER))
    .addStringOption(o => o.setName('vencedor').setDescription('Equipe vencedora.').setRequired(true).addChoices({ name: 'Equipe A', value: 'A' }, { name: 'Equipe B', value: 'B' })),
  command('cancelar', 'Staff: cancele uma partida sem registrar um resultado.')
    .addIntegerOption(o => o.setName('partida').setDescription('Número da partida.').setRequired(true).setMinValue(1).setMaxValue(Number.MAX_SAFE_INTEGER)),
  command('profile', 'Veja o cartão de perfil, rank e estatísticas.')
    .addUserOption(o => o.setName('usuario').setDescription('Jogador que você deseja consultar.')),
  command('ranking', 'Veja os 10 primeiros jogadores por Elo.'),
  command('vip', 'Staff: gerencie o plano VIP de um jogador.')
    .addUserOption(o => o.setName('usuario').setDescription('Jogador cadastrado.').setRequired(true))
    .addStringOption(o => o.setName('plano').setDescription('Plano a conceder ou remover.').setRequired(true).addChoices({ name: 'Sem VIP', value: 'none' }, { name: 'VIP', value: 'vip' }, { name: 'VIP+', value: 'vip_plus' }))
    .addIntegerOption(o => o.setName('dias').setDescription('Duração de 1 a 365 dias.').setRequired(true).setMinValue(1).setMaxValue(365)),
  command('verificar-manual', 'Staff: verifique um jogador pelo nick e ID do Roblox, sem código na descrição.')
    .addUserOption(o => o.setName('usuario').setDescription('Membro do Discord.').setRequired(true))
    .addStringOption(o => o.setName('roblox').setDescription('Nome de usuário Roblox, não o nome de exibição.').setRequired(true).setMinLength(3).setMaxLength(20))
    .addStringOption(o => o.setName('id').setDescription('ID numérico da conta Roblox.').setRequired(true).setMinLength(1).setMaxLength(16))
    .addStringOption(o => o.setName('posicao').setDescription('Posição principal.').setRequired(true).addChoices({ name: 'Spiker', value: 'spiker' }, { name: 'Setter', value: 'setter' })),
  command('ajustar-elo', 'Dono: ajuste o Elo de um jogador com motivo auditado.')
    .addUserOption(o => o.setName('usuario').setDescription('Jogador cadastrado.').setRequired(true))
    .addIntegerOption(o => o.setName('quantidade').setDescription('Variação entre -500 e 500.').setRequired(true).setMinValue(-500).setMaxValue(500))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo do ajuste, registrado na auditoria.').setRequired(true).setMinLength(3).setMaxLength(300)),
];

export const commandData = commands.map(value => value.toJSON());

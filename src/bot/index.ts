import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { ChannelType, Client, Events, GatewayIntentBits, type TextChannel } from 'discord.js';
import type { Match, ServiceContract } from '../core/types.js';
import { AvatarSync } from './avatars.js';
import { readBotEnvironment } from './env.js';
import { actorResolver, createInteractionHandler } from './handler.js';
import { hostPanel, NO_MENTIONS } from './presentation.js';
import { DiscordTransport, Lifecycle, Publisher } from './publisher.js';
import { syncAllEloRoles, syncEloRoles } from './roles.js';
import { publishVerifyGuide, verificationApplier } from './verify.js';
import { callSyncer, QUEUE_CALL, syncCalls } from './voice.js';
import { errorDetail } from './access.js';

export async function startBot(): Promise<(() => void) | undefined> {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return undefined;
  if (process.env.DEMO_MODE === 'true') {
    console.error('O bot não conecta usando dados demonstrativos. Defina DEMO_MODE=false para usar o banco real.');
    process.exitCode = 1;
    return undefined;
  }
  let config;
  try {
    config = readBotEnvironment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuração do Discord inválida.');
    process.exitCode = 1;
    return undefined;
  }
  const runtime = await import('../core/runtime.js');
  const service: ServiceContract = runtime.service;
  const avatars = new AvatarSync(runtime.service);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], allowedMentions: NO_MENTIONS });
  const transport = new DiscordTransport(client, config);
  const publisher = new Publisher(service, transport, config);
  const syncRoles = async (userId: string, elo: number): Promise<string | undefined> => {
    try {
      const guild = await client.guilds.fetch(config.guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      return await syncEloRoles(guild, member, elo);
    } catch {
      return 'os cargos de Elo não puderam ser sincronizados agora';
    }
  };
  const afterTick = async (changed: Match[]): Promise<void> => {
    const guild = await client.guilds.fetch(config.guildId);
    const ids = [...new Set(changed.flatMap(match => match.players.map(player => player.discordId)))];
    for (const id of ids) {
      try {
        const record = await service.getPlayer(id);
        if (!record) continue;
        const member = await guild.members.fetch({ user: id, force: true });
        await syncEloRoles(guild, member, record.elo);
      } catch {
        console.warn('Não foi possível sincronizar o cargo de Elo de um participante. Nova tentativa no próximo ciclo.');
      }
    }
  };
  /** Garante a mensagem fixa do Match Organizer no canal host e reaproveita o painel de fila que já estiver lá. */
  const ensureHostPanel = async () => {
    const guild = await client.guilds.fetch(config.guildId);
    const host = (await guild.channels.fetch()).find(c => c?.type === ChannelType.GuildText && c.name.toLowerCase().includes('host')) as TextChannel | undefined;
    if (!host) { console.warn('Canal host não encontrado; o painel do Match Organizer não foi publicado.'); return; }
    const mine = (await host.messages.fetch({ limit: 50 })).filter(message => message.author.id === client.user?.id);
    const withButton = (id: string) => mine.find(message => message.components.some(row => 'components' in row
      && row.components.some(component => (component as { customId?: string | null }).customId === id)));
    if (!withButton('mm:q:open')) await host.send(hostPanel());
    const panel = withButton('mm:q:join');
    if (panel) publisher.adoptPanel(host.id, panel.id);
  };
  const lifecycle = new Lifecycle(service, publisher, console.warn, afterTick);
  const handler = createInteractionHandler({ service, config, publisher, transport, resolveActor: actorResolver(client, config), applyVerification: verificationApplier(client, config), syncRoles, refreshAvatar: id => avatars.refresh(id) });
  const syncVoice = callSyncer(async () => syncCalls(await client.guilds.fetch(config.guildId), service, config.staffRoleId, console.warn));
  const runVoice = () => { void syncVoice().catch(error => console.warn(`Não foi possível sincronizar as calls das partidas.${errorDetail(error)}`)); };
  let voiceTimer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { lifecycle.stop(); avatars.stop(); clearInterval(voiceTimer); client.destroy(); };
  client.on(Events.VoiceStateUpdate, (_, state) => { if (state.guild.id === config.guildId && state.channel?.name.toLowerCase() === QUEUE_CALL) runVoice(); });
  client.on(Events.Error, () => console.warn('O cliente Discord encontrou uma falha de conexão.'));
  client.on(Events.ShardError, () => console.warn('A conexão com o Discord foi interrompida.'));
  client.on(Events.InteractionCreate, interaction => { void handler(interaction).catch(() => console.warn('Não foi possível processar uma interação.')); });
  client.once(Events.ClientReady, ready => {
    if (ready.application.id !== config.clientId || !ready.guilds.cache.has(config.guildId)) {
      console.error('O aplicativo conectado ou o servidor não corresponde à configuração. Confira os IDs e o convite do bot.');
      stop();
      process.exitCode = 1;
      return;
    }
    console.info('4.2 Matchmaking conectado. Recuperando partidas e prazos persistidos.');
    void lifecycle.start().catch(() => console.warn('Não foi possível recuperar as mensagens de partidas.'));
    avatars.start();
    runVoice();
    void ensureHostPanel().catch(error => console.warn(`Não foi possível publicar o painel do Match Organizer no canal host.${errorDetail(error)}`));
    voiceTimer = setInterval(runVoice, 3_000);
    if (config.verifyChannelId) {
      void publishVerifyGuide(client, config.verifyChannelId, config.guildId)
        .catch(() => console.warn('Não foi possível publicar o guia de verificação no canal #verify.'));
    }
    client.guilds.fetch(config.guildId)
      .then(guild => syncAllEloRoles(service, guild, console.warn))
      .catch(error => console.warn(`Não foi possível sincronizar os cargos de Elo na inicialização.${errorDetail(error)}`));
  });
  try {
    await client.login(config.token);
  } catch {
    console.error('Não foi possível conectar ao Discord. Confira o token e a conexão; nenhum segredo foi exibido.');
    stop();
    process.exitCode = 1;
    return undefined;
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return stop;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startBot().catch(() => {
    console.error('Não foi possível inicializar o bot. Confira a disponibilidade do serviço e sua configuração.');
    process.exitCode = 1;
  });
}

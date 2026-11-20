import { ChannelType, PermissionFlagsBits, type Client, type NewsChannel, type TextChannel } from 'discord.js';
import type { Match, ServiceContract } from '../core/types.js';
import type { BotEnvironment } from './env.js';
import { BotError, errorDetail } from './access.js';
import { matchPresentation, queuePresentation, type PanelPayload } from './presentation.js';
import { renderResult } from './result.js';

export const REQUIRED_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory,
];
const PERMISSION_NAMES = 'Ver canal, Enviar mensagens, Inserir links, Anexar arquivos e Ler histórico de mensagens';
export class MissingMessageError extends Error {}

export interface MessageTransport {
  assertChannel(channelId: string): Promise<void>;
  send(channelId: string, render: () => Promise<PanelPayload>): Promise<string>;
  edit(channelId: string, messageId: string, render: () => Promise<PanelPayload>): Promise<void>;
}

function discordCode(error: unknown): number | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : null;
}

export class DiscordTransport implements MessageTransport {
  constructor(private client: Client, private config: BotEnvironment) {}

  private async channel(channelId: string): Promise<TextChannel | NewsChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) || channel.guildId !== this.config.guildId) {
      throw new BotError('Escolha um canal de texto do servidor configurado. DMs, outros servidores e threads não são permitidos.');
    }
    const me = channel.guild.members.me ?? await channel.guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has(REQUIRED_CHANNEL_PERMISSIONS)) {
      throw new BotError(`O bot precisa destas permissões neste canal: ${PERMISSION_NAMES}. Não é necessário Administrador.`);
    }
    return channel;
  }

  async assertChannel(channelId: string): Promise<void> {
    await this.channel(channelId);
  }

  async send(channelId: string, render: () => Promise<PanelPayload>): Promise<string> {
    const channel = await this.channel(channelId);
    return (await channel.send(await render())).id;
  }

  async edit(channelId: string, messageId: string, render: () => Promise<PanelPayload>): Promise<void> {
    const channel = await this.channel(channelId);
    try {
      const message = await channel.messages.fetch(messageId);
      if (message.author.id !== this.client.user?.id) throw new BotError('A mensagem salva não pertence a este bot. Peça à staff para verificar o vínculo da partida.');
      await message.edit(await render());
    } catch (error) {
      if (discordCode(error) === 10008) throw new MissingMessageError('Mensagem removida.');
      throw error;
    }
  }
}

export class SerialExecutor {
  private pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.pending.set(key, next);
    void next.finally(() => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    }).catch(() => undefined);
    return next;
  }
}

export class Publisher {
  private serial = new SerialExecutor();
  private dirty = new Set<number>();
  private panels = new Map<string, string>();
  private unattached = new Map<number, { channelId: string; messageId: string }>();
  private resultSent = new Set<number>();
  private resultPending = new Set<number>();
  private queueSignature: string | undefined;

  constructor(private service: ServiceContract, private transport: MessageTransport, private config: Pick<BotEnvironment, 'matchChannelId' | 'resultChannelId' | 'siteUrl'>) {}

  pendingIds(): number[] {
    return [...this.dirty];
  }

  retryResultIds(): number[] {
    return [...this.resultPending];
  }

  refreshMatch(id: number): Promise<void> {
    this.dirty.add(id);
    return this.serial.run(`match:${id}`, async () => {
      const match = await this.service.getMatch(id);
      if (!match) { this.dirty.delete(id); return; }
      const channelId = match.channelId ?? this.config.matchChannelId;
      if (!channelId) throw new BotError('Esta partida não possui canal. Configure DISCORD_MATCH_CHANNEL_ID para recuperá-la.');
      const render = async () => {
        const current = await this.service.getMatch(id);
        if (!current) throw new BotError('Partida não encontrada.');
        return matchPresentation(current, this.config.siteUrl);
      };
      let messageId = match.messageId;
      const unsaved = this.unattached.get(id);
      if (!messageId && unsaved) {
        await this.service.attachMessage(id, unsaved.channelId, unsaved.messageId);
        messageId = unsaved.messageId;
        this.unattached.delete(id);
      }
      if (messageId) {
        try {
          await this.transport.edit(channelId, messageId, render);
          this.dirty.delete(id);
          return;
        } catch (error) {
          if (!(error instanceof MissingMessageError)) throw error;
        }
      }
      const sentId = await this.transport.send(channelId, render);
      this.unattached.set(id, { channelId, messageId: sentId });
      await this.service.attachMessage(id, channelId, sentId);
      this.unattached.delete(id);
      this.dirty.delete(id);
    }).catch(error => {
      this.dirty.add(id);
      throw error;
    });
  }

  publishResult(id: number): Promise<void> {
    if (this.resultSent.has(id)) return Promise.resolve();
    return this.serial.run(`result:${id}`, async () => {
      if (this.resultSent.has(id)) return;
      const match = await this.service.getMatch(id);
      if (!match || (match.status !== 'completed' && match.status !== 'cancelled')) {
        this.resultSent.add(id);
        return;
      }
      const channelId = this.config.resultChannelId ?? match.resultChannelId ?? match.channelId ?? this.config.matchChannelId;
      if (!channelId) throw new BotError('Esta partida não possui canal para o resultado. Configure DISCORD_RESULT_CHANNEL_ID ou DISCORD_MATCH_CHANNEL_ID.');
      const render = async () => {
        const current = await this.service.getMatch(id);
        if (!current || (current.status !== 'completed' && current.status !== 'cancelled')) throw new BotError('Partida não encontrada.');
        const payload = matchPresentation(current, this.config.siteUrl, false);
        return { ...payload, files: [await renderResult(current)] };
      };
      await this.transport.send(channelId, render);
      this.resultSent.add(id);
      this.resultPending.delete(id);
    }).catch(error => {
      this.resultPending.add(id);
      throw error;
    });
  }

  /** Reaproveita um painel de fila já publicado (após reinício do bot). */
  adoptPanel(channelId: string, messageId: string): void {
    this.panels.set(channelId, messageId);
  }

  publishQueue(channelId: string): Promise<void> {
    return this.serial.run(`panel:${channelId}`, async () => {
      const render = async () => queuePresentation(await this.service.getQueue(), this.config.siteUrl);
      const previous = this.panels.get(channelId);
      if (previous) {
        try { await this.transport.edit(channelId, previous, render); return; }
        catch (error) { if (!(error instanceof MissingMessageError)) throw error; }
      }
      this.panels.set(channelId, await this.transport.send(channelId, render));
    });
  }

  async refreshQueues(): Promise<void> {
    const signature = JSON.stringify(await this.service.getQueue());
    if (signature === this.queueSignature) return;
    const results = await Promise.allSettled([...this.panels.keys()].map(channel => this.publishQueue(channel)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw new Error(`Painel da fila indisponível.${errorDetail(failed.reason)}`);
    this.queueSignature = signature;
  }
}

export class Lifecycle {
  private running = false;
  private active = false;
  private recoverPending = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private service: ServiceContract, private publisher: Publisher, private report: (message: string) => void = console.warn, private afterTick?: (changed: Match[]) => Promise<void>) {}

  async cycle(recover = false): Promise<void> {
    this.recoverPending ||= recover;
    if (this.running) return;
    this.running = true;
    try {
      const changed = await this.service.tick();
      if (changed.length && this.afterTick) {
        try { await this.afterTick(changed); }
        catch { this.report('Não foi possível sincronizar cargos após a partida. Nova tentativa no próximo ciclo.'); }
      }
      const ids = new Set([...changed.map(match => match.id), ...this.publisher.pendingIds(), ...(this.recoverPending ? (await this.service.getActiveMatches()).map(match => match.id) : [])]);
      this.recoverPending = false;
      const results = await Promise.allSettled([...ids].map(id => this.publisher.refreshMatch(id)));
      if (results.some(result => result.status === 'rejected')) this.report('Não foi possível atualizar uma partida no Discord. Nova tentativa no próximo ciclo.');
      const finished = changed.filter(match => match.status === 'completed' || match.status === 'cancelled').map(match => match.id);
      const resultIds = [...new Set([...finished, ...this.publisher.retryResultIds()])];
      const published = await Promise.allSettled(resultIds.map(id => this.publisher.publishResult(id)));
      if (published.some(result => result.status === 'rejected')) this.report('Não foi possível publicar um resultado no canal de resultados. Nova tentativa no próximo ciclo.');
      await this.publisher.refreshQueues();
    } catch (error) {
      this.report(`Não foi possível concluir o ciclo de atualização. Nova tentativa no próximo ciclo.${errorDetail(error)}`);
    } finally {
      this.running = false;
    }
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.cycle(true);
    if (this.active) this.timer = setInterval(() => { void this.cycle().catch(() => this.report('Falha no ciclo de atualização.')); }, 2_000);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

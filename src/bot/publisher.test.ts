import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { DiscordTransport, Lifecycle, MissingMessageError, Publisher, REQUIRED_CHANNEL_PERMISSIONS, SerialExecutor } from './publisher.js';
import type { PanelPayload } from './presentation.js';
import { config, match, MemoryTransport, playerId, serviceStub } from './test-fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('publicação recupera mensagem ausente e edita a mesma mensagem nas próximas fases', async () => {
  let current = match({ messageId: null });
  const transport = new MemoryTransport();
  const service = serviceStub({ getMatch: async () => current, attachMessage: async (_id, channelId, messageId) => { current = { ...current, channelId, messageId }; } });
  const publisher = new Publisher(service, transport, config);
  await publisher.refreshMatch(42);
  assert.equal(transport.sent.length, 1);
  assert.ok(current.messageId);
  current = { ...current, status: 'ready', mode: 'balanced' };
  await publisher.refreshMatch(42);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.edited[0].id, current.messageId);
  assert.match(transport.edited[0].payload.embeds[0].data.description!, /PRONTA PARA COMEÇAR/);
});

test('renders concorrentes são serializados e refazem leitura antes de editar', async () => {
  let current = match({ status: 'ready', mode: 'balanced' });
  const started = deferred();
  const release = deferred();
  let calls = 0;
  class SlowTransport extends MemoryTransport {
    override async edit(channel: string, id: string, render: () => Promise<PanelPayload>) {
      if (++calls === 1) { started.resolve(); await release.promise; }
      await super.edit(channel, id, render);
    }
  }
  const transport = new SlowTransport();
  const publisher = new Publisher(serviceStub({ getMatch: async () => current }), transport, config);
  const first = publisher.refreshMatch(42);
  await started.promise;
  current = { ...current, status: 'live' };
  const second = publisher.refreshMatch(42);
  assert.equal(calls, 1);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(transport.edited.length, 2);
  for (const item of transport.edited) assert.match(item.payload.embeds[0].data.description!, /AO VIVO/);
});

test('erro transitório não duplica mensagem e fica pendente para o próximo tick', async () => {
  let fail = true;
  class Transport extends MemoryTransport {
    override async edit(channel: string, id: string, render: () => Promise<PanelPayload>) {
      if (fail) throw new Error('network');
      await super.edit(channel, id, render);
    }
  }
  const transport = new Transport();
  const service = serviceStub({ getMatch: async () => match() });
  const publisher = new Publisher(service, transport, config);
  await assert.rejects(() => publisher.refreshMatch(42));
  assert.deepEqual(publisher.pendingIds(), [42]);
  assert.equal(transport.sent.length, 0);
  fail = false;
  await new Lifecycle(service, publisher, () => {}).cycle();
  assert.deepEqual(publisher.pendingIds(), []);
  assert.equal(transport.edited.length, 1);
});

test('apenas mensagem removida autoriza recriação e reanexação', async () => {
  let current = match();
  class Transport extends MemoryTransport {
    override async edit() { throw new MissingMessageError(); }
  }
  const transport = new Transport();
  const publisher = new Publisher(serviceStub({ getMatch: async () => current, attachMessage: async (_id, channelId, messageId) => { current = { ...current, channelId, messageId }; } }), transport, config);
  await publisher.refreshMatch(42);
  assert.equal(transport.sent.length, 1);
  assert.equal(current.messageId, '300000000000000001');
});

test('falha ao persistir anexo reaproveita ID enviado, sem publicação duplicada', async () => {
  let current = match({ messageId: null });
  let fail = true;
  const transport = new MemoryTransport();
  const publisher = new Publisher(serviceStub({
    getMatch: async () => current,
    attachMessage: async (_id, channelId, messageId) => { if (fail) throw new Error('database'); current = { ...current, channelId, messageId }; },
  }), transport, config);
  await assert.rejects(() => publisher.refreshMatch(42));
  fail = false;
  await publisher.refreshMatch(42);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.edited.length, 1);
});

test('restart recupera ativas, processa tick e publica apenas partidas sem anexo', async () => {
  const matches = [match(), match({ id: 43, messageId: null, channelId: null }), match({ id: 44, status: 'completed' })];
  const transport = new MemoryTransport();
  let ticks = 0;
  const service = serviceStub({
    getMatch: async id => matches.find(value => value.id === id) ?? null,
    getActiveMatches: async () => matches.filter(value => value.status !== 'completed'),
    tick: async () => { ticks++; return [matches[2]]; },
    attachMessage: async (id, channelId, messageId) => { Object.assign(matches.find(value => value.id === id)!, { channelId, messageId }); },
  });
  await new Lifecycle(service, new Publisher(service, transport, config), () => {}).cycle(true);
  assert.equal(ticks, 1);
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.edited.length, 2);
  assert.equal(matches[1].channelId, config.matchChannelId);
  const result = transport.sent.find(item => item.payload.files?.length);
  assert.ok(result);
  assert.equal(result.channel, config.matchChannelId);
});

test('resultado publica uma única vez no canal de resultados com imagem', async () => {
  const completed = match({
    status: 'completed', winner: 'A', mvpId: playerId(0),
    players: match().players.map((player, index) => ({ ...player, team: index < 6 ? 'A' as const : 'B' as const, eloDelta: index < 6 ? 12 : -12 })),
  });
  const transport = new MemoryTransport();
  const service = serviceStub({ getMatch: async () => completed, tick: async () => [completed] });
  const resultConfig = { ...config, resultChannelId: '100000000000000009' };
  const publisher = new Publisher(service, transport, resultConfig);
  const lifecycle = new Lifecycle(service, publisher, () => {});
  await lifecycle.cycle();
  const results = transport.sent.filter(item => item.channel === resultConfig.resultChannelId);
  assert.equal(results.length, 1);
  assert.equal(results[0].payload.files?.length, 1);
  assert.ok(results[0].payload.files![0] instanceof Buffer);
  assert.match(results[0].payload.embeds[0].data.description!, /Vitória da \*\*Equipe A\*\*/);
  await lifecycle.cycle();
  assert.equal(transport.sent.filter(item => item.channel === resultConfig.resultChannelId).length, 1);
});

test('falha ao publicar resultado fica pendente e é tentada no próximo ciclo', async () => {
  let fail = true;
  class Transport extends MemoryTransport {
    override async send(channel: string, render: () => Promise<PanelPayload>) {
      if (fail) throw new Error('network');
      return super.send(channel, render);
    }
  }
  const transport = new Transport();
  const completed = match({
    status: 'completed', winner: 'B',
    players: match().players.map((player, index) => ({ ...player, team: index < 6 ? 'A' as const : 'B' as const, eloDelta: null })),
  });
  let ticked = false;
  const reports: string[] = [];
  const service = serviceStub({ getMatch: async () => completed, tick: async () => { if (!ticked) { ticked = true; return [completed]; } return []; } });
  const publisher = new Publisher(service, transport, config);
  const lifecycle = new Lifecycle(service, publisher, message => { reports.push(message); });
  await lifecycle.cycle();
  assert.equal(transport.sent.length, 0);
  assert.deepEqual(publisher.retryResultIds(), [42]);
  assert.ok(reports.some(message => /canal de resultados/.test(message)));
  fail = false;
  await lifecycle.cycle();
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(publisher.retryResultIds(), []);
  assert.equal(transport.sent[0].payload.files?.length, 1);
});

test('guard impede sobreposição de ticks; falha inicial não perde recuperação', async () => {
  const started = deferred();
  const release = deferred();
  let ticks = 0;
  class Transport extends MemoryTransport {
    override async edit(channel: string, id: string, render: () => Promise<PanelPayload>) {
      started.resolve(); await release.promise; await super.edit(channel, id, render);
    }
  }
  const transport = new Transport();
  const service = serviceStub({ getMatch: async () => match(), getActiveMatches: async () => [match()], tick: async () => { if (++ticks === 1) throw new Error('db'); return []; } });
  const lifecycle = new Lifecycle(service, new Publisher(service, transport, config), () => {});
  await lifecycle.cycle(true);
  const running = lifecycle.cycle();
  await started.promise;
  await lifecycle.cycle();
  assert.equal(ticks, 2);
  release.resolve();
  await running;
  assert.equal(transport.edited.length, 1);
});

test('fila publicada é atualizada sem duplicar e não recebe edits sem mudanças', async () => {
  let spikers = 0;
  const transport = new MemoryTransport();
  const service = serviceStub({ getQueue: async () => ({ players: [], spikers, setters: 0, ready: false }) });
  const publisher = new Publisher(service, transport, config);
  await publisher.publishQueue(config.matchChannelId!);
  await publisher.refreshQueues();
  const edits = transport.edited.length;
  await publisher.refreshQueues();
  assert.equal(transport.edited.length, edits);
  spikers = 1;
  await publisher.refreshQueues();
  assert.equal(transport.edited.length, edits + 1);
  assert.equal(transport.sent.length, 1);
  assert.match(transport.edited.at(-1)!.payload.embeds[0].data.description!, /1\/8/);
});

test('executor libera a fila após erro', async () => {
  const executor = new SerialExecutor();
  const one = executor.run('x', async () => { throw new Error('first'); });
  const two = executor.run('x', async () => 2);
  await assert.rejects(() => one);
  assert.equal(await two, 2);
});

test('transport exige permissões mínimas, guild correta e canal de texto', async () => {
  assert.ok(!REQUIRED_CHANNEL_PERMISSIONS.includes(PermissionFlagsBits.Administrator as never));
  let channel: object = { type: ChannelType.DM };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  const transport = new DiscordTransport(client, config);
  await assert.rejects(() => transport.assertChannel('any'), /canal de texto/);
  channel = { type: ChannelType.GuildText, guildId: 'other' };
  await assert.rejects(() => transport.assertChannel('any'), /canal de texto/);
  channel = { type: ChannelType.GuildText, guildId: config.guildId, guild: { members: { me: {} } }, permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel) };
  await assert.rejects(() => transport.assertChannel('any'), /Anexar arquivos/);
  channel = { ...channel, permissionsFor: () => new PermissionsBitField(REQUIRED_CHANNEL_PERMISSIONS) };
  await assert.doesNotReject(() => transport.assertChannel('any'));
});

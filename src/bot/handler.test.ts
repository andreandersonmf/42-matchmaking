import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, type Interaction } from 'discord.js';
import type { ServiceContract } from '../core/types.js';
import type { Actor } from './access.js';
import { createInteractionHandler, type HandlerDependencies } from './handler.js';
import { Publisher } from './publisher.js';
import { config, initiatorId, match, messageId, MemoryTransport, player, playerId, serviceStub } from './test-fixtures.js';

const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('Acesso à rede proibido'); }; });
after(() => { globalThis.fetch = originalFetch; });

type Reply = { flags?: number; content?: string; embeds?: { data: { description?: string } }[]; files?: unknown[]; allowedMentions?: unknown };
function interaction(kind: 'command' | 'button' | 'select', name: string, id = playerId(0), options: Record<string, unknown> = {}) {
  const replies: Reply[] = [];
  const deferred: Reply[] = [];
  const value = {
    commandName: name, customId: name, guildId: config.guildId as string | null, channelId: config.matchChannelId,
    user: { id, username: 'DiscordName', globalName: 'Nome Discord' },
    message: { id: messageId }, values: [] as string[], deferred: false, replied: false,
    options: { getString: (key: string) => options[key] ?? null, getInteger: (key: string) => options[key] ?? null, getUser: (key: string) => options[key] ?? null },
    isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select', isModalSubmit: () => false,
    modals: [] as unknown[], showModal: async (modal: unknown) => { value.modals.push(modal); value.replied = true; },
    inGuild: () => value.guildId !== null,
    deferReply: async (payload: Reply) => { deferred.push(payload); value.deferred = true; },
    reply: async (payload: Reply) => { replies.push(payload); value.replied = true; },
    editReply: async (payload: Reply) => { replies.push(payload); value.replied = true; },
  };
  return { value, event: value as unknown as Interaction, replies, deferred, body: () => replies.at(-1)?.embeds?.[0].data.description ?? replies.at(-1)?.content ?? '' };
}

const staff: Actor = { id: initiatorId, roles: [config.staffRoleId], permissions: 0n };
function handler(overrides: Partial<ServiceContract> = {}, actor = staff, extra: Partial<HandlerDependencies> = {}) {
  const service = serviceStub(overrides);
  const transport = new MemoryTransport();
  const publisher = new Publisher(service, transport, config);
  return { run: createInteractionHandler({ service, config, transport, publisher, resolveActor: async () => actor, report: () => {}, ...extra }), transport, service, publisher };
}

test('DM e guild externa são rejeitadas antes de qualquer chamada ao serviço', async () => {
  let calls = 0;
  const { run } = handler({ joinQueue: async () => { calls++; throw new Error(); } });
  for (const guild of [null, '999999999999999999']) {
    const request = interaction('command', 'fila');
    request.value.guildId = guild;
    await run(request.event);
    assert.match(request.body(), /somente no servidor configurado/);
    assert.equal(request.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(request.deferred.length, 0);
  }
  assert.equal(calls, 0);
});

test('resultado só é aceito ao vivo e equipe precisa ser A ou B', async () => {
  let calls = 0;
  for (const status of ['voting', 'ready', 'mvp', 'completed', 'cancelled'] as const) {
    const request = interaction('command', 'finalizar', initiatorId, { partida: 42, vencedor: 'A' });
    await handler({ getMatch: async () => match({ status }), finishMatch: async () => { calls++; return match(); } }).run(request.event);
    assert.match(request.body(), /ao vivo/);
  }
  const invalid = interaction('command', 'finalizar', initiatorId, { partida: 42, vencedor: 'X' });
  await handler({ getMatch: async () => match({ status: 'live' }) }).run(invalid.event);
  assert.match(invalid.body(), /A ou B/);
  assert.equal(calls, 0);
});

test('botão iniciar verifica autor atual, staff, status e mensagem persistida', async () => {
  let calls = 0;
  const current = match({ status: 'ready', mode: 'random' });
  const ctx = handler({ getMatch: async () => current, startMatch: async (id, actor) => { assert.deepEqual([id, actor], [42, initiatorId]); calls++; return current; } });
  const stale = interaction('button', 'mm:m:42:start', initiatorId);
  stale.value.message.id = 'other';
  await ctx.run(stale.event);
  assert.match(stale.body(), /substituído/);
  const correct = interaction('button', 'mm:m:42:start', initiatorId);
  await ctx.run(correct.event);
  assert.equal(calls, 1);
  assert.match(correct.body(), /Partida ao vivo/);
});

test('VIP aceita cargo staff; ajuste Elo é exclusivo do dono e encaminha auditoria', async () => {
  let grants = 0;
  const vip = interaction('command', 'vip', initiatorId, { usuario: { id: playerId(0) }, plano: 'vip_plus', dias: 365 });
  await handler({ grantVip: async (actor, id, tier, days) => { assert.deepEqual([actor, id, tier, days], [initiatorId, playerId(0), 'vip_plus', 365]); grants++; return player(); } }).run(vip.event);
  assert.equal(grants, 1);
  const options = { usuario: { id: playerId(0) }, quantidade: -50, motivo: 'Correção de resultado' };
  const denied = interaction('command', 'ajustar-elo', initiatorId, options);
  await handler().run(denied.event);
  assert.match(denied.body(), /Somente o dono/);
  const allowed = interaction('command', 'ajustar-elo', config.ownerId, options);
  let adjustments = 0;
  await handler({ adjustElo: async (actor, id, amount, reason) => { assert.deepEqual([actor, id, amount, reason], [config.ownerId, playerId(0), -50, 'Correção de resultado']); adjustments++; return player(); } }, { id: config.ownerId, roles: [], permissions: 0n }).run(allowed.event);
  assert.equal(adjustments, 1);
  assert.match(allowed.body(), /auditoria/);
});

test('dono pode cancelar partida alheia sem finalizar ou ajustar resultados', async () => {
  let calls = 0;
  const request = interaction('command', 'cancelar', config.ownerId, { partida: 42 });
  await handler({ getMatch: async () => match(), cancelMatch: async (id, actor) => { assert.deepEqual([id, actor], [42, config.ownerId]); calls++; return match({ status: 'cancelled' }); } }, { id: config.ownerId, roles: [], permissions: 0n }).run(request.event);
  assert.equal(calls, 1);
  assert.match(request.body(), /sem registrar um resultado/);
});

test('voto de modo: só jogadores; customId inválido não alcança engine', async () => {
  let votes = 0;
  const ctx = handler({ getMatch: async () => match(), voteMode: async (id, voter, mode) => { assert.deepEqual([id, voter, mode], [42, playerId(0), 'balanced']); votes++; return match(); } });
  const outside = interaction('button', 'mm:m:42:mode:balanced', config.ownerId);
  await ctx.run(outside.event);
  assert.match(outside.body(), /12 jogadores/);
  const invalid = interaction('button', 'mm:m:42:mode:admin');
  await ctx.run(invalid.event);
  assert.match(invalid.body(), /inválido/);
  const valid = interaction('button', 'mm:m:42:mode:balanced');
  await ctx.run(valid.event);
  assert.equal(votes, 1);
  assert.equal(valid.deferred[0].flags, MessageFlags.Ephemeral);
  assert.equal(ctx.transport.edited.length, 1);
});

test('MVP rejeita autovoto, candidato externo e múltiplos valores; aceita outra equipe', async () => {
  const current = match({ status: 'mvp', winner: 'A' });
  let votes = 0;
  const ctx = handler({ getMatch: async () => current, voteMvp: async (id, voter, candidate) => { assert.deepEqual([id, voter, candidate], [42, playerId(0), playerId(6)]); votes++; return current; } });
  for (const values of [[playerId(0)], [config.ownerId], [playerId(1), playerId(2)], ['bad']]) {
    const request = interaction('select', 'mm:m:42:mvp');
    request.value.values = values;
    await ctx.run(request.event);
    assert.doesNotMatch(request.body(), /Seu voto/);
  }
  const valid = interaction('select', 'mm:m:42:mvp');
  valid.value.values = [playerId(6)];
  await ctx.run(valid.event);
  assert.equal(votes, 1);
  assert.match(valid.body(), /em sigilo/);
});

test('draft: apenas capitão da vez pode escolher candidato elegível', async () => {
  const current = match({ status: 'drafting', mode: 'captains', draftTurn: 'A' });
  current.players[0].team = 'A'; current.players[0].isCaptain = true;
  current.players[6].team = 'B'; current.players[6].isCaptain = true;
  let picks = 0;
  const ctx = handler({ getMatch: async () => current, pick: async (id, captain, selected) => { assert.deepEqual([id, captain, selected], [42, playerId(0), playerId(1)]); picks++; return current; } });
  const wrong = interaction('select', 'mm:m:42:pick', playerId(6)); wrong.value.values = [playerId(1)];
  await ctx.run(wrong.event);
  assert.match(wrong.body(), /Somente o capitão/);
  const taken = interaction('select', 'mm:m:42:pick'); taken.value.values = [playerId(6)];
  await ctx.run(taken.event);
  assert.match(taken.body(), /já foi escolhido/);
  const valid = interaction('select', 'mm:m:42:pick'); valid.value.values = [playerId(1)];
  await ctx.run(valid.event);
  assert.equal(picks, 1);
});

test('register e verificar encaminham identidade e descrição ao contrato exato', async () => {
  const challenge = { discordId: playerId(0), name: 'Nome Discord', robloxId: '123', robloxName: 'RobloxName', position: 'setter' as const, code: 'LINK-ABC123', expiresAt: 1_900_000_000_000 };
  let completed = 0;
  const ctx = handler({
    beginLink: async (...args) => { assert.deepEqual(args, [playerId(0), 'Nome Discord', '123', 'RobloxName', 'setter']); return challenge; },
    getLink: async () => challenge,
    completeLink: async (id, description) => { assert.equal(id, playerId(0)); assert.equal(description, 'My description LINK-ABC123'); completed++; return player(); },
  }, staff, { lookup: async () => ({ id: '123', name: 'RobloxName' }), description: async id => { assert.equal(id, '123'); return 'My description LINK-ABC123'; } });
  const register = interaction('command', 'register', playerId(0), { roblox: 'RobloxName', posicao: 'setter' });
  await ctx.run(register.event);
  assert.match(register.body(), /LINK-ABC123/);
  assert.match(register.body(), /\/verificar/);
  const verify = interaction('command', 'verificar');
  await ctx.run(verify.event);
  assert.equal(completed, 1);
});

test('profile responde PNG anexo sem embed; filas encaminham posição ou saída', async () => {
  const profile = interaction('command', 'profile');
  await handler({}, staff, { profile: async () => Buffer.from('mock-png') }).run(profile.event);
  assert.equal(profile.replies[0].files?.length, 1);
  assert.deepEqual(profile.replies[0].embeds, []);
  let joins = 0; let leaves = 0;
  const queue = { players: [], spikers: 0, setters: 0, ready: false };
  const ctx = handler({ joinQueue: async (id, position) => { assert.equal(id, playerId(0)); assert.equal(position, 'setter'); joins++; return queue; }, leaveQueue: async () => { leaves++; return queue; } });
  await ctx.run(interaction('button', 'mm:q:setter').event);
  await ctx.run(interaction('command', 'sair').event);
  assert.equal(joins, 1); assert.equal(leaves, 1);
});

test('ranking responde PNG anexo sem embed', async () => {
  const ranking = interaction('command', 'ranking');
  await handler({}, staff, { ranking: async () => Buffer.from('mock-png-ranking') }).run(ranking.event);
  assert.equal(ranking.replies[0].files?.length, 1);
  assert.deepEqual(ranking.replies[0].embeds, []);
});

test('verificar aplica cargo e apelido via dependência e relata avisos', async () => {
  const challenge = { discordId: playerId(0), name: 'Nome Discord', robloxId: '123', robloxName: 'RobloxName', position: 'setter' as const, code: 'LINK-ABC123', expiresAt: 1_900_000_000_000 };
  let applied = 0;
  const ctx = handler({ getLink: async () => challenge, completeLink: async () => player() }, staff, {
    description: async () => 'desc LINK-ABC123',
    applyVerification: async (id, linked) => { assert.equal(id, playerId(0)); assert.equal(linked.robloxName, 'Roblox_0'); applied++; return 'Avisos: teste.'; },
  });
  const verify = interaction('command', 'verificar');
  await ctx.run(verify.event);
  assert.equal(applied, 1);
  assert.match(verify.body(), /Avisos: teste/);
});

test('engine inesperada resulta em erro efêmero sem detalhes internos', async () => {
  const request = interaction('command', 'fila');
  await handler({ joinQueue: async () => { throw new Error('SQLITE private path secret-token'); } }).run(request.event);
  assert.equal(request.deferred[0].flags, MessageFlags.Ephemeral);
  assert.doesNotMatch(request.body(), /SQLITE|private|secret-token|Error/);
  assert.match(request.body(), /Não foi possível/);
});

test('criação chama engine uma vez, publica e anexa sem regras locais', async () => {
  let current = match({ messageId: null });
  let created = 0;
  const ctx = handler({ createMatch: async (actor, channel) => { assert.deepEqual([actor, channel], [initiatorId, config.matchChannelId]); created++; return current; }, getMatch: async () => current, attachMessage: async (_id, channelId, messageId) => { current = { ...current, channelId, messageId }; } });
  const request = interaction('command', 'iniciar', initiatorId);
  await ctx.run(request.event);
  assert.equal(created, 1);
  assert.equal(ctx.transport.sent.length, 1);
  assert.ok(current.messageId);
  assert.match(request.body(), /formada/);
});

test('capitães: os 12 jogadores votam pelo painel atual; capitão pode iniciar sem a staff', async () => {
  const current = match({ status: 'captains', mode: 'captains' });
  const calls: unknown[][] = [];
  const ctx = handler({ getMatch: async () => current, voteCaptain: async (...args) => { calls.push(args); return current; } });

  const outsider = interaction('select', 'mm:m:42:cap:A', config.ownerId); outsider.value.values = [playerId(3)];
  await ctx.run(outsider.event);
  assert.match(outsider.body(), /Somente os 12 jogadores/);
  const stale = interaction('select', 'mm:m:42:cap:A', playerId(1)); stale.value.values = [playerId(3)]; stale.value.message.id = 'other';
  await ctx.run(stale.event);
  assert.match(stale.body(), /substituído/);
  const button = interaction('button', 'mm:m:42:cap:A', playerId(1));
  await ctx.run(button.event);
  assert.match(button.body(), /Controle de capitão inválido/);
  assert.equal(calls.length, 0);

  const valid = interaction('select', 'mm:m:42:cap:A', playerId(1)); valid.value.values = [playerId(3)];
  await ctx.run(valid.event);
  assert.deepEqual(calls, [[42, playerId(1), playerId(3)]]);
  assert.match(valid.body(), /voto de capitão foi registrado/);

  const late = interaction('select', 'mm:m:42:cap:A', playerId(1)); late.value.values = [playerId(3)];
  await handler({ getMatch: async () => match({ status: 'drafting', mode: 'captains', draftTurn: 'A' }) }).run(late.event);
  assert.match(late.body(), /já terminou/);

  const ready = match({ status: 'ready' });
  ready.players[2].team = 'A'; ready.players[2].isCaptain = true;
  const started: unknown[][] = [];
  const captain = interaction('button', 'mm:m:42:start', playerId(2));
  await handler({ getMatch: async () => ready, startMatch: async (...args) => { started.push(args); return ready; } }, { id: playerId(2), roles: [], permissions: 0n }).run(captain.event);
  assert.deepEqual(started, [[42, playerId(2)]]);
});

test('denúncia: botão só para os 12; menu lista os outros 11; escolher abre o formulário sem defer', async () => {
  const live = match({ status: 'live' });
  const { run } = handler({ getMatch: async () => live });
  const outsider = interaction('button', 'mm:m:42:report', config.ownerId);
  await run(outsider.event);
  assert.match(outsider.body(), /Somente os 12/);
  const click = interaction('button', 'mm:m:42:report', playerId(1));
  click.value.message.id = 'outra-mensagem';
  await run(click.event);
  const menu = (click.replies.at(-1) as { components: { toJSON(): { components: { custom_id: string; options: unknown[] }[] } }[] }).components[0].toJSON().components[0];
  assert.equal(menu.custom_id, 'mm:m:42:reportpick');
  assert.equal(menu.options.length, 11);
  const pick = interaction('select', 'mm:m:42:reportpick', playerId(1));
  pick.value.values = [playerId(0)];
  await run(pick.event);
  assert.equal(pick.deferred.length, 0);
  assert.equal(pick.value.modals.length, 1);
  assert.equal((pick.value.modals[0] as { toJSON(): { custom_id: string } }).toJSON().custom_id, `mm:r:42:${playerId(0)}`);
});

test('denúncia: só o Conselho vota no ticket', async () => {
  let votes = 0;
  const ticket = { id: 1, status: 'open' as const, matchId: 42, accusedId: playerId(0), reporters: [], ballots: {}, verdict: null, decidedBy: null, closedBy: null, channelId: config.matchChannelId!, messageId, createdAt: 0, closedAt: null };
  const { run } = handler({ getReport: async () => ticket, voteReport: async () => { votes++; return ticket; } });
  const vote = interaction('select', 'mm:t:1:vote', playerId(5));
  vote.value.values = ['warning'];
  Object.assign(vote.value, { guild: { roles: { cache: { find: () => ({ id: '100000000000000099' }) } } } });
  await run(vote.event);
  assert.match(vote.body(), /cargo Conselho/);
  assert.equal(votes, 0);
});

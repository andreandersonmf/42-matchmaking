import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { BotError, isStaff, parseCustomId, requireInitiator, requireOwner, requireParticipant, safeError, selectedPlayer } from './access.js';
import { commandData } from './commands.js';
import { readBotEnvironment, readRegistrationEnvironment, safeSiteUrl } from './env.js';
import { config, initiatorId, match, playerId } from './test-fixtures.js';

const staff = { id: initiatorId, roles: [config.staffRoleId], permissions: 0n };
const owner = { id: config.ownerId, roles: [], permissions: 0n };

test('staff por cargo, Gerenciar Servidor ou dono; nenhum privilégio implícito', () => {
  assert.equal(isStaff(staff, config), true);
  assert.equal(isStaff(owner, config), true);
  assert.equal(isStaff({ ...staff, roles: [], permissions: PermissionFlagsBits.ManageGuild }, config), true);
  assert.equal(isStaff({ ...staff, roles: [], permissions: PermissionFlagsBits.ManageMessages }, config), false);
});

test('iniciar/finalizar exigem staff atual e iniciador; nem dono pode substituir', () => {
  assert.doesNotThrow(() => requireInitiator(staff, match(), config));
  assert.throws(() => requireInitiator({ ...staff, roles: [] }, match(), config), BotError);
  assert.throws(() => requireInitiator(owner, match(), config), /Somente o membro/);
  assert.throws(() => requireInitiator({ ...staff, id: playerId(5) }, match(), config), BotError);
});

test('Elo exclusivo do dono e votos exclusivos de participantes', () => {
  assert.doesNotThrow(() => requireOwner(owner, config));
  assert.throws(() => requireOwner(staff, config), BotError);
  assert.doesNotThrow(() => requireParticipant(match(), playerId(3)));
  assert.throws(() => requireParticipant(match(), config.ownerId), BotError);
});

test('custom IDs têm gramática fechada e IDs inteiros seguros', () => {
  assert.deepEqual(parseCustomId('mm:q:spiker'), { kind: 'queue', action: 'spiker' });
  assert.deepEqual(parseCustomId('mm:m:42:mode:balanced'), { kind: 'mode', matchId: 42, mode: 'balanced' });
  assert.deepEqual(parseCustomId('mm:m:42:pick'), { kind: 'pick', matchId: 42 });
  assert.deepEqual(parseCustomId('mm:m:42:cap:A'), { kind: 'captain', matchId: 42, team: 'A' });
  assert.deepEqual(parseCustomId('mm:m:42:cap:B'), { kind: 'captain', matchId: 42, team: 'B' });
  for (const bad of ['mm:m:42:cap:C', 'mm:m:42:cap:', 'mm:m:42:cap:AB', 'mm:m:42:cap:a']) assert.equal(parseCustomId(bad), null);
  for (const bad of ['mm:m:0:start', 'mm:m:01:start', 'mm:m:-1:start', 'mm:m:42:mode:evil', 'mm:m:42:start:extra', 'mm:m:9007199254740992:start', 'mm:q:owner', '', 'x'.repeat(101)]) assert.equal(parseCustomId(bad), null);
  assert.equal(selectedPlayer([playerId(1)]), playerId(1));
  for (const bad of [[], ['1'], [playerId(1), playerId(2)], ['@everyone']]) assert.throws(() => selectedPlayer(bad), BotError);
});

test('erros internos nunca expõem stacks, SQL ou segredos', () => {
  const message = safeError(new Error('DISCORD_TOKEN=secret; SELECT * FROM players'));
  assert.doesNotMatch(message, /secret|SELECT|TOKEN|Error/);
  assert.equal(safeError(new BotError('Mensagem segura.')), 'Mensagem segura.');
});

test('registro explícito contém comandos, limites e não bloqueia staff por cargo', () => {
  assert.deepEqual(commandData.map(command => command.name), ['register', 'verificar', 'posicao', 'fila', 'sair', 'setup', 'iniciar', 'finalizar', 'cancelar', 'profile', 'ranking', 'vip', 'verificar-manual', 'ajustar-elo']);
  for (const command of commandData) {
    assert.equal(command.dm_permission, false);
    assert.equal(command.default_member_permissions, undefined);
  }
  const amount = commandData.find(command => command.name === 'ajustar-elo')!.options!.find(option => option.name === 'quantidade')!;
  assert.ok('min_value' in amount && amount.min_value === -500);
  assert.ok('max_value' in amount && amount.max_value === 500);
});

test('valida env por nomes exatos sem expor valores', () => {
  const env = {
    DISCORD_TOKEN: `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(32)}`,
    DISCORD_CLIENT_ID: config.clientId, DISCORD_GUILD_ID: config.guildId,
    DISCORD_OWNER_ID: config.ownerId, DISCORD_STAFF_ROLE_ID: config.staffRoleId,
  };
  assert.equal(readBotEnvironment(env).guildId, config.guildId);
  assert.equal(readRegistrationEnvironment(env).clientId, config.clientId);
  for (const key of Object.keys(env)) {
    assert.throws(() => readBotEnvironment({ ...env, [key]: '' }), error => error instanceof Error && error.message.includes(key) && !error.message.includes(env.DISCORD_TOKEN));
  }
  assert.throws(() => readBotEnvironment({ ...env, DISCORD_MATCH_CHANNEL_ID: 'bad-secret' }), /DISCORD_MATCH_CHANNEL_ID/);
  assert.throws(() => readBotEnvironment({ ...env, SITE_URL: 'javascript:alert(1)' }), /SITE_URL/);
  assert.equal(safeSiteUrl('https://example.com/ranking'), 'https://example.com/ranking');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pass@example.com', 'not-a-url']) assert.equal(safeSiteUrl(url), undefined);
});

test('ids de denúncia: botão, menu, formulário e ticket', () => {
  assert.deepEqual(parseCustomId('mm:m:42:report'), { kind: 'report', matchId: 42 });
  assert.deepEqual(parseCustomId('mm:m:42:reportpick'), { kind: 'reportpick', matchId: 42 });
  assert.deepEqual(parseCustomId(`mm:r:42:${playerId(3)}`), { kind: 'reportform', matchId: 42, accusedId: playerId(3) });
  assert.deepEqual(parseCustomId('mm:t:7:vote'), { kind: 'ticket', reportId: 7, action: 'vote' });
  assert.deepEqual(parseCustomId('mm:t:7:close'), { kind: 'ticket', reportId: 7, action: 'close' });
  assert.deepEqual(parseCustomId('mm:t:7:decide'), { kind: 'ticket', reportId: 7, action: 'decide' });
  for (const bad of ['mm:r:42:123', 'mm:t:0:vote', 'mm:t:7:delete', 'mm:m:42:reports']) assert.equal(parseCustomId(bad), null);
});

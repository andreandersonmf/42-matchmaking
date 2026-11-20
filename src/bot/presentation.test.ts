import test from 'node:test';
import assert from 'node:assert/strict';
import type { MatchMode, MatchStatus } from '../core/types.js';
import { captainCandidates, COLOR, draftCandidates, matchPresentation, queuePresentation, text } from './presentation.js';
import { match, player, playerId } from './test-fixtures.js';

const statuses: MatchStatus[] = ['voting', 'captains', 'drafting', 'ready', 'live', 'mvp', 'completed', 'cancelled'];

test('todas as fases e modos produzem embeds e componentes válidos', () => {
  for (const mode of [null, 'captains', 'balanced', 'random'] as (MatchMode | null)[]) {
    for (const status of statuses) {
      const value = match({ mode, status, draftTurn: 'A', draftDeadline: 1_800_000_045_000, mvpDeadline: 1_800_000_060_000 });
      if (status !== 'voting') value.players.forEach((p, i) => { p.team = status === 'drafting' && i > 1 ? null : i % 2 === 0 ? 'A' : 'B'; p.isCaptain = i < 2; });
      const payload = matchPresentation(value, 'https://example.com');
      const embed = payload.embeds[0].toJSON();
      assert.equal(embed.color, COLOR);
      assert.match(embed.title!, /#0042/);
      assert.ok(embed.timestamp);
      assert.match(embed.footer!.text, /4 spikers \+ 2 setters/);
      assert.deepEqual(payload.allowedMentions.parse, []);
      assert.ok(embed.description!.length < 4096);
      for (const field of embed.fields!) assert.ok(field.value.length <= 1024, `${status}: ${field.name}`);
      for (const row of payload.components) assert.doesNotThrow(() => row.toJSON());
    }
  }
});

test('votação traz contagens, prazo relativo e desempate; MVP usa um select de 12', () => {
  const voting = matchPresentation(match({ modeVoters: 3, votes: { balanced: 2, captains: 1, random: 0 } }));
  assert.match(voting.embeds[0].data.description!, /3\/12/);
  assert.match(voting.embeds[0].data.description!, /<t:1800000030:R>/);
  assert.match(voting.embeds[0].data.description!, /equilibrado, capitães, aleatório/);
  assert.equal(voting.components[0].components.length, 3);
  const mvp = matchPresentation(match({ status: 'mvp', winner: 'A', mvpDeadline: 1_800_000_060_000 }));
  assert.equal(mvp.components.length, 1);
  const select = mvp.components[0].toJSON().components[0];
  assert.ok('options' in select && select.options.length === 12);
  assert.ok('max_values' in select && select.max_values === 1);
});

test('modo somente leitura desabilita controles; equipes prontas têm botão restrito', () => {
  for (const status of ['voting', 'ready', 'mvp'] as const) {
    const payload = matchPresentation(match({ status }), undefined, false);
    for (const row of payload.components) for (const component of row.toJSON().components) assert.equal(component.disabled, true);
  }
  const ready = matchPresentation(match({ status: 'ready' }));
  const button = ready.components[0].toJSON().components[0];
  assert.ok('label' in button && button.label?.includes('somente iniciador'));
  assert.equal(matchPresentation(match({ status: 'completed' })).components.length, 0);
  assert.equal(matchPresentation(match({ status: 'cancelled' })).components.length, 0);
  assert.match(matchPresentation(match({ status: 'live' })).embeds[0].data.description!, /\/finalizar partida:42/);
});

test('draft respeita limite por posição e não inclui jogadores já escolhidos', () => {
  const value = match({ status: 'drafting', mode: 'captains', draftTurn: 'A' });
  value.players.slice(0, 4).forEach(p => { p.team = 'A'; });
  const candidates = draftCandidates(value);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(p => p.position === 'setter' && p.team === null));
  assert.ok(!candidates.some(p => p.discordId === playerId(0)));
  assert.deepEqual(draftCandidates(match()), []);
});

test('fila usa dados atuais, onboarding real, sem menções nem links injetados', () => {
  const queue = { players: Array.from({ length: 24 }, (_, i) => ({ ...player(i), queuedAt: i })), spikers: 16, setters: 8, ready: true };
  const payload = queuePresentation(queue, 'javascript:alert(1)');
  assert.match(payload.embeds[0].data.description!, /24 na fila/);
  for (const command of ['/register', '/verificar', '/fila', '/sair', '/posicao', '/profile', '/ranking']) assert.ok(payload.embeds[0].data.description!.includes(command));
  assert.equal(payload.components.length, 1);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(payload.components[0].components.length, 4);
  assert.doesNotMatch(text('@everyone **x**'), /@everyone/);
  assert.ok(text('@everyone **x**').includes('\\*'));
});

test('etapa de capitães: staff escolhe um capitão por time em dois menus com os 12 jogadores', () => {
  const stage = match({ status: 'captains', mode: 'captains' });
  const payload = matchPresentation(stage, 'https://example.com');
  const description = payload.embeds[0].data.description!;
  assert.match(description, /ESCOLHA DOS CAPITÃES/);
  assert.match(description, /staff escolhe os capitães/);
  assert.match(description, /50%/);
  const menus = payload.components.slice(0, 2).map(row => row.toJSON().components[0]);
  assert.deepEqual(menus.map(menu => 'custom_id' in menu ? menu.custom_id : ''), ['mm:m:42:cap:A', 'mm:m:42:cap:B']);
  for (const menu of menus) assert.ok('options' in menu && menu.options.length === 12 && menu.max_values === 1 && menu.min_values === 1);
  assert.equal(payload.components.length, 3);
  for (const row of payload.components) assert.doesNotThrow(() => row.toJSON());
  for (const row of matchPresentation(stage, undefined, false).components) for (const component of row.toJSON().components) assert.equal(component.disabled, true);
});

test('capitão já escolhido sai do menu do outro time e aparece no painel', () => {
  const stage = match({ status: 'captains', mode: 'captains' });
  stage.players[0].team = 'A'; stage.players[0].isCaptain = true;
  assert.equal(captainCandidates(stage, 'B').some(p => p.discordId === playerId(0)), false);
  assert.equal(captainCandidates(stage, 'B').length, 11);
  assert.equal(captainCandidates(stage, 'A').length, 12);
  assert.match(matchPresentation(stage).embeds[0].data.description!, /Capitão do Time A: \*\*Roblox\\_0\*\*/);
  assert.deepEqual(captainCandidates(match({ status: 'voting' }), 'A'), []);
});

test('draft mostra o time sorteado para o primeiro pick e o pick aleatório por tempo', () => {
  const value = match({ status: 'drafting', mode: 'captains', draftTurn: 'B', firstPick: 'B', draftDeadline: 1_800_000_045_000 });
  value.players[0].team = 'A'; value.players[0].isCaptain = true;
  value.players[1].team = 'B'; value.players[1].isCaptain = true;
  const description = matchPresentation(value).embeds[0].data.description!;
  assert.match(description, /Primeiro pick sorteado: \*\*Equipe B\*\*/);
  assert.match(description, /sorteia um jogador/);
  assert.doesNotMatch(description, /escolhe automaticamente/);
});

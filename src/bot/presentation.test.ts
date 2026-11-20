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
  assert.ok('label' in button && button.label?.includes('capitães'));
  assert.equal(matchPresentation(match({ status: 'completed' })).components.length, 0);
  assert.equal(matchPresentation(match({ status: 'cancelled' })).components.length, 0);
  assert.match(matchPresentation(match({ status: 'live' })).embeds[0].data.description!, /\/finalizar/);
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
  assert.match(payload.embeds[0].data.description!, /24\/12 na fila/);
  for (const command of ['/register', '/verificar', '/profile', '/ranking']) assert.ok(payload.embeds[0].data.description!.includes(command));
  assert.equal(payload.components.length, 1);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(payload.components[0].components.length, 2);
  assert.doesNotMatch(text('@everyone **x**'), /@everyone/);
  assert.ok(text('@everyone **x**').includes('\\*'));
});

test('etapa de capitães: modo capitães tem 1 menu de voto com os 12 jogadores', () => {
  const stage = match({ status: 'captains', mode: 'captains', captainDeadline: 1_800_000_060_000 });
  const payload = matchPresentation(stage, 'https://example.com');
  const description = payload.embeds[0].data.description!;
  assert.match(description, /ESCOLHA DOS CAPITÃES/);
  assert.match(description, /Vote no capitão/);
  const menu = payload.components[0].toJSON().components[0];
  assert.ok('custom_id' in menu && menu.custom_id === 'mm:m:42:cap:A');
  assert.ok('options' in menu && menu.options.length === 12 && menu.max_values === 1 && menu.min_values === 1);
  assert.equal(payload.components.length, 2);
  for (const row of matchPresentation(stage, undefined, false).components) for (const component of row.toJSON().components) assert.equal(component.disabled, true);
});

test('etapa de capitães nos outros modos: 1 menu por time só com os jogadores do time', () => {
  const stage = match({ status: 'captains', mode: 'balanced' });
  stage.players.forEach((p, i) => { p.team = i % 2 ? 'B' : 'A'; });
  assert.equal(captainCandidates(stage, 'A').length, 6);
  assert.ok(captainCandidates(stage, 'A').every(p => p.team === 'A'));
  assert.equal(captainCandidates(stage, null).length, 12);
  const ids = matchPresentation(stage).components.slice(0, 2).map(row => { const c = row.toJSON().components[0]; return 'custom_id' in c ? c.custom_id : ''; });
  assert.deepEqual(ids, ['mm:m:42:cap:A', 'mm:m:42:cap:B']);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { callName, planCalls } from './voice.js';
import { match, playerId } from './test-fixtures.js';

test('nome da call usa o número da partida e o time', () => {
  assert.equal(callName(12, null), '#0012 · Partida');
  assert.equal(callName(12, 'A'), '#0012 · Equipe A');
});

test('sem time vai para a call da partida; com time vai para a call do time', () => {
  const value = match({ id: 7, status: 'drafting' });
  value.players[0].team = 'A';
  value.players[1].team = 'B';
  const { targets, members } = planCalls([value]);
  const needed = new Set(members.keys());
  assert.equal(targets.get(playerId(0)), '#0007 · Equipe A');
  assert.equal(targets.get(playerId(1)), '#0007 · Equipe B');
  assert.equal(targets.get(playerId(2)), '#0007 · Partida');
  assert.deepEqual([...needed].sort(), ['#0007 · Equipe A', '#0007 · Equipe B', '#0007 · Partida']);
});

test('com todos os times definidos a call da partida deixa de ser necessária', () => {
  const value = match({ id: 7, status: 'live' });
  value.players.forEach((p, i) => { p.team = i % 2 ? 'B' : 'A'; });
  assert.deepEqual([...planCalls([value]).members.keys()].sort(), ['#0007 · Equipe A', '#0007 · Equipe B']);
  assert.equal(planCalls([]).members.size, 0);
});

test('quando o jogo acaba (votação de MVP) as calls deixam de existir', () => {
  const value = match({ id: 7, status: 'mvp' });
  value.players.forEach((p, i) => { p.team = i % 2 ? 'B' : 'A'; });
  assert.equal(planCalls([value]).members.size, 0);
  assert.equal(planCalls([value]).targets.size, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autofillDelta, MatchmakingService, pickPlayers } from './engine.js';
import { calculateElo, rankFor, RANKS } from './ranks.js';
import type { Match, Position } from './types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(count = 12, random?: (max: number) => number) {
  let time = 1_800_000_000_000;
  const service = new MatchmakingService(':memory:', { now: () => time, ownerId: 'owner', random });
  for (let index = 0; index < count; index++) {
    const id = String(index + 1);
    const link = await service.beginLink(id, `Player ${id}`, String(1000 + index), `roblox${id}`, index % 3 === 2 ? 'setter' : 'spiker');
    await service.completeLink(id, link.code);
    await service.adjustElo('owner', id, 500, 'Valor inicial do teste');
  }
  return { service, advance: (milliseconds: number) => { time += milliseconds; } };
}

async function queued(service: MatchmakingService) {
  for (const player of (await service.listPlayers()).slice(0, 12)) await service.joinQueue(player.discordId);
  return service.createMatch('staff', 'channel');
}

async function ready(service: MatchmakingService) {
  let match = await queued(service);
  // Times já saem balanceados por Elo; cada um vota em si e o desempate escolhe um capitão por time.
  for (const player of match.players) match = await service.voteCaptain(match.id, player.discordId, player.discordId);
  return match;
}

function checkTeams(match: Match) {
  for (const team of ['A', 'B']) {
    const players = match.players.filter(player => player.team === team);
    assert.equal(players.length, 6);
    assert.equal(players.filter(player => player.position === 'spiker').length, 4);
    assert.equal(players.filter(player => player.position === 'setter').length, 2);
  }
}

test('vinculação comprova descrição, impede duplicatas e expira em 15 minutos', async () => {
  const { service, advance } = await fixture(0);
  try {
    const link = await service.beginLink('1', 'Player', '123', 'Roblox', 'setter');
    await assert.rejects(service.completeLink('1', 'incorreto'), /Código não encontrado/);
    const player = await service.completeLink('1', `Descrição ${link.code}`);
    assert.equal(player.elo, 0);
    assert.equal(player.position, 'setter');
    await assert.rejects(service.beginLink('2', 'Other', '123', 'Roblox', 'setter'), /já está vinculada/);
    const second = await service.beginLink('2', 'Other', '456', 'Other', 'spiker');
    advance(900_001);
    await assert.rejects(service.completeLink('2', second.code), /expirou/);
  } finally { service.close(); }
});

test('fila sai com 12 jogadores e o último spiker a entrar toma autofill de setter', async () => {
  const { service } = await fixture();
  try {
    await service.setPosition('3', 'spiker');
    const players = await service.listPlayers();
    for (const player of players.slice(0, 11)) await service.joinQueue(player.discordId);
    assert.equal((await service.getQueue()).ready, false);
    await assert.rejects(service.createMatch('staff', 'channel'), /12 jogadores/);
    await service.joinQueue(players[11].discordId);
    assert.equal((await service.getQueue()).ready, true);
    const match = await service.createMatch('staff', 'channel');
    assert.equal(match.players.filter(p => p.position === 'spiker').length, 8);
    assert.equal(match.players.filter(p => p.position === 'setter').length, 4);
    const filled = match.players.filter(p => p.autofill);
    assert.equal(filled.length, 1);
    assert.equal(filled[0].position, 'setter');
    assert.equal((await service.getRankedPlayer(filled[0].discordId))!.position, 'spiker');
    assert.equal((await service.getQueue()).players.length, 0);
  } finally { service.close(); }
});

test('pickPlayers: 10 spikers e 2 setters viram 8+4 com os 2 últimos spikers no autofill', () => {
  const queue = Array.from({ length: 12 }, (_, i) => ({ id: i, position: (i < 10 ? 'spiker' : 'setter') as Position }));
  const picked = pickPlayers(queue)!;
  assert.deepEqual(picked.filter(p => p.autofill).map(p => [p.id, p.position]), [[8, 'setter'], [9, 'setter']]);
  assert.equal(pickPlayers(queue.slice(1)), null);
  const setters = Array.from({ length: 12 }, (_, i) => ({ id: i, position: (i < 6 ? 'setter' : 'spiker') as Position }));
  assert.deepEqual(pickPlayers(setters)!.filter(p => p.autofill).map(p => [p.id, p.position]), [[4, 'spiker'], [5, 'spiker']]);
});

test('autofill ganha o dobro e perde metade', () => {
  assert.equal(autofillDelta(20), 40);
  assert.equal(autofillDelta(-15), -7);
  assert.equal(autofillDelta(-1), 0);
  assert.equal(autofillDelta(0), 0);
});

test('fila impede duplicação, posição durante partida e duas partidas por pessoa', async () => {
  const { service } = await fixture();
  try {
    await service.joinQueue('1');
    await assert.rejects(service.joinQueue('1'), /já está na fila/);
    await service.leaveQueue('1');
    await queued(service);
    await assert.rejects(service.joinQueue('1'), /partida em andamento/);
    await assert.rejects(service.setPosition('1', 'setter'), /durante uma partida/);
  } finally { service.close(); }
});

test('duas partidas reservam grupos distintos sem perder jogadores da fila', async () => {
  const { service } = await fixture(24);
  try {
    const players = await service.listPlayers();
    for (const player of players.slice(0, 12)) await service.joinQueue(player.discordId);
    await assert.rejects(service.joinQueue(players[12].discordId), /cheia/);
    const first = await service.createMatch('staff', 'channel');
    assert.equal((await service.getQueue()).players.length, 0);
    for (const player of players.slice(12)) await service.joinQueue(player.discordId);
    const second = await service.createMatch('staff2', 'channel');
    const unique = new Set([...first.players, ...second.players].map(player => player.discordId));
    assert.equal(unique.size, 24);
    assert.equal((await service.getQueue()).players.length, 0);
    assert.equal((await service.getActiveMatches()).length, 2);
  } finally { service.close(); }
});

test('histórico filtra participante antes de paginar e conta todas as partidas', async () => {
  const { service, advance } = await fixture(24);
  try {
    let first = await queued(service);
    for (const player of first.players) first = await service.voteCaptain(first.id, player.discordId, player.discordId);
    await service.startMatch(first.id, 'staff');
    await service.finishMatch(first.id, 'staff', 'A');
    advance(60_000);
    await service.tick();
    for (const player of (await service.listPlayers()).filter(p => !first.players.some(f => f.discordId === p.discordId))) await service.joinQueue(player.discordId);
    let second = await service.createMatch('staff', 'channel');
    for (const player of second.players) second = await service.voteCaptain(second.id, player.discordId, player.discordId);
    await service.startMatch(second.id, 'staff');
    await service.finishMatch(second.id, 'staff', 'B');
    advance(60_000);
    await service.tick();
    assert.equal(await service.countMatches({ status: 'completed' }), 2);
    assert.equal((await service.listMatches(1))[0].id, second.id);
    assert.equal((await service.listMatches(1, {}, 1))[0].id, first.id);
    const id = first.players[0].discordId;
    assert.equal((await service.listMatches(1, { playerId: id }))[0].id, first.id);
    assert.equal((await service.getProfile(id))!.history[0].id, first.id);
    assert.equal(await service.countMatches({ playerId: id }), 1);
  } finally { service.close(); }
});

test('VIP é registrado na formação e aplicado ao resultado sem bônus nas perdas', async () => {
  const { service, advance } = await fixture();
  try {
    await service.grantVip('staff', '1', 'vip', 1);
    await service.grantVip('staff', '2', 'vip_plus', 1);
    const match = await ready(service);
    const winner = match.players.find(player => player.discordId === '1')!.team!;
    await service.startMatch(match.id, 'staff');
    advance(86_400_000);
    assert.equal((await service.getPlayer('1'))!.vip, 'none');
    await service.finishMatch(match.id, 'staff', winner);
    advance(60_000);
    const completed = (await service.tick())[0];
    assert.equal(completed.players.find(player => player.discordId === '1')!.eloDelta, 35);
    const vipPlus = completed.players.find(player => player.discordId === '2')!;
    assert.equal(vipPlus.eloDelta, vipPlus.team === winner ? 37 : -18);
  } finally { service.close(); }
});

test('equilíbrio respeita funções e encontra diferença mínima possível', async () => {
  const { service } = await fixture();
  try {
    for (const player of (await service.listPlayers()).slice(0, 6)) await service.adjustElo('owner', player.discordId, 400, 'Diferença para balanceamento');
    const match = await ready(service);
    checkTeams(match);
    const sum = (team: string) => match.players.filter(player => player.team === team).reduce((total, player) => total + player.elo, 0);
    assert.equal(sum('A'), sum('B'));
  } finally { service.close(); }
});

test('modo balanceado: voto de capitão só vale para o próprio time e capitão pode iniciar', async () => {
  const { service } = await fixture();
  try {
    let match = await queued(service);
    const a = match.players.filter(player => player.team === 'A');
    const b = match.players.filter(player => player.team === 'B');
    await assert.rejects(service.voteCaptain(match.id, a[0].discordId, b[0].discordId), /seu time/);
    for (const player of match.players) match = await service.voteCaptain(match.id, player.discordId, player.team === 'A' ? a[1].discordId : b[2].discordId);
    assert.equal(match.status, 'ready');
    assert.deepEqual(match.players.filter(player => player.isCaptain).map(player => player.discordId).sort(), [a[1].discordId, b[2].discordId].sort());
    assert.equal((await service.startMatch(match.id, b[2].discordId)).status, 'live');
  } finally { service.close(); }
});

test('MVP pode ser perdedor, sem autovoto, Elo aplica uma única vez após 60s', async () => {
  const { service, advance } = await fixture();
  try {
    const match = await ready(service);
    await service.startMatch(match.id, 'staff');
    await service.finishMatch(match.id, 'staff', 'A');
    const loser = match.players.find(player => player.team === 'B')!;
    const voter = match.players.find(player => player.team === 'A')!;
    await assert.rejects(service.voteMvp(match.id, loser.discordId, loser.discordId), /si mesmo/);
    await assert.rejects(service.voteMvp(match.id, 'outsider', loser.discordId), /Somente os 12/);
    await service.voteMvp(match.id, voter.discordId, loser.discordId);
    assert.equal((await service.getPlayer(loser.discordId))!.matches, 0);
    advance(59_999);
    assert.deepEqual(await service.tick(), []);
    advance(1);
    const completed = (await service.tick())[0];
    assert.equal(completed.mvpId, loser.discordId);
    assert.equal(completed.status, 'completed');
    assert.equal((await service.getPlayer(loser.discordId))!.elo, 486);
    assert.equal((await service.getPlayer(loser.discordId))!.mvps, 1);
    assert.equal((await service.getPlayer(voter.discordId))!.elo, 532);
    assert.deepEqual(await service.tick(), []);
    assert.equal((await service.getPlayer(voter.discordId))!.matches, 1);
    await assert.rejects(service.voteMvp(match.id, voter.discordId, loser.discordId), /já terminou/);
  } finally { service.close(); }
});

test('sem votos não inventa MVP; todos os 12 votos encerram antes do prazo', async () => {
  const { service, advance } = await fixture();
  try {
    let match = await ready(service);
    await service.startMatch(match.id, 'staff');
    await service.finishMatch(match.id, 'staff', 'A');
    advance(60_000);
    assert.equal((await service.tick())[0].mvpId, null);
    match = await ready(service);
    await service.startMatch(match.id, 'staff');
    await service.finishMatch(match.id, 'staff', 'B');
    for (let index = 0; index < 12; index++) match = await service.voteMvp(match.id, match.players[index].discordId, match.players[(index + 1) % 12].discordId);
    assert.equal(match.status, 'completed');
    assert.ok(match.mvpId);
    assert.equal((await service.listPlayers()).reduce((sum, player) => sum + player.mvps, 0), 1);
  } finally { service.close(); }
});

test('cancelamento libera participantes sem mexer em Elo ou estatísticas', async () => {
  const { service } = await fixture();
  try {
    const match = await ready(service);
    await service.cancelMatch(match.id, 'owner');
    assert.equal((await service.getPlayer('1'))!.matches, 0);
    assert.equal((await service.getPlayer('1'))!.elo, 500);
    assert.equal((await service.joinQueue('1')).players.length, 1);
  } finally { service.close(); }
});

test('VIP tem validade, renovação cumulativa e bônus não altera derrotas', async () => {
  const { service, advance } = await fixture();
  try {
    const first = await service.grantVip('staff', '1', 'vip', 1);
    const renewed = await service.grantVip('staff', '1', 'vip', 1);
    assert.equal(renewed.vipExpiresAt! - first.vipExpiresAt!, 86_400_000);
    advance(2 * 86_400_000);
    assert.equal((await service.getPlayer('1'))!.vip, 'none');
    const input = { elo: 500, teamAverage: 500, opponentAverage: 500, mvp: false };
    assert.equal(calculateElo({ ...input, won: true, vip: 'none' }).delta, 32);
    assert.equal(calculateElo({ ...input, won: true, vip: 'vip' }).delta, 35);
    assert.equal(calculateElo({ ...input, won: true, vip: 'vip_plus' }).delta, 37);
    assert.equal(calculateElo({ ...input, won: false, vip: 'vip_plus' }).delta, -18);
  } finally { service.close(); }
});

test('ajuste de Elo só proprietário, com motivo e fora de partidas ativas', async () => {
  const { service } = await fixture();
  try {
    await assert.rejects(service.adjustElo('staff', '1', 20, 'Revisão da partida'), /proprietário/);
    await assert.rejects(service.adjustElo('owner', '1', 20, ''), /motivo/);
    await service.adjustElo('owner', '1', -500, 'Revisão da partida');
    await service.adjustElo('owner', '1', -100, 'Revisão da partida');
    assert.equal((await service.getPlayer('1'))!.elo, 0);
    await queued(service);
    await assert.rejects(service.adjustElo('owner', '1', 20, 'Revisão da partida'), /terminar/);
  } finally { service.close(); }
});

test('Elo recompensa surpresa, protege Bronze e nunca fica negativo', () => {
  const input = { elo: 500, teamAverage: 500, opponentAverage: 500, mvp: false, vip: 'none' as const };
  assert.ok(calculateElo({ ...input, opponentAverage: 1000, won: true }).delta > calculateElo({ ...input, won: true }).delta);
  assert.ok(calculateElo({ ...input, opponentAverage: 1000, won: false }).delta > calculateElo({ ...input, won: false }).delta);
  assert.equal(calculateElo({ ...input, elo: 100, won: false }).delta, -10);
  assert.equal(calculateElo({ ...input, elo: 3, won: false }).delta, -3);
  assert.equal(calculateElo({ ...input, elo: 0, won: false }).delta, 0);
  for (const elo of [0, 3, 7, 10, 100, 500]) {
    const withoutMvp = calculateElo({ ...input, elo, won: false }).delta;
    const withMvp = calculateElo({ ...input, elo, won: false, mvp: true }).delta;
    assert.equal(withMvp - withoutMvp, 4);
  }
});

test('escada de 25 patentes: Silver I–III, Emerald entre Platinum e Diamond, topo Challenger', () => {
  assert.equal(RANKS.length, 25);
  assert.equal(RANKS.filter(rank => rank.tier === 'Bronze').length, 3);
  assert.equal(RANKS.filter(rank => rank.tier === 'Silver').length, 3);
  assert.equal(RANKS.filter(rank => rank.tier === 'Emerald').length, 4);
  assert.equal(rankFor(0).rank.name, 'Bronze I');
  assert.equal(rankFor(350).rank.name, 'Silver I');
  assert.equal(rankFor(350).progress, 50);
  assert.equal(rankFor(2199).rank.name, 'Diamond IV');
  assert.equal(rankFor(2200).rank.name, 'Master');
  assert.equal(rankFor(2500).rank.name, 'Grandmaster');
  assert.equal(rankFor(2800).rank.name, 'Challenger');
  assert.equal(rankFor(5000).nextRank, null);
});

test('reinício recupera prazos e não duplica Elo já distribuído', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mm42-test-'));
  const database = join(directory, 'persistence.sqlite');
  let time = 1_800_000_000_000;
  let service = new MatchmakingService(database, { now: () => time, ownerId: 'owner' });
  try {
    for (let index = 1; index <= 12; index++) {
      const link = await service.beginLink(String(index), `Player${index}`, String(index + 1000), `Roblox${index}`, index % 3 === 0 ? 'setter' : 'spiker');
      await service.completeLink(String(index), link.code);
    }
    const match = await queued(service);
    await service.attachMessage(match.id, 'channel', 'message');
    service.close();
    time += 30_000;
    service = new MatchmakingService(database, { now: () => time, ownerId: 'owner' });
    assert.equal((await service.tick())[0].status, 'ready');
    assert.equal((await service.getMatch(match.id))!.messageId, 'message');
    await service.startMatch(match.id, 'staff');
    await service.finishMatch(match.id, 'staff', 'A');
    service.close();
    time += 60_000;
    service = new MatchmakingService(database, { now: () => time, ownerId: 'owner' });
    assert.equal((await service.tick())[0].status, 'completed');
    const elo = (await service.getPlayer('1'))!.elo;
    service.close();
    service = new MatchmakingService(database, { now: () => time, ownerId: 'owner' });
    assert.deepEqual(await service.tick(), []);
    assert.equal((await service.getPlayer('1'))!.matches, 1);
    assert.equal((await service.getPlayer('1'))!.elo, elo);
  } finally {
    service.close();
    // no Windows o binding nativo só libera o arquivo após GC e um tick (--expose-gc no script de teste)
    for (let attempt = 0; attempt < 5; attempt++) {
      (globalThis as { gc?: () => void }).gc?.();
      await new Promise(resolve => setTimeout(resolve, 25));
      try { rmSync(directory, { recursive: true, force: true }); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt === 4) throw error; }
    }
  }
});

test('contas pendentes não podem reassociar um Roblox já verificado', async () => {
  const { service } = await fixture(0);
  try {
    const first = await service.beginLink('a', 'First', '123', 'Roblox', 'spiker');
    const second = await service.beginLink('b', 'Second', '123', 'Roblox', 'setter');
    await service.completeLink('a', first.code);
    await assert.rejects(service.completeLink('b', second.code), /já está vinculada/);
    assert.equal((await service.listPlayers()).length, 1);
  } finally { service.close(); }
});

test('capitães confirmam o vencedor; discordância espera a staff', async () => {
  const { service } = await fixture();
  try {
    let match = await ready(service);
    match = await service.startMatch(match.id, 'staff');
    const [a, b] = (['A', 'B'] as const).map(team => match.players.find(p => p.isCaptain && p.team === team)!.discordId);
    const other = match.players.find(p => !p.isCaptain)!.discordId;
    await assert.rejects(service.reportResult(match.id, other, 'A'), /capitães/);
    match = await service.reportResult(match.id, a, 'A');
    assert.equal(match.status, 'live');
    match = await service.reportResult(match.id, b, 'B');
    assert.equal(match.status, 'live');
    match = await service.reportResult(match.id, b, 'A');
    assert.equal(match.status, 'mvp');
    assert.equal(match.winner, 'A');
  } finally { service.close(); }
});

test('vaga parada na fila por 30 minutos é liberada', async () => {
  const { service, advance } = await fixture();
  try {
    await service.joinQueue('1');
    advance(29 * 60_000);
    await service.tick();
    assert.equal((await service.getQueue()).players.length, 1);
    advance(60_000 + 1);
    await service.tick();
    assert.equal((await service.getQueue()).players.length, 0);
  } finally { service.close(); }
});

test('operações concorrentes não usam a transação umas das outras', async () => {
  const { service } = await fixture();
  try {
    const players = await service.listPlayers();
    await Promise.all([
      ...players.map(player => service.joinQueue(player.discordId)),
      ...Array.from({ length: 10 }, () => service.tick()),
      ...Array.from({ length: 10 }, () => service.getActiveMatches()),
    ]);
    assert.equal((await service.getQueue()).players.length, 12);
  } finally { service.close(); }
});

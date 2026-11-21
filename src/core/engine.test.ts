import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autofillDelta, autofillGain, MatchmakingService, pickPlayers } from './engine.js';
import { applyLp, calculateElo, ladderRanks, rankFor, RANKS, START_ELO } from './ranks.js';
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
    await service.adjustElo('owner', id, 300, 'Valor inicial do teste');
  }
  return { service, advance: (milliseconds: number) => { time += milliseconds; } };
}

async function queued(service: MatchmakingService) {
  for (const player of (await service.listPlayers()).slice(0, 12)) await service.joinQueue(player.discordId);
  return service.createMatch('staff', 'channel');
}

async function ready(service: MatchmakingService) {
  let match = await queued(service);
  // Cada um vota em si; o desempate escolhe os 2 capitães, que montam os times no draft.
  for (const player of match.players) match = await service.setReady(match.id, player.discordId);
  for (const player of match.players) match = await service.voteCaptain(match.id, player.discordId, player.discordId);
  return draft(service, match);
}

/** Capitães escolhem até fechar os times, sempre o primeiro jogador que cabe. */
async function draft(service: MatchmakingService, match: Match) {
  for (const player of match.players) if (!player.ready) match = await service.setReady(match.id, player.discordId);
  while (match.status === 'drafting') {
    const captain = match.players.find(p => p.isCaptain && p.team === match.draftTurn)!;
    for (const candidate of match.players.filter(p => p.team === null)) {
      try { match = await service.pick(match.id, captain.discordId, candidate.discordId); break; } catch { /* não cabe na composição */ }
    }
  }
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
    assert.equal(player.elo, 200);
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
    for (const player of first.players) first = await service.setReady(first.id, player.discordId);
    for (const player of first.players) first = await service.voteCaptain(first.id, player.discordId, player.discordId);
    first = await draft(service, first);
    await service.startMatch(first.id, 'staff');
    await service.finishMatch(first.id, 'staff', 'A');
    advance(60_000);
    await service.tick();
    for (const player of (await service.listPlayers()).filter(p => !first.players.some(f => f.discordId === p.discordId))) await service.joinQueue(player.discordId);
    let second = await service.createMatch('staff', 'channel');
    for (const player of second.players) second = await service.setReady(second.id, player.discordId);
    for (const player of second.players) second = await service.voteCaptain(second.id, player.discordId, player.discordId);
    second = await draft(service, second);
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
    // Calibração: 2 × 20 PDL, +10% VIP / +15% VIP+ só na vitória.
    assert.equal(completed.players.find(player => player.discordId === '1')!.eloDelta, 44);
    const vipPlus = completed.players.find(player => player.discordId === '2')!;
    assert.equal(vipPlus.eloDelta, vipPlus.team === winner ? 46 : -40);
  } finally { service.close(); }
});

test('jogadores votam e os 2 mais votados viram capitães e fazem o draft', async () => {
  const { service, advance } = await fixture();
  try {
    const match = await queued(service);
    assert.equal(match.status, 'captains');
    assert.equal(match.players.filter(p => p.team !== null).length, 0);
    await assert.rejects(service.voteCaptain(match.id, '1', '5'), /confirmarem presença/);
    for (const p of match.players) await service.setReady(match.id, p.discordId);
    await service.voteCaptain(match.id, '1', '5');
    await service.voteCaptain(match.id, '2', '5');
    await service.voteCaptain(match.id, '3', '9');
    advance(30_000);
    const [resolved] = await service.tick();
    assert.equal(resolved.status, 'drafting');
    assert.deepEqual(resolved.players.filter(p => p.isCaptain).map(p => p.discordId).sort(), ['5', '9']);
    checkTeams(await draft(service, resolved));
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
    // 500 = Prata I com 0 PDL: a derrota (−40 + 4 de MVP) rebaixa para Prata II.
    assert.equal((await service.getPlayer(loser.discordId))!.elo, 464);
    assert.equal((await service.getPlayer(loser.discordId))!.mvps, 1);
    assert.equal((await service.getPlayer(voter.discordId))!.elo, 540);
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
    const input = { elo: 500, mmr: 500, teamAverage: 500, opponentAverage: 500, mvp: false };
    assert.equal(calculateElo({ ...input, won: true, vip: 'none' }).delta, 20);
    assert.equal(calculateElo({ ...input, won: true, vip: 'vip' }).delta, 22);
    assert.equal(calculateElo({ ...input, won: true, vip: 'vip_plus' }).delta, 23);
    assert.equal(calculateElo({ ...input, won: false, vip: 'vip_plus' }).delta, -20);
    assert.equal(calculateElo({ ...input, won: true, vip: 'none', calibrating: true }).delta, 40);
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

test('PDL: ±20 parelho, time mais forte vale mais, MVP soma 4 e o MMR anda com K=32', () => {
  const input = { elo: 500, mmr: 500, teamAverage: 500, opponentAverage: 500, mvp: false, vip: 'none' as const };
  assert.equal(calculateElo({ ...input, won: false }).delta, -20);
  assert.equal(calculateElo({ ...input, won: true }).mmrDelta, 16);
  assert.equal(calculateElo({ ...input, won: false }).mmrDelta, -16);
  assert.ok(calculateElo({ ...input, opponentAverage: 700, won: true }).delta > 20);
  assert.ok(calculateElo({ ...input, opponentAverage: 700, won: false }).delta > -20);
  assert.equal(calculateElo({ ...input, won: false, mvp: true }).delta, -16);
  assert.equal(calculateElo({ ...input, won: true, mvp: true }).delta, 24);
});

test('MMR acima do rank ganha mais e perde menos; abaixo, o contrário', () => {
  const even = { teamAverage: 500, opponentAverage: 500, mvp: false, vip: 'none' as const };
  assert.equal(calculateElo({ ...even, elo: 400, mmr: 500, won: true }).delta, 30);
  assert.equal(calculateElo({ ...even, elo: 400, mmr: 500, won: false }).delta, -10);
  assert.equal(calculateElo({ ...even, elo: 600, mmr: 500, won: true }).delta, 10);
  assert.equal(calculateElo({ ...even, elo: 600, mmr: 500, won: false }).delta, -30);
  // A diferença conta até 100 de MMR.
  assert.equal(calculateElo({ ...even, elo: 0, mmr: 500, won: true }).delta, 30);
});

test('promoção aos 100 PDL, perda para no 0 e com 0 PDL rebaixa, sem proteção', () => {
  assert.equal(rankFor(290).rank.name, 'Bronze I');
  assert.equal(rankFor(applyLp(290, 20)).rank.name, 'Silver III');
  assert.equal(rankFor(applyLp(290, 20)).lp, 10);
  assert.equal(applyLp(310, -20), 300);
  assert.equal(rankFor(300).rank.name, 'Silver III');
  assert.equal(applyLp(300, -20), 280);
  assert.equal(rankFor(280).rank.name, 'Bronze I');
  assert.equal(rankFor(280).lp, 80);
  assert.equal(applyLp(0, -20), 0);
  assert.equal(applyLp(5, -20), 0);
  // Mestre não tem divisões: o piso é 0 PDL do Mestre, depois cai para Diamante I.
  assert.equal(applyLp(2350, -200), 2200);
  assert.equal(rankFor(applyLp(2200, -20)).rank.name, 'Diamond I');
});

test('Desafiante = 10 primeiros com 300+ PDL; Grão-Mestre = 20 seguintes com 100+', () => {
  const players = [...Array.from({ length: 35 }, (_, index) => ({ elo: 2900 - index * 10 })), { elo: 2250 }, { elo: 2000 }];
  const names = ladderRanks(players).map(info => info.rank.name);
  assert.deepEqual(names.slice(0, 10), Array(10).fill('Challenger'));
  assert.deepEqual(names.slice(10, 30), Array(20).fill('Grandmaster'));
  assert.deepEqual(names.slice(30), [...Array(6).fill('Master'), 'Diamond II']);
  // Sem o PDL mínimo a vaga fica vazia: 250 PDL no topo é Grão-Mestre, 50 PDL é Mestre.
  assert.deepEqual(ladderRanks([{ elo: 2450 }, { elo: 2250 }]).map(info => info.rank.name), ['Grandmaster', 'Master']);
});

test('migração: o Elo atual vira tier + divisão + PDL sem perder nada', () => {
  assert.deepEqual([START_ELO, 263, 199, 100, 0].map(elo => { const info = rankFor(elo); return `${info.rank.name} ${info.lp}`; }),
    ['Bronze I 0', 'Bronze I 63', 'Bronze II 99', 'Bronze II 0', 'Bronze III 0']);
  for (let elo = 0; elo < 2200; elo += 37) assert.equal(rankFor(elo).rank.min + rankFor(elo).lp, elo);
});

test('escada de 25 patentes: divisões como no LoL (IV/III embaixo, I no topo), topo Challenger', () => {
  assert.equal(RANKS.length, 25);
  assert.equal(RANKS.filter(rank => rank.tier === 'Bronze').length, 3);
  assert.equal(RANKS.filter(rank => rank.tier === 'Silver').length, 3);
  assert.equal(RANKS.filter(rank => rank.tier === 'Emerald').length, 4);
  assert.equal(rankFor(0).rank.name, 'Bronze III');
  assert.equal(rankFor(350).rank.name, 'Silver III');
  assert.equal(rankFor(350).progress, 50);
  assert.equal(rankFor(600).rank.name, 'Gold IV');
  assert.equal(rankFor(2199).rank.name, 'Diamond I');
  assert.equal(rankFor(2200).rank.name, 'Master');
  // Só o ranking dá Grão-Mestre/Desafiante; pela escada o topo é Mestre com PDL sem teto.
  assert.equal(rankFor(5000).rank.name, 'Master');
  assert.equal(rankFor(5000).lp, 2800);
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
    for (const p of match.players) await service.setReady(match.id, p.discordId);
    await service.attachMessage(match.id, 'channel', 'message');
    service.close();
    time += 30_000;
    service = new MatchmakingService(database, { now: () => time, ownerId: 'owner' });
    assert.equal((await service.tick())[0].status, 'drafting');
    await draft(service, (await service.getMatch(match.id))!);
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

test('quem sai ou não confirma em 2 min é trocado por alguém da fila na mesma vaga', async () => {
  const { service, advance } = await fixture(14);
  try {
    let match = await queued(service);
    const [stay, quitter, afk] = match.players.slice(2, 5);
    const bench = (await service.listPlayers()).filter(p => !match.players.some(m => m.discordId === p.discordId));
    for (const p of bench) await service.joinQueue(p.discordId);
    await service.setReady(match.id, stay.discordId);
    await service.leaveMatch(match.id, quitter.discordId);
    await assert.rejects(service.substitute(match.id, 'staff', afk.discordId, bench[0].discordId), /2 minutos/);
    await assert.rejects(service.substitute(match.id, 'staff', stay.discordId, bench[0].discordId), /2 minutos/);
    match = await service.substitute(match.id, 'staff', quitter.discordId, bench[0].discordId);
    const slot = match.players.find(p => p.discordId === bench[0].discordId)!;
    assert.equal(slot.position, quitter.position);
    assert.equal(slot.ready, true);
    advance(2 * 60_000);
    match = await service.substitute(match.id, 'staff', afk.discordId, bench[1].discordId);
    assert.ok(!match.players.some(p => p.discordId === afk.discordId));
    assert.equal((await service.getQueue()).players.length, 0);
  } finally { service.close(); }
});

test('2x do autofill só para quem é novo ou fraco na role; derrota sempre pela metade', () => {
  assert.equal(autofillGain(16, { elo: 1000, games: 3 }, 1000), 32);
  assert.equal(autofillGain(16, { elo: 850, games: 40 }, 1000), 32);
  assert.equal(autofillGain(16, { elo: 1000, games: 40 }, 1000), 16);
  assert.equal(autofillGain(-16, { elo: 1000, games: 40 }, 1000), -8);
});

test('autofill no PDL: vitória 2x para quem é novo na role; o MMR geral anda só metade', async () => {
  const { service, advance } = await fixture();
  try {
    await service.setPosition('3', 'spiker');
    const match = await ready(service);
    const filled = match.players.find(p => p.autofill)!;
    await service.startMatch(match.id, 'staff');
    await service.finishMatch(match.id, 'staff', filled.team!);
    advance(60_000);
    const done = (await service.tick())[0];
    assert.equal(done.players.find(p => p.discordId === filled.discordId)!.eloDelta, 80);
    assert.equal((await service.getPlayer(filled.discordId))!.mmr, 516);
  } finally { service.close(); }
});

test('denúncia: até 3 jogadores da partida entram no mesmo ticket, sem repetição', async () => {
  const { service } = await fixture();
  try {
    const match = await ready(service);
    const [accused, a, b, c, d] = match.players.map(player => player.discordId);
    const reason = 'Saiu da quadra e ficou parado o set inteiro.';
    await assert.rejects(service.openReport(match.id, a, accused, reason), /durante a partida/);
    await service.startMatch(match.id, 'staff');
    await assert.rejects(service.openReport(match.id, 'outsider', accused, reason), /Somente os 12/);
    await assert.rejects(service.openReport(match.id, a, 'outsider', reason), /precisa estar nesta partida/);
    await assert.rejects(service.openReport(match.id, a, a, reason), /a si mesmo/);
    await assert.rejects(service.openReport(match.id, a, accused, 'curto'), /10 a 500/);
    const first = await service.openReport(match.id, a, accused, reason);
    assert.equal(first.created, true);
    await assert.rejects(service.openReport(match.id, a, accused, reason), /já denunciou/);
    const second = await service.openReport(match.id, b, accused, reason);
    assert.equal(second.created, false);
    assert.equal(second.report.id, first.report.id);
    await service.openReport(match.id, c, accused, reason);
    await assert.rejects(service.openReport(match.id, d, accused, reason), /já tem 3 denúncias/);
    assert.deepEqual((await service.getReport(first.report.id))!.reporters.map(r => r.id), [a, b, c]);
  } finally { service.close(); }
});

test('denúncia: prazo de 24h após a partida; partida cancelada não aceita', async () => {
  const { service, advance } = await fixture();
  try {
    let match = await ready(service);
    await service.startMatch(match.id, 'staff');
    await service.finishMatch(match.id, 'staff', 'A');
    advance(60_000);
    await service.tick();
    match = (await service.getMatch(match.id))!;
    assert.equal(match.status, 'completed');
    const [accused, a, b] = match.players.map(player => player.discordId);
    advance(24 * 60 * 60_000 - 60_000);
    await service.openReport(match.id, a, accused, 'Xingou o time inteiro no chat.');
    advance(60_001);
    await assert.rejects(service.openReport(match.id, b, accused, 'Xingou o time inteiro no chat.'), /24 horas/);
  } finally { service.close(); }
  const other = await fixture();
  try {
    const match = await queued(other.service);
    await other.service.cancelMatch(match.id, 'staff');
    await assert.rejects(other.service.openReport(match.id, match.players[1].discordId, match.players[0].discordId, 'Motivo bem descrito.'), /canceladas/);
  } finally { other.service.close(); }
});

test('denúncia: partes não votam, 2 votos encerram, maioria suspende da fila', async () => {
  const { service, advance } = await fixture(13);
  try {
    const match = await ready(service);
    await service.startMatch(match.id, 'staff');
    const [accused, reporter] = match.players.map(player => player.discordId);
    const { report } = await service.openReport(match.id, reporter, accused, 'Entregou o jogo de propósito.');
    await assert.rejects(service.voteReport(report.id, accused, 'innocent'), /parte deste caso/);
    await assert.rejects(service.voteReport(report.id, reporter, 'susp:3'), /parte deste caso/);
    await assert.rejects(service.voteReport(report.id, 'c1', 'ban' as never), /inválido/);
    await service.voteReport(report.id, 'c1', 'innocent');
    await assert.rejects(service.closeReport(report.id, 'c1'), /pelo menos 2 votos/);
    await service.voteReport(report.id, 'c1', 'susp:3');
    await service.voteReport(report.id, 'c2', 'susp:3');
    await service.voteReport(report.id, 'c3', 'warning');
    // Suspensão tira da fila: o 13º jogador está na fila e é testado abaixo pelo próprio acusado.
    await service.finishMatch(match.id, 'staff', 'A');
    advance(60_000);
    await service.tick();
    await service.joinQueue(accused);
    const closed = await service.closeReport(report.id, 'c1');
    assert.equal(closed.status, 'closed');
    assert.equal(closed.verdict, 'susp:3');
    assert.equal(closed.decidedBy, 'council');
    assert.equal((await service.getQueue()).players.some(p => p.discordId === accused), false);
    await assert.rejects(service.joinQueue(accused), /suspenso da fila/);
    advance(3 * 86_400_000);
    await service.joinQueue(accused);
    await assert.rejects(service.closeReport(report.id, 'c1'), /já foi encerrado/);
    await assert.rejects(service.voteReport(report.id, 'c4', 'warning'), /já foi encerrado/);
  } finally { service.close(); }
});

test('denúncia: perda de Elo não passa de zero; empate vai para o admin', async () => {
  const { service } = await fixture();
  try {
    const accused = '1';
    const start = (await service.getPlayer(accused))!.elo;
    if (start !== 60) await service.adjustElo('owner', accused, 60 - start, 'Elo conhecido para o teste');
    const match = await ready(service);
    await service.startMatch(match.id, 'staff');
    const [reporter, other] = match.players.map(player => player.discordId).filter(id => id !== accused);
    const before = (await service.getPlayer(accused))!.elo;
    const elo = (await service.openReport(match.id, reporter, accused, 'Ofendeu o capitão adversário.')).report;
    await service.voteReport(elo.id, 'c1', 'elo:100');
    await service.voteReport(elo.id, 'c2', 'elo:100');
    await service.closeReport(elo.id, 'c2');
    assert.equal((await service.getPlayer(accused))!.elo, 0);
    assert.equal((await service.getProfile(accused))!.eloHistory.at(-1)!.delta, -before);

    const tie = (await service.openReport(match.id, reporter, other, 'Ficou ausente metade da partida.')).report;
    await assert.rejects(service.decideReport(tie.id, 'admin', 'warning'), /em votação/);
    await service.voteReport(tie.id, 'c1', 'warning');
    await service.voteReport(tie.id, 'c2', 'innocent');
    const tied = await service.closeReport(tie.id, 'c1');
    assert.equal(tied.status, 'tied');
    await assert.rejects(service.voteReport(tie.id, 'c3', 'warning'), /empatou/);
    const decided = await service.decideReport(tie.id, 'admin', 'warning');
    assert.equal(decided.decidedBy, 'admin');
    assert.equal((await service.getPlayer(other))!.warnings, 1);
    await assert.rejects(service.decideReport(tie.id, 'admin', 'innocent'), /já foi encerrado/);
  } finally { service.close(); }
});

test('staff verifica manualmente pelo nick e ID, sem código, e não duplica conta Roblox', async () => {
  const { service } = await fixture(0);
  try {
    const player = await service.manualLink('staff', '50', 'Manual', '777', 'NickRoblox', 'setter');
    assert.equal(player.robloxName, 'NickRoblox');
    assert.equal(player.position, 'setter');
    assert.equal(player.elo, 200);
    await assert.rejects(service.manualLink('staff', '51', 'Outro', '777', 'NickRoblox', 'spiker'), /já está vinculada/);
  } finally { service.close(); }
});

async function settled(winner: 'A' | 'B') {
  // Sorteio fixo: as duas partidas comparadas no teste de inversão saem com os mesmos times.
  const { service, advance } = await fixture(12, () => 0);
  const match = await ready(service);
  await service.startMatch(match.id, 'staff');
  await service.finishMatch(match.id, 'staff', winner);
  advance(60_000);
  await service.tick();
  return { service, advance, match: (await service.getMatch(match.id))! };
}

test('recurso: só o capitão que perdeu, uma vez por partida, até 24h; quem jogou não vota', async () => {
  const { service, advance, match } = await settled('A');
  try {
    const loser = match.players.find(p => p.isCaptain && p.team === 'B')!.discordId;
    const winner = match.players.find(p => p.isCaptain && p.team === 'A')!.discordId;
    const player = match.players.find(p => !p.isCaptain && p.team === 'B')!.discordId;
    const reason = 'Ganhamos por 25 a 20, o capitão marcou errado.';
    await assert.rejects(service.openContest(match.id, winner, reason), /capitão do time que perdeu/);
    await assert.rejects(service.openContest(match.id, player, reason), /capitão do time que perdeu/);
    const contest = await service.openContest(match.id, loser, reason);
    assert.equal(contest.kind, 'result');
    assert.equal(contest.claimedWinner, 'B');
    await assert.rejects(service.openContest(match.id, loser, reason), /já foi contestado/);
    await assert.rejects(service.voteReport(contest.id, player, 'reverse'), /jogou esta partida/);
    await assert.rejects(service.voteReport(contest.id, 'c1', 'warning'), /inválido/);
    await service.voteReport(contest.id, 'c1', 'keep');
    await service.voteReport(contest.id, 'c2', 'keep');
    const before = await service.listPlayers();
    assert.equal((await service.closeReport(contest.id, 'c1')).verdict, 'keep');
    assert.deepEqual(await service.listPlayers(), before);
    assert.equal((await service.getMatch(match.id))!.winner, 'A');
    advance(24 * 60 * 60_000);
    const other = await settled('A');
    try {
      other.advance(24 * 60 * 60_000 + 1);
      const captain = other.match.players.find(p => p.isCaptain && p.team === 'B')!.discordId;
      await assert.rejects(other.service.openContest(other.match.id, captain, reason), /prazo/);
    } finally { other.service.close(); }
  } finally { service.close(); }
});

test('recurso aceito: inverter dá o mesmo Elo e estatísticas que o outro time ter vencido', async () => {
  const reversed = await settled('A');
  const direct = await settled('B');
  try {
    const captain = reversed.match.players.find(p => p.isCaptain && p.team === 'B')!.discordId;
    const contest = await reversed.service.openContest(reversed.match.id, captain, 'O placar final foi 25 a 23 para nós.');
    await reversed.service.voteReport(contest.id, 'c1', 'reverse');
    await reversed.service.voteReport(contest.id, 'c2', 'reverse');
    const closed = await reversed.service.closeReport(contest.id, 'c1');
    assert.equal(closed.verdict, 'reverse');
    const match = (await reversed.service.getMatch(reversed.match.id))!;
    assert.equal(match.winner, 'B');
    assert.equal(match.status, 'completed');
    assert.equal(match.finishedAt, reversed.match.finishedAt);
    const stats = (players: { discordId: string; elo: number; wins: number; losses: number; matches: number }[]) =>
      players.map(p => [p.discordId, p.elo, p.wins, p.losses, p.matches]).sort();
    assert.deepEqual(stats(await reversed.service.listPlayers()), stats(await direct.service.listPlayers()));
    assert.deepEqual(match.players.map(p => p.eloDelta), (await direct.service.getMatch(direct.match.id))!.players.map(p => p.eloDelta));
  } finally { reversed.service.close(); direct.service.close(); }
});

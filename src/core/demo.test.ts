import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchmakingService } from './engine.js';
import { DEMO_OWNER, seedDemo } from './demo.js';

test('interrupção da demonstração reverte toda a carga e permite reiniciar', async () => {
  const service = new MatchmakingService(':memory:', { ownerId: DEMO_OWNER });
  let calls = 0;
  try {
    await assert.rejects(seedDemo(service, () => {
      if (++calls === 3) throw new Error('interrupção simulada');
    }), /interrupção simulada/);
    assert.equal((await service.listPlayers()).length, 0);
    assert.equal(await service.countMatches(), 0);
    await seedDemo(service, () => {});
    assert.equal((await service.listPlayers()).length, 36);
    assert.equal(await service.countMatches(), 31);
  } finally { service.close(); }
});

test('demonstração tem histórico coerente e inicialização idempotente', async () => {
  let now = Date.now();
  const service = new MatchmakingService(':memory:', { ownerId: DEMO_OWNER, now: () => now });
  try {
    await seedDemo(service, value => { now = value; });
    const players = await service.listPlayers();
    const matches = await service.listMatches();
    const completed = matches.filter(match => match.status === 'completed');
    assert.equal(players.length, 36);
    assert.equal(completed.length, 30);
    assert.equal(players.reduce((sum, player) => sum + player.matches, 0), completed.length * 12);
    assert.equal(players.reduce((sum, player) => sum + player.wins, 0), completed.length * 6);
    assert.equal(players.reduce((sum, player) => sum + player.mvps, 0), completed.length);
    assert.equal((await service.getActiveMatches()).length, 1);
    assert.equal((await service.getQueue()).players.length, 7);
    await seedDemo(service, value => { now = value; });
    assert.equal((await service.listMatches()).length, 31);
    assert.equal((await service.listPlayers()).length, 36);
  } finally { service.close(); }
});

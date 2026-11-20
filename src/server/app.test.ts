import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { MatchmakingService } from '../core/engine.js';
import { createApp } from './app.js';

async function withServer(action: (base: string, service: MatchmakingService) => Promise<void>, demo = false) {
  const service = new MatchmakingService(':memory:', { ownerId: 'owner' });
  const app = createApp(service, { demo, discordInvite: null, configured: false, avatar: async () => null });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await action(base, service); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close();
  }
}

test('produção vazia não inventa jogadores, fila ou partidas', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/overview`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.stats, { players: 0, completedMatches: 0, activeMatches: 0, queued: 0 });
    assert.deepEqual(data.topPlayers, []);
    assert.equal(data.config.demo, false);
    assert.equal(data.config.discordInvite, null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('ranking combina busca, posição, patente e paginação com limites válidos', async () => {
  await withServer(async (base, service) => {
    for (let index = 1; index <= 15; index++) {
      const link = await service.beginLink(String(index), `Player${index}`, String(index + 1000), `Roblox${index}`, index % 2 === 0 ? 'setter' : 'spiker');
      await service.completeLink(String(index), link.code);
    }
    const page = await (await fetch(`${base}/api/players?page=2&limit=10`)).json();
    assert.equal(page.players.length, 5);
    assert.equal(page.total, 15);
    assert.equal(page.pages, 2);
    const filtered = await (await fetch(`${base}/api/players?position=setter&tier=Platinum&search=roblox1`)).json();
    assert.equal(filtered.total, 3);
    const invalid = await (await fetch(`${base}/api/players?page=-1&limit=NaN`)).json();
    assert.equal(invalid.page, 1);
    assert.equal(invalid.players.length, 10);
    const empty = await (await fetch(`${base}/api/players?search=not-found`)).json();
    assert.equal(empty.total, 0);
    assert.equal(empty.pages, 1);
  });
});

test('API pública não oferece escrita, códigos de vinculação ou rotas privadas', async () => {
  await withServer(async (base, service) => {
    const link = await service.beginLink('1', 'Player', '123', 'Roblox', 'spiker');
    await service.completeLink('1', link.code);
    const response = await fetch(`${base}/api/players/1`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes('MM42-'), false);
    assert.equal((await fetch(`${base}/api/players/1`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/api/players/not-a-number`)).status, 404);
    assert.equal((await fetch(`${base}/api/matches/9999`)).status, 404);
  });
});

test('demonstração é identificada e não busca avatares de IDs ilustrativos', async () => {
  await withServer(async base => {
    const data = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(data.config.demo, true);
    assert.equal((await fetch(`${base}/api/avatar/123`)).status, 404);
    assert.equal((await fetch(`${base}/api/avatar/invalid`)).status, 404);
  }, true);
});

test('API limita excesso de consultas sem afetar arquivos estáticos', async () => {
  await withServer(async base => {
    for (let index = 0; index < 180; index++) assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const limited = await fetch(`${base}/api/health`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

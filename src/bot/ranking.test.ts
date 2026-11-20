import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { rankFor } from '../core/ranks.js';
import { rankingSvg, renderRanking, RANKING_HEIGHT, RANKING_WIDTH } from './ranking.js';
import { player } from './test-fixtures.js';

const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('Internet proibida neste teste'); }; });
after(() => { globalThis.fetch = originalFetch; });

test('card de ranking 1100x840 exibe somente o top 10, sem internet', async () => {
  const players = Array.from({ length: 15 }, (_, index) => player(index));
  const png = await renderRanking(players, { avatars: players.map(() => null) });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, RANKING_WIDTH);
  assert.equal(metadata.height, RANKING_HEIGHT);
  assert.equal(metadata.format, 'png');
  assert.equal((rankingSvg(players).match(/ vitórias/g) ?? []).length, 10);
});

test('ranking traduz patentes para pt-BR e escapa entradas maliciosas', () => {
  const players = Array.from({ length: 5 }, (_, index) => player(index));
  players[0].robloxName = '"><script>alert(1)</script>&';
  players[1].rank = rankFor(450).rank;
  const svg = rankingSvg(players);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /Prata II/);
  assert.match(svg, /Ouro/);
});

test('avatares fornecidos são recortados e falhas não quebram o card', async () => {
  const players = Array.from({ length: 3 }, (_, index) => player(index));
  const avatar = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ef4053' } }).png().toBuffer();
  const withAvatar = await renderRanking(players, { avatars: [avatar, null, null] });
  const without = await renderRanking(players, { avatars: [null, null, null] });
  assert.notDeepEqual(withAvatar, without);
  const invalid = await renderRanking(players, { avatars: [Buffer.from('<svg><script>bad</script></svg>'), null, null] });
  assert.equal((await sharp(invalid).metadata()).width, RANKING_WIDTH);
});

test('ranking vazio gera SVG finito com aviso', async () => {
  const svg = rankingSvg([]);
  assert.match(svg, /O ranking ainda está vazio/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  const png = await renderRanking([], { avatars: [] });
  assert.equal((await sharp(png).metadata()).height, RANKING_HEIGHT);
});

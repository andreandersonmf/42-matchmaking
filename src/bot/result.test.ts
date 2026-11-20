import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Match } from '../core/types.js';
import { match, playerId } from './test-fixtures.js';
import { renderResult, resultSvg, RESULT_HEIGHT, RESULT_WIDTH } from './result.js';

const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('offline'); }; });
after(() => { globalThis.fetch = originalFetch; });

function completedMatch(overrides: Partial<Match> = {}): Match {
  return match({
    status: 'completed', winner: 'A', mode: 'balanced', finishedAt: 1_800_000_600_000, mvpId: playerId(0),
    players: match().players.map((player, index) => ({ ...player, team: index < 6 ? 'A' as const : 'B' as const, isCaptain: index === 0 || index === 6, eloDelta: index < 6 ? 12 : -12 })),
    ...overrides,
  });
}

test('card de resultado mostra vencedor, modo, MVP e escalação sem internet', () => {
  const svg = resultSvg(completedMatch());
  assert.match(svg, /EQUIPE A VENCEU/);
  assert.match(svg, /EQUIPE A · VENCEDORA/);
  assert.match(svg, /EQUILIBRADO/);
  assert.match(svg, /MVP · Roblox_0 \(\+4 ELO\)/);
  assert.match(svg, /Roblox_11/);
  assert.match(svg, /Ouro II/);
  assert.match(svg, /\[C\]/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('card escapa entradas maliciosas', () => {
  const finished = completedMatch();
  const svg = resultSvg({ ...finished, players: finished.players.map((player, index) => index === 0 ? { ...player, robloxName: '<script>x</script>' } : player) });
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
});

test('card de cancelamento informa que nada foi contabilizado', () => {
  const svg = resultSvg(match({ status: 'cancelled', players: [] }));
  assert.match(svg, /PARTIDA CANCELADA/);
  assert.match(svg, /Nenhum Elo foi contabilizado/);
  assert.match(svg, /Aguardando jogadores/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test('avatares fornecidos são recortados e falhas não quebram o card', async () => {
  const finished = completedMatch();
  const tiny = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 60, b: 60, alpha: 1 } } }).png().toBuffer();
  const withAvatar = await renderResult(finished, { avatars: [tiny, ...Array(11).fill(null)] });
  const without = await renderResult(finished, { avatars: [] });
  const metadata = await sharp(withAvatar).metadata();
  assert.equal(metadata.width, RESULT_WIDTH);
  assert.equal(metadata.height, RESULT_HEIGHT);
  assert.notDeepEqual(withAvatar, without);
  const invalid = await renderResult(finished, { avatars: [Buffer.from('not an image'), ...Array(11).fill(null)] });
  assert.equal((await sharp(invalid).metadata()).width, RESULT_WIDTH);
});

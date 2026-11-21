import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { escapeXml, profileSvg, renderProfile, PROFILE_HEIGHT, PROFILE_WIDTH } from './profile.js';
import { profile } from './test-fixtures.js';

const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('Internet proibida neste teste'); }; });
after(() => { globalThis.fetch = originalFetch; });

test('escape XML protege todos os caracteres e remove controles inválidos', () => {
  assert.equal(escapeXml('<tag a="x">&\'\u0000'), '&lt;tag a=&quot;x&quot;&gt;&amp;&apos;');
  assert.equal(escapeXml('João & Ana'), 'João &amp; Ana');
  assert.equal(escapeXml('\ud800'), '');
});

test('card PNG 1100x600 com fallback é gerado sem internet', async () => {
  const png = await renderProfile(profile(), { avatar: null });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, PROFILE_WIDTH);
  assert.equal(metadata.height, PROFILE_HEIGHT);
  assert.equal(metadata.format, 'png');
});

test('avatar fornecido é normalizado e recortado; falha não quebra perfil', async () => {
  const avatar = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ef4053' } }).png().toBuffer();
  const png = await renderProfile(profile(), { avatar });
  const fallback = await renderProfile(profile(), { avatar: null });
  assert.notDeepEqual(png, fallback);
  const invalid = await renderProfile(profile(), { avatar: Buffer.from('<svg><script>bad</script></svg>') });
  assert.equal((await sharp(invalid).metadata()).width, 1100);
  const unavailable = await renderProfile(profile());
  assert.equal((await sharp(unavailable).metadata()).height, 600);
});

test('nomes e badges XML maliciosos permanecem texto e geram PNG válido', async () => {
  const value = profile();
  value.player.name = '\"><script>alert(1)</script>&';
  value.player.robloxName = '<image href="file:///x">';
  value.player.rank = { ...value.player.rank, name: '<b>rank</b>', color: '\"/><script>bad</script>' };
  value.player.nextRank = { ...value.player.rank, name: 'next <&>' };
  const svg = profileSvg(value);
  assert.doesNotMatch(svg, /<script>|<image|<b>rank/);
  assert.match(svg, /&lt;image/);
  assert.match(svg, /&lt;b&gt;rank&lt;\/b&gt;/);
  const png = await renderProfile(value, { avatar: null });
  assert.equal((await sharp(png).metadata()).format, 'png');
});

test('rank máximo, zero partidas e histórico vazio geram SVG finito', async () => {
  const value = profile();
  value.player.nextRank = null;
  value.player.matches = 0;
  value.player.wins = 0;
  value.player.vip = 'none';
  value.eloHistory = [];
  value.player.progress = Number.NaN;
  assert.doesNotMatch(profileSvg(value), /NaN|Infinity/);
  assert.match(profileSvg(value), /Top 30 com 100\+ PDL: Grão-Mestre/);
  assert.equal((await sharp(await renderProfile(value, { avatar: null })).metadata()).width, 1100);
});

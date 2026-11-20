import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { MatchmakingService } from '../core/engine.js';
import { AVATAR_REFRESH_MS, AVATAR_RETRY_MS, AVATAR_SIZE, AvatarSync, prepareSiteAvatar } from './avatars.js';

const picture = (size = 420) => sharp({ create: { width: size, height: size, channels: 3, background: '#4a7a8a' } }).png().toBuffer();

async function setup(count = 3) {
  let time = 1_800_000_000_000;
  const service = new MatchmakingService(':memory:', { now: () => time, ownerId: 'owner' });
  for (let index = 0; index < count; index++) {
    const challenge = await service.beginLink(String(index + 1), `discord${index}`, String(1000 + index), `Roblox${index}`, 'spiker');
    await service.completeLink(String(index + 1), challenge.code);
  }
  return { service, advance: (ms: number) => { time += ms; } };
}

test('avatar do Roblox é reduzido para o tamanho do site e imagens inválidas são recusadas', async () => {
  const small = await prepareSiteAvatar(await picture());
  assert.ok(small);
  const meta = await sharp(small).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [AVATAR_SIZE, AVATAR_SIZE, 'png']);
  assert.equal(await prepareSiteAvatar(null), null);
  assert.equal(await prepareSiteAvatar(Buffer.from('<html>not an image</html>')), null);
  assert.equal(await prepareSiteAvatar(Buffer.alloc(2_000_001)), null);
});

test('motor guarda avatar, lista vencidos e adia falhas sem apagar o que já existe', async () => {
  const { service, advance } = await setup();
  try {
    assert.deepEqual(await service.avatarsToRefresh(10), ['1000', '1001', '1002']);
    assert.equal(await service.getAvatar('1000'), null);
    await service.saveAvatar('1000', Buffer.from('png-a'), AVATAR_REFRESH_MS);
    await service.deferAvatar('1001', AVATAR_RETRY_MS);
    assert.deepEqual(await service.avatarsToRefresh(10), ['1002']);
    assert.equal((await service.getAvatar('1000'))!.toString(), 'png-a');
    assert.equal(await service.getAvatar('1001'), null);
    assert.deepEqual(await service.avatarsToRefresh(1), ['1002']);

    advance(AVATAR_RETRY_MS + 1);
    assert.deepEqual(await service.avatarsToRefresh(10), ['1002', '1001']);
    await service.deferAvatar('1000', AVATAR_RETRY_MS);
    assert.equal((await service.getAvatar('1000'))!.toString(), 'png-a');
    advance(AVATAR_REFRESH_MS);
    assert.deepEqual((await service.avatarsToRefresh(10)).sort(), ['1000', '1001', '1002']);
  } finally { service.close(); }
});

test('sincronização busca os avatares pendentes e tenta de novo só depois das falhas', async () => {
  const { service, advance } = await setup();
  try {
    const fetched: string[] = [];
    const sync = new AvatarSync(service, {
      pauseMs: 0, batch: 2,
      fetcher: async id => { fetched.push(id); return id === '1001' ? null : picture(); },
    });
    assert.equal(await sync.cycle(), 1);
    assert.deepEqual(fetched, ['1000', '1001']);
    assert.ok(await service.getAvatar('1000'));
    assert.equal(await service.getAvatar('1001'), null);

    assert.equal(await sync.cycle(), 1);
    assert.deepEqual(fetched, ['1000', '1001', '1002']);
    assert.equal(await sync.cycle(), 0);
    assert.equal(fetched.length, 3);

    advance(AVATAR_RETRY_MS + 1);
    await sync.cycle();
    assert.deepEqual(fetched.slice(3), ['1001']);
  } finally { service.close(); }
});

test('refresh imediato e erros do Roblox não quebram a sincronização', async () => {
  const { service } = await setup(1);
  try {
    assert.equal(await new AvatarSync(service, { fetcher: async () => picture() }).refresh('1000'), true);
    assert.ok(await service.getAvatar('1000'));
    assert.equal(await new AvatarSync(service, { fetcher: async () => { throw new Error('429'); } }).refresh('1000'), false);
    assert.ok(await service.getAvatar('1000'), 'avatar antigo é mantido');
  } finally { service.close(); }
});

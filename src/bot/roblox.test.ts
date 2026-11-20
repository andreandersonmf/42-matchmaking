import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAvatar, getDescription, lookupUsername, readLimited, safeAvatarUrl, validRobloxId, type Fetcher } from './roblox.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const fetchStub = (impl: (url: string, init?: RequestInit) => Promise<Response>): Fetcher => ((url: string | URL | Request, init?: RequestInit) => impl(String(url), init)) as Fetcher;

test('username usa endpoint fixo, POST, prazo e bloqueia redirects', async () => {
  const fetcher = fetchStub(async (url, init) => {
    assert.equal(url, 'https://users.roblox.com/v1/usernames/users');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), { usernames: ['Roblox_123'], excludeBannedUsers: true });
    return json({ data: [{ id: 123, name: 'Roblox_123' }] });
  });
  assert.deepEqual(await lookupUsername('Roblox_123', fetcher), { id: '123', name: 'Roblox_123' });
  await assert.rejects(() => lookupUsername('https://attacker.test/', fetcher), /usuário Roblox válido/);
  await assert.rejects(() => lookupUsername('Roblox_123', fetchStub(async () => json({ data: [] }))), /Não encontramos/);
  await assert.rejects(() => lookupUsername('Roblox_123', fetchStub(async () => json({ data: [{ id: 123, name: 'AnotherUser' }] }))), /não respondeu/);
});

test('descrição é obtida apenas para ID válido e resposta correspondente', async () => {
  assert.equal(await getDescription('123', fetchStub(async (url, init) => {
    assert.equal(url, 'https://users.roblox.com/v1/users/123');
    assert.equal(init?.redirect, 'error');
    return json({ id: 123, description: 'MATCH-CODE-123' });
  })), 'MATCH-CODE-123');
  await assert.rejects(() => getDescription('../admin', fetchStub(async () => { throw new Error('must not fetch'); })), /ID Roblox/);
  await assert.rejects(() => getDescription('123', fetchStub(async () => json({ id: 124, description: 'fake' }))), /ler sua descrição/);
  for (const id of ['0', '-1', '9007199254740992', '1/2', '01', '1?x=y']) assert.equal(validRobloxId(id), false);
});

test('avatar CDN permite somente HTTPS rbxcdn.com e subdomínios reais', () => {
  assert.equal(safeAvatarUrl('https://tr.rbxcdn.com/image.png'), 'https://tr.rbxcdn.com/image.png');
  assert.equal(safeAvatarUrl('https://rbxcdn.com/image.png'), 'https://rbxcdn.com/image.png');
  for (const url of ['http://rbxcdn.com/x', 'https://evilrbxcdn.com/x', 'https://rbxcdn.com.evil.test/x', 'https://rbxcdn.com@evil.test/x', 'https://user:pass@rbxcdn.com/x', 'https://rbxcdn.com:444/x', 'file:///x', 'data:image/png,x', 'https://127.0.0.1/x']) assert.equal(safeAvatarUrl(url), null);
});

test('avatar valida target, tipo, bytes e nunca segue redirects', async () => {
  let calls = 0;
  const fetcher = fetchStub(async (url, init) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (calls === 1) {
      assert.ok(url.startsWith('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=123&'));
      return json({ data: [{ targetId: 123, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/avatar.png' }] });
    }
    assert.equal(url, 'https://tr.rbxcdn.com/avatar.png');
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
  });
  assert.deepEqual(await fetchAvatar('123', fetcher), Buffer.from([1, 2, 3]));
  assert.equal(calls, 2);
  for (const imageUrl of ['https://attacker.test/a', 'http://tr.rbxcdn.com/a']) {
    let total = 0;
    assert.equal(await fetchAvatar('123', fetchStub(async () => { total++; return json({ data: [{ targetId: 123, state: 'Completed', imageUrl }] }); })), null);
    assert.equal(total, 1);
  }
});

test('bytes excessivos, falhas e thumbnails pendentes degradam com segurança', async () => {
  await assert.rejects(() => readLimited(new Response('12345'), 4), /limite/);
  await assert.rejects(() => readLimited(new Response('x', { headers: { 'Content-Length': '500' } }), 4), /limite/);
  await assert.rejects(() => readLimited(new Response('x', { status: 500 }), 100), /HTTP/);
  const throwing = fetchStub(async () => { throw new Error('secret internal details'); });
  assert.equal(await fetchAvatar('123', throwing), null);
  assert.equal(await fetchAvatar('../bad', throwing), null);
  await assert.rejects(() => lookupUsername('Roblox_123', throwing), error => error instanceof Error && !error.message.includes('secret'));
  assert.equal(await fetchAvatar('123', fetchStub(async () => json({ data: [{ targetId: 123, state: 'Pending' }] }))), null);
});

test('avatar rejeita corpo HTML e tamanho declarado excessivo', async () => {
  const responses: Record<string, string>[] = [{ 'Content-Type': 'text/html' }, { 'Content-Type': 'image/png', 'Content-Length': '3000000' }];
  for (const headers of responses) {
    let calls = 0;
    const fetcher = fetchStub(async () => ++calls === 1
      ? json({ data: [{ targetId: 123, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/avatar.png' }] })
      : new Response('not an avatar', { headers }));
    assert.equal(await fetchAvatar('123', fetcher), null);
  }
});

import { BotError } from './access.js';

export type Fetcher = typeof fetch;
const API_LIMIT = 1_000_000;
const AVATAR_LIMIT = 2_000_000;

export function validRobloxId(value: string): boolean {
  return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

export function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (url.hostname !== 'rbxcdn.com' && !url.hostname.endsWith('.rbxcdn.com')) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) throw new Error('HTTP indisponível');
  const size = response.headers.get('content-length');
  if (size && Number(size) > limit) {
    await response.body?.cancel();
    throw new Error('Resposta excede o limite');
  }
  if (!response.body) throw new Error('Resposta vazia');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Resposta excede o limite');
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function apiJson(url: string, fetcher: Fetcher, init: RequestInit = {}): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  return JSON.parse((await readLimited(response, API_LIMIT)).toString('utf8'));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resposta inválida');
  return value as Record<string, unknown>;
}

export async function lookupUsername(username: string, fetcher: Fetcher = fetch): Promise<{ id: string; name: string }> {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new BotError('Informe um nome de usuário Roblox válido, com 3 a 20 letras, números ou sublinhado. Não use o nome de exibição.');
  try {
    const result = object(await apiJson('https://users.roblox.com/v1/usernames/users', fetcher, {
      method: 'POST', body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    }));
    if (!Array.isArray(result.data) || result.data.length !== 1) throw new BotError('Não encontramos esse usuário Roblox. Confira o nome de usuário e tente /register novamente.');
    const user = object(result.data[0]);
    if (typeof user.id !== 'number' || !validRobloxId(String(user.id)) || typeof user.name !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(user.name)) throw new Error('Usuário inválido');
    if (user.name.toLowerCase() !== username.toLowerCase()) throw new Error('Usuário divergente');
    return { id: String(user.id), name: user.name };
  } catch (error) {
    if (error instanceof BotError) throw error;
    throw new BotError('O Roblox não respondeu como esperado. Seu vínculo não foi alterado; tente novamente em alguns instantes.');
  }
}

export async function getDescription(id: string, fetcher: Fetcher = fetch): Promise<string> {
  if (!validRobloxId(id)) throw new BotError('O ID Roblox salvo é inválido. Reinicie o vínculo com /register.');
  try {
    const result = object(await apiJson(`https://users.roblox.com/v1/users/${id}`, fetcher));
    if (String(result.id) !== id || typeof result.description !== 'string' || result.description.length > 10_000) throw new Error('Perfil inválido');
    return result.description;
  } catch {
    throw new BotError('Não foi possível ler sua descrição no Roblox. Aguarde alguns instantes e tente /verificar novamente.');
  }
}

export async function fetchAvatar(id: string, fetcher: Fetcher = fetch): Promise<Buffer | null> {
  if (!validRobloxId(id)) return null;
  try {
    const result = object(await apiJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=420x420&format=Png&isCircular=false`, fetcher));
    if (!Array.isArray(result.data)) return null;
    const entry = result.data.map(object).find(item => String(item.targetId) === id && item.state === 'Completed');
    const imageUrl = safeAvatarUrl(entry?.imageUrl);
    if (!imageUrl) return null;
    const response = await fetcher(imageUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Accept: 'image/png,image/jpeg,image/webp' } });
    if (!/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      return null;
    }
    return await readLimited(response, AVATAR_LIMIT);
  } catch {
    return null;
  }
}

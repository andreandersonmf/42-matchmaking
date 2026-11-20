import sharp from 'sharp';
import { fetchAvatar } from './roblox.js';

export interface AvatarStore {
  avatarsToRefresh(limit: number): Promise<string[]>;
  saveAvatar(robloxId: string, png: Buffer, refreshAfterMs: number): Promise<void>;
  deferAvatar(robloxId: string, retryAfterMs: number): Promise<void>;
}

export const AVATAR_SIZE = 160;
export const AVATAR_REFRESH_MS = 12 * 3_600_000;
export const AVATAR_RETRY_MS = 30 * 60_000;

/** Reduz a miniatura do Roblox para o tamanho usado no site, validando que é mesmo uma imagem. */
export async function prepareSiteAvatar(source: Buffer | null): Promise<Buffer | null> {
  if (!source || source.length > 2_000_000) return null;
  try {
    return await sharp(source, { limitInputPixels: 16_000_000, failOn: 'error' })
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' }).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
  } catch {
    return null;
  }
}

export interface AvatarSyncOptions {
  fetcher?: (robloxId: string) => Promise<Buffer | null>;
  report?: (message: string) => void;
  batch?: number;
  pauseMs?: number;
  intervalMs?: number;
}

/**
 * O bot consegue falar com o Roblox; a Vercel nem sempre. Então o bot guarda o avatar no banco
 * compartilhado e o site apenas lê de lá.
 */
export class AvatarSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly fetcher: (robloxId: string) => Promise<Buffer | null>;
  private readonly report: (message: string) => void;
  private readonly batch: number;
  private readonly pauseMs: number;
  private readonly intervalMs: number;

  constructor(private store: AvatarStore, options: AvatarSyncOptions = {}) {
    this.fetcher = options.fetcher ?? (id => fetchAvatar(id));
    this.report = options.report ?? console.warn;
    this.batch = options.batch ?? 6;
    this.pauseMs = options.pauseMs ?? 500;
    this.intervalMs = options.intervalMs ?? 10 * 60_000;
  }

  async refresh(robloxId: string): Promise<boolean> {
    try {
      const avatar = await prepareSiteAvatar(await this.fetcher(robloxId));
      if (!avatar) { await this.store.deferAvatar(robloxId, AVATAR_RETRY_MS); return false; }
      await this.store.saveAvatar(robloxId, avatar, AVATAR_REFRESH_MS);
      return true;
    } catch {
      await this.store.deferAvatar(robloxId, AVATAR_RETRY_MS).catch(() => undefined);
      return false;
    }
  }

  async cycle(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let updated = 0;
    try {
      const pending = await this.store.avatarsToRefresh(this.batch);
      for (const [index, id] of pending.entries()) {
        if (index > 0 && this.pauseMs > 0) await new Promise(done => setTimeout(done, this.pauseMs));
        if (await this.refresh(id)) updated++;
      }
    } catch {
      this.report('Não foi possível atualizar os avatares do site agora. Nova tentativa no próximo ciclo.');
    } finally {
      this.running = false;
    }
    return updated;
  }

  start(): void {
    if (this.timer) return;
    void this.cycle();
    this.timer = setInterval(() => { void this.cycle(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MatchmakingService } from './engine.js';
import { DEMO_OWNER, seedDemo } from './demo.js';

export const demoMode = process.env.DEMO_MODE === 'true';
const remoteUrl = process.env.TURSO_URL?.trim();
const localPath = resolve(demoMode ? './data/demo.sqlite' : (process.env.DATABASE_PATH || './data/matchmaking.sqlite'));
if (demoMode || !remoteUrl) mkdirSync(dirname(localPath), { recursive: true });
let seedClock: number | null = null;
export const service = new MatchmakingService(demoMode ? localPath : (remoteUrl ?? localPath), {
  ownerId: demoMode ? DEMO_OWNER : process.env.DISCORD_OWNER_ID,
  authToken: process.env.TURSO_AUTH_TOKEN,
  now: () => seedClock ?? Date.now(),
});
if (demoMode) {
  await seedDemo(service, time => { seedClock = time; });
  seedClock = null;
}

import 'dotenv/config';
import sharp from 'sharp';
import { demoMode, service } from '../core/runtime.js';
import { fetchAvatar } from '../bot/roblox.js';
import { createApp } from './app.js';
import { readPublicEnvironment } from './config.js';

const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT precisa ser um número de 1 a 65535.');
const host = process.env.HOST || '127.0.0.1';
const environment = readPublicEnvironment();
const app = createApp(service, {
  ...environment,
  discordInvite: demoMode ? null : environment.discordInvite,
  demo: demoMode,
  avatar: async id => {
    const stored = await service.getAvatar(id).catch(() => null);
    if (stored) return stored;
    const avatar = await fetchAvatar(id);
    if (!avatar) return null;
    return sharp(avatar, { limitInputPixels: 16_000_000, failOn: 'error' }).resize(160, 160, { fit: 'cover' }).png().toBuffer();
  },
});
const server = app.listen(port, host, () => {
  console.info(`4.2 Matchmaking em http://${host}:${port}${demoMode ? ' — demonstração isolada' : ''}`);
});
server.on('error', error => {
  console.error(`Não foi possível iniciar o site: ${error.message}`);
  service.close();
  process.exitCode = 1;
});
function stop() { server.close(() => service.close()); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

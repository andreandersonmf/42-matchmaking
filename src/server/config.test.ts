import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPublicEnvironment } from './config.js';

test('configuração pública não vaza token e rejeita protocolos não HTTPS', () => {
  const config = readPublicEnvironment({
    DISCORD_TOKEN: 'private-test-value', DISCORD_CLIENT_ID: '123', DISCORD_GUILD_ID: '456',
    DISCORD_INVITE_URL: 'javascript:alert(1)',
  });
  assert.equal(config.discordInvite, null);
  assert.equal(config.configured, true);
  assert.equal(JSON.stringify(config).includes('private-test-value'), false);
  assert.deepEqual(readPublicEnvironment({}), { discordInvite: null, configured: false });
});

export interface RegistrationEnvironment {
  token: string;
  clientId: string;
  guildId: string;
}

export interface BotEnvironment extends RegistrationEnvironment {
  staffRoleId: string;
  ownerId: string;
  matchChannelId?: string;
  resultChannelId?: string;
  siteUrl?: string;
  verifiedRoleId?: string;
  verifyChannelId?: string;
}

export const snowflake = /^[1-9]\d{16,19}$/;

export function safeSiteUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || value.length > 512) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function requiredId(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim() ?? '';
  if (!snowflake.test(value)) throw new Error(`Configure ${key} com um ID válido do Discord.`);
  return value;
}

export function readRegistrationEnvironment(env: NodeJS.ProcessEnv = process.env): RegistrationEnvironment {
  const token = env.DISCORD_TOKEN?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('Configure DISCORD_TOKEN com um token de bot válido.');
  }
  return { token, clientId: requiredId(env, 'DISCORD_CLIENT_ID'), guildId: requiredId(env, 'DISCORD_GUILD_ID') };
}

export function readBotEnvironment(env: NodeJS.ProcessEnv = process.env): BotEnvironment {
  const base = readRegistrationEnvironment(env);
  const matchChannelId = env.DISCORD_MATCH_CHANNEL_ID?.trim() ? requiredId(env, 'DISCORD_MATCH_CHANNEL_ID') : undefined;
  const resultChannelId = env.DISCORD_RESULT_CHANNEL_ID?.trim() ? requiredId(env, 'DISCORD_RESULT_CHANNEL_ID') : undefined;
  const verifiedRoleId = env.DISCORD_VERIFIED_ROLE_ID?.trim() ? requiredId(env, 'DISCORD_VERIFIED_ROLE_ID') : undefined;
  const verifyChannelId = env.DISCORD_VERIFY_CHANNEL_ID?.trim() ? requiredId(env, 'DISCORD_VERIFY_CHANNEL_ID') : undefined;
  const siteUrl = safeSiteUrl(env.SITE_URL?.trim());
  if (env.SITE_URL?.trim() && !siteUrl) throw new Error('SITE_URL deve ser uma URL HTTP ou HTTPS, sem credenciais.');
  return {
    ...base,
    staffRoleId: requiredId(env, 'DISCORD_STAFF_ROLE_ID'),
    ownerId: requiredId(env, 'DISCORD_OWNER_ID'),
    matchChannelId,
    resultChannelId,
    verifiedRoleId,
    verifyChannelId,
    siteUrl,
  };
}

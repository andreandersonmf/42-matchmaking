export function readPublicEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  let discordInvite: string | null = null;
  if (environment.DISCORD_INVITE_URL) {
    try {
      const url = new URL(environment.DISCORD_INVITE_URL);
      const isInvite = url.hostname === 'discord.gg'
        ? /^\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)
        : url.hostname === 'discord.com' && /^\/invite\/[a-zA-Z0-9-]+\/?$/.test(url.pathname);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && isInvite) discordInvite = url.href;
    } catch { discordInvite = null; }
  }
  return {
    discordInvite,
    configured: Boolean(environment.DISCORD_TOKEN && environment.DISCORD_CLIENT_ID && environment.DISCORD_GUILD_ID),
  };
}

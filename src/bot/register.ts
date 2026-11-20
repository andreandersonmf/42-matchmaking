import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { commandData } from './commands.js';
import { readRegistrationEnvironment } from './env.js';

export async function registerCommands(): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
  let config;
  try {
    config = readRegistrationEnvironment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuração do registro inválida.');
    process.exitCode = 1;
    return;
  }
  try {
    const rest = new REST({ version: '10', timeout: 10_000 }).setToken(config.token);
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commandData });
    console.info(`${commandData.length} comandos registrados no servidor configurado. O bot não foi conectado ao Gateway.`);
  } catch {
    console.error('Não foi possível registrar os comandos. Confira os IDs, o token e o escopo applications.commands do convite.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void registerCommands().catch(() => { console.error('Falha ao registrar comandos.'); process.exitCode = 1; });
}

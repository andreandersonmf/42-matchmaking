import { PermissionFlagsBits } from 'discord.js';
import { DomainError } from '../core/engine.js';
import type { Match, MatchMode, Position, Team } from '../core/types.js';
import type { BotEnvironment } from './env.js';
import { snowflake } from './env.js';

export class BotError extends Error {}

export interface Actor {
  id: string;
  roles: readonly string[];
  permissions: bigint;
}

export function isStaff(actor: Actor, config: Pick<BotEnvironment, 'ownerId' | 'staffRoleId'>): boolean {
  return actor.id === config.ownerId || actor.roles.includes(config.staffRoleId)
    || (actor.permissions & PermissionFlagsBits.ManageGuild) !== 0n;
}

export function requireStaff(actor: Actor, config: Pick<BotEnvironment, 'ownerId' | 'staffRoleId'>): void {
  if (!isStaff(actor, config)) throw new BotError('Esta ação é exclusiva da staff. É necessário o cargo configurado ou Gerenciar Servidor.');
}

export function requireOwner(actor: Actor, config: Pick<BotEnvironment, 'ownerId'>): void {
  if (actor.id !== config.ownerId) throw new BotError('Somente o dono configurado pode ajustar Elo. Todo ajuste exige um motivo e fica auditado.');
}

export function requireInitiator(actor: Actor, match: Match, config: Pick<BotEnvironment, 'ownerId' | 'staffRoleId'>): void {
  requireStaff(actor, config);
  if (actor.id !== match.initiatorId) throw new BotError('Somente o membro da staff que criou esta partida pode escolher os capitães, iniciá-la ou finalizar o resultado. O dono não pode finalizar a partida de outra pessoa.');
}

export function requireParticipant(match: Match, id: string): void {
  if (!match.players.some(player => player.discordId === id)) throw new BotError('Somente os 12 jogadores desta partida podem votar.');
}

export type ComponentAction =
  | { kind: 'queue'; action: Position | 'leave' | 'status' | 'join' | 'open' }
  | { kind: 'mode'; matchId: number; mode: MatchMode }
  | { kind: 'captain' | 'win'; matchId: number; team: Team }
  | { kind: 'pick' | 'mvp' | 'start'; matchId: number };

export function parseCustomId(value: string): ComponentAction | null {
  if (value.length > 100) return null;
  const queue = /^mm:q:(spiker|setter|leave|status|join|open)$/.exec(value);
  if (queue) return { kind: 'queue', action: queue[1] as Position | 'leave' | 'status' | 'join' | 'open' };
  const match = /^mm:m:([1-9]\d{0,15}):(mode:(captains|balanced|random)|cap:([AB])|win:([AB])|pick|mvp|start)$/.exec(value);
  if (!match) return null;
  const matchId = Number(match[1]);
  if (!Number.isSafeInteger(matchId)) return null;
  if (match[3]) return { kind: 'mode', matchId, mode: match[3] as MatchMode };
  if (match[4]) return { kind: 'captain', matchId, team: match[4] as Team };
  if (match[5]) return { kind: 'win', matchId, team: match[5] as Team };
  return { kind: match[2] as 'pick' | 'mvp' | 'start', matchId };
}

export function selectedPlayer(values: readonly string[]): string {
  if (values.length !== 1 || !snowflake.test(values[0])) throw new BotError('Selecione exatamente um jogador válido. Atualize a mensagem e tente novamente.');
  return values[0];
}

export function safeError(error: unknown, fallback = 'Não foi possível concluir esta ação. Confira seu cadastro com /profile e o estado atual no painel da fila ou da partida. Se persistir, procure a staff.'): string {
  return error instanceof BotError || error instanceof DomainError ? error.message : fallback;
}

/** Motivo curto de um erro inesperado, para o log do bot (sem stack). */
export function errorDetail(error: unknown): string {
  return error instanceof Error ? ` Motivo: ${error.name}: ${error.message.slice(0, 200)}` : '';
}

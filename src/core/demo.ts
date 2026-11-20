import type { MatchmakingService } from './engine.js';
import type { Match, MatchMode } from './types.js';

export const DEMO_OWNER = '900000000000000000';

export function seedDemo(service: MatchmakingService, setClock: (time: number) => void): Promise<void> {
  return service.seedIfEmpty(() => populateDemo(service, setClock));
}

async function populateDemo(service: MatchmakingService, setClock: (time: number) => void) {
  const names = ['kaizen', 'akiyama', 'yuzuki', 'shiro', 'ryu', 'kaito', 'natsuki', 'kenji', 'hinata', 'yuki', 'ren', 'sora', 'hikari', 'haru', 'kuro', 'aoki', 'tsuki', 'rio', 'akira', 'niko', 'kazuo', 'levi', 'hayato', 'yume', 'seiji', 'riku', 'noa', 'zero', 'hiro', 'mei', 'akira42', 'sol', 'tatsu', 'sky', 'ace', 'luna'];
  const elo = [2060, 1880, 1740, 1670, 1570, 1460, 1400, 1330, 1260, 1190, 1140, 1080, 990, 930, 850, 800, 740, 660, 600, 510, 440, 370, 300, 230, 170, 100, 80, 30, 0, 0, 0, 50, 100, 150, 200, 250];
  const baseTime = Date.now() - 8 * 86_400_000;
  setClock(baseTime);
  for (let index = 0; index < names.length; index++) {
    const id = String(910000000000000000n + BigInt(index));
    const challenge = await service.beginLink(id, names[index], String(100000 + index), `${names[index]}_42`, index % 3 === 2 ? 'setter' : 'spiker');
    await service.completeLink(id, challenge.code);
    let remaining = elo[index];
    while (remaining > 0) {
      const amount = Math.min(remaining, 500);
      await service.adjustElo(DEMO_OWNER, id, amount, 'Dados demonstrativos isolados');
      remaining -= amount;
    }
    if (index % 7 === 0) await service.grantVip(DEMO_OWNER, id, 'vip_plus', 30);
    else if (index % 5 === 0) await service.grantVip(DEMO_OWNER, id, 'vip', 30);
  }
  const players = await service.listPlayers();
  const spikers = players.filter(player => player.position === 'spiker');
  const setters = players.filter(player => player.position === 'setter');
  const enqueue = async (offset: number) => {
    for (let index = 0; index < 8; index++) await service.joinQueue(spikers[(index + offset * 5) % spikers.length].discordId);
    for (let index = 0; index < 4; index++) await service.joinQueue(setters[(index + offset * 3) % setters.length].discordId);
  };
  const resolve = async (match: Match, mode: MatchMode) => {
    if (match.status === 'voting') for (const player of match.players) match = await service.voteMode(match.id, player.discordId, mode);
    if (match.status === 'captains' && match.mode !== 'captains') for (const player of match.players) match = await service.voteCaptain(match.id, player.discordId, player.discordId);
    if (match.status === 'captains') {
      // a staff (dona da demonstração) escolhe os dois maiores Elos como capitães
      const [first, second] = [...match.players].sort((a, b) => b.elo - a.elo || a.discordId.localeCompare(b.discordId));
      match = await service.setCaptain(match.id, DEMO_OWNER, 'A', first.discordId);
      match = await service.setCaptain(match.id, DEMO_OWNER, 'B', second.discordId);
    }
    while (match.status === 'drafting') {
      const captain = match.players.find(player => player.team === match.draftTurn && player.isCaptain)!;
      const candidate = match.players.find(player => !player.team && match.players.filter(member => member.team === match.draftTurn && member.position === player.position).length < (player.position === 'spiker' ? 4 : 2))!;
      match = await service.pick(match.id, captain.discordId, candidate.discordId);
    }
    return match;
  };
  for (let round = 0; round < 30; round++) {
    setClock(baseTime + round * 6 * 3_600_000);
    await enqueue(round);
    let match = await service.createMatch(DEMO_OWNER, 'demo');
    match = await resolve(match, (['balanced', 'captains', 'random'] as const)[round % 3]);
    await service.startMatch(match.id, DEMO_OWNER);
    setClock(baseTime + round * 6 * 3_600_000 + 25 * 60_000);
    match = await service.finishMatch(match.id, DEMO_OWNER, round % 2 === 0 ? 'A' : 'B');
    const candidate = match.players[round % 12].discordId;
    for (const player of match.players) {
      const vote = player.discordId === candidate ? match.players.find(other => other.discordId !== candidate)!.discordId : candidate;
      await service.voteMvp(match.id, player.discordId, vote);
    }
  }
  setClock(Date.now() - 12 * 60_000);
  await enqueue(31);
  let current = await service.createMatch(DEMO_OWNER, 'demo');
  current = await resolve(current, 'balanced');
  await service.startMatch(current.id, DEMO_OWNER);
  setClock(Date.now() - 90_000);
  const busy = new Set(current.players.map(player => player.discordId));
  const waiting = (await service.listPlayers()).filter(player => !busy.has(player.discordId));
  for (const player of [...waiting.filter(player => player.position === 'spiker').slice(0, 5), ...waiting.filter(player => player.position === 'setter').slice(0, 2)]) await service.joinQueue(player.discordId);
}

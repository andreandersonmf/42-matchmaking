# Denúncias (tickets do Conselho) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let match players report another player into a private ticket channel that the "Membro do Conselho" role judges by majority vote, with the bot applying the penalty.

**Architecture:** Report state lives in a new `reports` table (JSON `data`, like `matches`), managed by new `MatchmakingService` methods inside `transaction()`. The Discord side is in a new `src/bot/reports.ts`: council role, ticket channel and interaction routing. `handler.ts` delegates `report` / `reportpick` / `mm:r:` / `mm:t:` interactions to it. The ticket embed is in `presentation.ts`.

**Tech Stack:** TypeScript, discord.js 14, @libsql/client, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-11-20-denuncias-design.md`

## Global Constraints

- All user-facing text is in Brazilian Portuguese.
- Verdicts: `innocent | warning | elo:25 | elo:50 | elo:100 | susp:1 | susp:3 | susp:7`.
- At most 3 reporters per ticket. A ticket is unique per (match, accused).
- Reports are accepted only while the match is `live`, `mvp` or `completed` with `finishedAt` within 24h.
- Closing needs ≥ 2 ballots. A tie at the top goes to `tied`, and only staff (`isStaff`) can decide it.
- Every action writes an `audit` row.
- Role name `Membro do Conselho`; category name `Denúncias`; channel name `denuncia-0001`.
- Tests run with `.env` moved aside: `mv .env .env.bak; npm test; mv .env.bak .env`.

## Review Focus

- A council member who is the accused or a reporter tries to vote. Expected: refused. (Task 1 test)
- Two clicks close the same ticket at once. Expected: the second fails with "já foi encerrado", and the penalty is applied once. (Transaction queue; Task 1 test closes twice.)
- An accused who is in the queue gets suspended. Expected: removed from the queue, and `joinQueue` refuses. (Task 1 test)
- Elo loss larger than the current Elo. Expected: Elo floors at 0. (Task 1 test)
- The modal must be shown without `deferReply` first. Expected: the `reportpick` select opens the form. (Task 3: route before defer.)

---

### Task 1: Engine + types

**Files:** Modify `src/core/types.ts`, `src/core/engine.ts`, `src/bot/test-fixtures.ts`; Test `src/core/engine.test.ts`

**Produces:**
- `types.ts`: `Verdict`, `VERDICTS: readonly Verdict[]`, `ReportStatus = 'open'|'tied'|'closed'`, `Report { id, status, matchId, accusedId, reporters: {id, reason, at}[], ballots: Record<string, Verdict>, verdict: Verdict|null, decidedBy: 'council'|'admin'|null, closedBy: string|null, channelId: string|null, messageId: string|null, createdAt, closedAt: number|null }`.
- `Player`: optional `warnings?: number`, `queueBanUntil?: number|null`.
- `ServiceContract`:
  - `openReport(matchId, reporterId, accusedId, reason): Promise<{ report: Report; created: boolean }>`
  - `attachReport(id, channelId, messageId): Promise<void>`
  - `getReport(id): Promise<Report|null>`
  - `voteReport(id, voterId, verdict): Promise<Report>`
  - `closeReport(id, actorId): Promise<Report>`
  - `decideReport(id, actorId, verdict): Promise<Report>`

- [ ] Write tests: open / join up to 3 / 4th refused / duplicate refused / self and outsider refused / cancelled and >24h refused; vote refused for accused and reporter; close needs 2; majority `susp:3` blocks `joinQueue` and removes the accused from the queue; `elo:100` floors at 0 and adds an `elo_events` row; tie goes to `tied`, `voteReport` is refused, and `decideReport('warning')` sets `warnings=1`; closing twice is refused.
- [ ] Run them: they fail.
- [ ] Implement: the DDL with `UNIQUE(match_id, accused_id)`, the methods, and the `joinQueue` check.
- [ ] Run them: they pass.

### Task 2: Parsing + presentation

**Files:** Modify `src/bot/access.ts`, `src/bot/presentation.ts`; Test `access.test.ts`, `presentation.test.ts`

**Produces:**
- `ComponentAction` adds:
  - `{ kind: 'report' | 'reportpick'; matchId }` from `mm:m:<id>:report|reportpick`;
  - `{ kind: 'reportform'; matchId; accusedId }` from `mm:r:<id>:<snowflake>`;
  - `{ kind: 'ticket'; reportId; action: 'vote'|'close'|'decide' }` from `mm:t:<id>:vote|close|decide`.
- `verdictNames: Record<Verdict, string>`.
- `reportPresentation(report, accused: string): PanelPayload`: hides the per-voter ballots while the case is open; shows the vote select and the close button (disabled under 2 ballots) while open; shows the decide select while tied; shows no components when closed.
- `matchPresentation` adds a `Denunciar` button (`mm:m:<id>:report`) in `live`, `mvp` and `completed`. The button stays enabled on the result message.

### Task 3: Discord wiring

**Files:** Create `src/bot/reports.ts`; modify `src/bot/voice.ts` (`privateOverwrites` takes `roleIds: string[]`), `src/bot/handler.ts`, `src/bot/index.ts`; Test `handler.test.ts`

- `ensureCouncilRole(guild): Promise<Role>`: finds the role by name, or creates it.
- `reportInteraction(deps, interaction)` handles the 4 kinds:
  - `report`: sends the ephemeral select.
  - `reportpick`: `showModal` (no defer).
  - `reportform`: calls `openReport`, then creates the channel or adds the new reporter to it, and posts or refreshes the panel.
  - `ticket`: checks the council role or staff, calls the engine, refreshes the panel. On close it also locks the reporters out of writing and DMs the accused.
- The handler accepts `isModalSubmit()` and skips the defer for `reportpick`.
- Test: a `report` click from a non-participant is refused, and a participant gets the select.

### Task 4: Verify + commit

- [ ] `npm run typecheck`, then run the tests with `.env` moved aside.
- [ ] Commit only the files this work touched, using `git add <paths>`. The concurrent session's uncommitted changes in `engine.ts` must be handled before committing (see the final report).

# Sistema de denúncias (tickets) com o Conselho

## Por que

Um jogador que atrapalha a partida (seja jogador comum ou capitão) hoje não tem nenhuma consequência dentro do bot. Quem jogou junto precisa de um jeito de denunciar e mandar provas, e um grupo escolhido pelo dono (o cargo **Membro do Conselho**) julga o caso por votação.

## O que o usuário decidiu

- Quem denuncia são os jogadores da própria partida: clicam em **Denunciar**, escolhem o jogador e escrevem o motivo.
- Até **3 pessoas** podem denunciar o mesmo jogador na mesma partida. Todas entram no mesmo ticket.
- Abre um canal privado onde quem denunciou manda as provas: prints, links, clipes.
- Punições possíveis: **advertência**, **perda de Elo** e **suspensão da fila**. Cada conselheiro escolhe a punição no voto.
- A decisão é por maioria: vence a opção mais votada, com no mínimo **2 votos** de conselheiros. Se der empate, um admin decide.

## Fora do escopo

- Denúncia sem partida (fora do jogo, no chat do servidor etc.).
- Timeout ou ban no Discord.
- Recurso ou apelação do acusado.
- Mostrar as advertências e as punições no `/profile` ou no site. Fica para depois; os dados ficam guardados.
- Apagar o canal sozinho depois do fechamento. O canal fica arquivado e a staff apaga quando quiser.

## Como funciona (fluxo)

1. Botão **Denunciar** (`mm:m:<id>:report`) no painel da partida enquanto ela está `live` ou `mvp`, e na mensagem de resultado no canal público quando ela está `completed`. A denúncia pode ser aberta até **24h** depois de `finishedAt`. Partidas canceladas não aceitam denúncia.
2. O clique responde só para quem clicou, com um menu dos outros 11 jogadores (`mm:m:<id>:reportpick`). Só os 12 da partida podem usar o botão.
3. Ao escolher o jogador, abre um formulário (modal `mm:r:<matchId>:<accusedId>`) com o campo **Motivo** (10 a 500 caracteres).
4. O motor registra a denúncia:
   - Se ainda não existe ticket para esse acusado nessa partida, cria o ticket e o bot cria o canal `denuncia-0001` na categoria **Denúncias**.
   - Se já existe e está aberto, a pessoa entra no ticket (até 3), ganha acesso ao canal e o motivo dela é postado lá.
   - Se o caso já foi julgado, ou já tem 3 denunciantes, ou a pessoa já denunciou, a resposta é um erro claro.
5. Quem vê o canal: os denunciantes, o cargo Membro do Conselho, o cargo da staff (para o desempate) e o bot. **O acusado não vê.**
6. O painel do ticket mostra: acusado, partida, denunciantes e motivos, quantos votos já foram dados (sem mostrar o voto de cada um até fechar). Controles:
   - Menu **Votar** (`mm:t:<id>:vote`), só para o Conselho, com as opções Inocente, Advertência, Perder 25, 50 ou 100 de Elo, e Suspensão da fila por 1, 3 ou 7 dias. O conselheiro pode trocar o voto enquanto o caso está aberto.
   - Botão **Encerrar caso** (`mm:t:<id>:close`), só para o Conselho, liberado a partir de 2 votos.
7. Ao encerrar, se uma opção tiver mais votos que todas as outras, ela é aplicada e o caso fecha. Se houver empate no topo, o caso fica em `tied`, o bot marca o cargo da staff e aparece o menu **Decisão do admin** (`mm:t:<id>:decide`), só para a staff (o `isStaff` atual: cargo da staff, dono ou Gerenciar Servidor).
8. Ao fechar, o bot:
   - aplica a punição;
   - posta o resultado no ticket, já com o voto de cada conselheiro;
   - desliga os controles;
   - tira a permissão de escrever dos denunciantes;
   - manda uma DM ao acusado com a decisão (se a DM falhar, só registra no log).

## Regras do motor (`MatchmakingService`)

Métodos novos no `ServiceContract`, todos dentro de `transaction()` e todos com uma linha de auditoria:

| Método | Regras | Auditoria |
|---|---|---|
| `openReport(matchId, reporterId, accusedId, reason)` → `{ report, created }` | Denunciante e acusado estão na partida e são pessoas diferentes; a partida está `live`, `mvp` ou `completed` há no máximo 24h; motivo entre 10 e 500 caracteres; no máximo 3 denunciantes; sem repetição; o caso está `open` | `report.opened` / `report.joined` |
| `attachReportChannel(id, channelId, messageId)` | Guarda o canal e a mensagem do painel | — |
| `voteReport(id, voterId, verdict)` | O caso está `open`; o veredito é válido; quem vota não é o acusado nem um dos denunciantes | `report.voted` |
| `closeReport(id, actorId)` | O caso está `open`; tem 2 votos ou mais; a maioria aplica, o empate vai para `tied` | `report.closed` / `report.tied` |
| `decideReport(id, actorId, verdict)` | O caso está `tied` | `report.decided` |
| `getReport(id)`, `listOpenReports()` | Leitura | — |

O bot é quem confere se a pessoa tem o cargo do Conselho ou é staff, como já acontece hoje com `requireStaff`. O motor confere tudo o que dá para conferir sem o Discord.

Aplicação da punição (a mesma transação do fechamento):

- `warning`: `player.warnings = (warnings ?? 0) + 1`.
- `elo:N`: a mesma conta do `adjustElo`, ou seja, `delta = max(0, elo - N) - elo`, mais a linha em `elo_events`. Vale mesmo com o jogador em partida ativa, porque o `settle` relê o jogador do banco.
- `susp:D`: `player.queueBanUntil = max(now, queueBanUntil ?? 0) + D dias`; o jogador sai da fila se estiver nela. O `joinQueue` passa a recusar com "Você está suspenso da fila até <data>".

## Dados

Tabela nova, no mesmo estilo das outras (JSON na coluna `data`):

```sql
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,              -- open | tied | closed
  match_id INTEGER NOT NULL REFERENCES matches(id),
  accused_id TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (match_id, accused_id)
)
```

Formato do `Report`: `id, status, matchId, accusedId, reporters: {id, reason, at}[], ballots: Record<voterId, Verdict>, verdict: Verdict | null, decidedBy: 'council' | 'admin' | null, closedBy, channelId, messageId, createdAt, closedAt`.

`Verdict = 'innocent' | 'warning' | 'elo:25' | 'elo:50' | 'elo:100' | 'susp:1' | 'susp:3' | 'susp:7'`.

`Player` ganha dois campos opcionais: `warnings?` e `queueBanUntil?`. Jogadores antigos continuam funcionando sem migração.

## Bot

- **Cargo:** ao iniciar, o bot procura o cargo "Membro do Conselho" pelo nome e cria se não existir (o bot tem Administrator). O dono só entrega o cargo para quem quiser.
- **Canais:** `privateOverwrites` em `voice.ts` passa a aceitar uma lista de cargos, em vez de um só. A categoria "Denúncias" é achada ou criada pelo nome, como já acontece com a categoria "Matches".
- **Rotas:** o `handler` passa a aceitar envio de formulário (modal). Os prefixos novos são `mm:r:` e `mm:t:` em `parseCustomId`. O botão `report` não passa pela checagem "o painel tem que ser a mensagem atual da partida no canal atual", porque também fica na mensagem de resultado.
- **Painéis:** `reportPresentation(report, match)` fica em `presentation.ts`. O botão Denunciar entra em `matchPresentation` nos estados `live`, `mvp` e `completed` (no resultado).

## Abordagens consideradas

- **Escolhida:** tudo dentro do `MatchmakingService` atual, com uma tabela `reports` em JSON e as rotas no handler atual. Segue o padrão do projeto e reaproveita a fila de transações que corrigiu a corrida do `TRANSACTION_CLOSED`.
- **Descartada:** usar um bot de ticket pronto (Ticket Tool etc.). Não sabe quem jogou a partida e não aplica Elo nem suspensão.
- **Descartada:** votos numa tabela separada. O padrão do projeto guarda as cédulas no JSON (como `mvpBallots`), e nunca há mais que um punhado de votos por caso.

## Decisões minhas (para você conferir)

- Prazo de 24h depois da partida para denunciar.
- Valores de Elo (25, 50 e 100) e de suspensão (1, 3 e 7 dias).
- O voto fica secreto até o fechamento; depois aparece no ticket.
- O canal não é apagado sozinho.
- O acusado não vê o ticket e recebe uma DM com a decisão.
- Conselheiro que é o acusado ou um dos denunciantes não vota.

## Testes

- `engine.test.ts`:
  - abrir uma denúncia;
  - segundo e terceiro denunciante no mesmo ticket;
  - quarto denunciante e denúncia repetida recusados;
  - partida fora do prazo e partida cancelada recusadas;
  - quem está fora da partida, ou denuncia a si mesmo, é recusado;
  - votar com um voto e com dois;
  - maioria aplica a advertência, o Elo e a suspensão (e o `joinQueue` recusa);
  - empate vai para `tied` e o `decideReport` aplica.
- `access.test.ts`: `parseCustomId` com os ids novos.
- `presentation.test.ts`: o painel do ticket esconde os votos enquanto o caso está aberto e mostra no fechamento.

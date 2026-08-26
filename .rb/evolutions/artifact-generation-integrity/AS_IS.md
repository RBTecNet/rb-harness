# AS IS — geração, publicação e consumo dos artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: as-is-artifact-generation-integrity -->

## Fluxo implementado

1. OBSERVED: `packages/core/src/harness-generator.ts` pede um plano documental e autoria cada parte em chamadas fechadas. Uma parte recebe o ledger de coordenação e somente a parte contígua anterior do mesmo arquivo; não recebe o conteúdo final dos outros documentos já escritos.
2. OBSERVED: `packages/core/src/harness-workspace.ts` materializa o bundle numa árvore de staging, executa `syncManifest`, valida contratos, hashes e decomposição, e considera os erros estruturais elegíveis para uma única correção localizada.
3. OBSERVED: `packages/core/src/standalone-runner.ts` publica a árvore validada por renomeação atômica e imediatamente marca a execução como `complete`; não há nova validação read-only do destino publicado antes desse estado.
4. OBSERVED: `packages/core/src/execution-contract.ts` exige escopos delimitados, mas aceita `.rb/init/OPERATIONS.json` como um `Scope` válido.
5. OBSERVED: `packages/core/src/artifact-verifier.ts` verifica contratos e hashes, mas não possui um check de autoridade que rejeite tarefas escritoras de `.rb/**` nem um check de coerência entre caminhos operacionais e saídas planejadas.
6. OBSERVED: `packages/core/src/api-agent-tools.ts` rejeita escrita no diretório de artefatos para `ralph-agent`. Essa barreira existe apenas quando o provider usa essas ferramentas; um CLI externo escreve diretamente no worktree.

## Reprodução fornecida

| Momento | Evidência | Resultado |
|---|---|---|
| Publicação | manifesto de `Atravessar_a_rua`, `2026-08-26 01:38:30 -03:00` | `.rb/init/OPERATIONS.json` foi indexado com SHA-256 `5148cb0b…aee8f` |
| Primeira verificação | report `20260826043851-fc891ccc-5b42` | um plano pronto; sem hash stale |
| Execução P04 | `P04-attempt-1-changes.json` | o executor modificou `game.js` e `.rb/init/OPERATIONS.json` |
| Após a task operacional problemática | arquivo operacional, `2026-08-26 02:21:39 -03:00` | SHA-256 passou a `88561e90…901bb` |
| Verificação final | report `20260826141435-fc891ccc-7deb` | blocker `artifact.stale`; zero planos prontos para Ralph |

O `PHASES.md` reproduzido contém uma task com `Scope: .rb/init/OPERATIONS.json`, Change “Criar o contrato”, e validação `rb-harness operations validate`. O CLI atual responde que esse mesmo documento “conforms to rb-execution/v1”. Os 49 testes focados de execution contract, artifact verifier e generation recovery também passam.

## Deriva anterior à execução

- OBSERVED: no bundle preservado da geração, `ARCHITECTURE.md` e `OPERATIONS.json` escolheram `src/game.js`.
- OBSERVED: o plano executável escolheu `game.js` em suas tarefas.
- OBSERVED: o `OPERATIONS.json` publicado continha passos tipados e um script inline que procuravam `src/game.js`.
- OBSERVED: a correção estrutural validou a forma de `OPERATIONS.json`, mas não detectou a divergência com os caminhos finais do plano.
- OBSERVED: durante a task operacional, o executor descreveu o contrato publicado como semanticamente desonesto e o reescreveu para a implementação em `game.js`; o validador operacional passou, mas o manifesto ficou stale.

## Causa raiz

Há duas autoridades incompatíveis:

- O Harness publica `OPERATIONS.json` como artefato pronto e fixa seu hash.
- O template operacional diz que fases normais possuem a criação do contrato, e o validador permite que uma tarefa possua o próprio arquivo publicado.

A autoria incremental aumenta o risco porque documentos dependentes são escritos isoladamente. A validação atual prova cada formato isolado, mas não prova o grafo de autoridade entre os arquivos. O executor então recebe uma tarefa que tenta resolver em runtime uma contradição que deveria ter bloqueado ou sido reparada antes da publicação.

## Comportamento acidental a preservar como diagnóstico, não como permissão

`artifact.stale` está correto: ele evita que uma mutação seja silenciosamente abençoada. O defeito não é o hash ter falhado; é o sistema ter produzido e aceitado autoridade para mudar o arquivo cujo hash protege.

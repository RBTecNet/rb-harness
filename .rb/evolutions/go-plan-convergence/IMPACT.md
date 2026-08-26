# Impacto — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: impact-go-plan-convergence -->

## Mapa reader/writer/reactor

| Fronteira | Papel | Impacto |
|---|---|---|
| `harness-contract-digest.ts` | writer authority | ensina pós-validação, identidade, ordem e fechamento de `Scope` |
| `execution-contract.ts` | reader/parser puro | valida identidade e delega sinais finitos sem ler o checkout |
| `go-plan-convergence.ts` | classificador compartilhado | relaciona tarefa, critério, módulo, `tidy`, ordem, `Scope` e inventário |
| `artifact-consistency.ts` | reactor workspace-aware | injeta imports existentes uma vez por bundle |
| `harness-workspace.ts` | gate de staging/reparo | converte o finding em erro estrutural reparável |
| `artifact-verifier.ts` | gate público | bloqueia prontidão com o mesmo código/evidência |
| `cli-program.ts` | contrato público | aceita `--project` para inventário explícito |
| `headless-runner.ts` | gate headless | valida consistência antes de retornar `ready` |
| pacote/plugin | consumidor distribuído | recebe o mesmo classificador no build empacotado |

## Segurança, dados e operações

Não há migração de dados, permissão, tenant ou segredo. A varredura ignora diretórios de dependências/build, possui limite finito e nunca executa Go. Planos legados permanecem imutáveis, mas podem deixar de estar prontos quando a combinação for comprovada.

## Frescor

O incidente e todas as fronteiras acima foram lidos diretamente na revisão `b6c205bd532d8fe9e9e982bb9ed9b78f63dd3e49`; os hashes completos estão em `source-manifest.json`.

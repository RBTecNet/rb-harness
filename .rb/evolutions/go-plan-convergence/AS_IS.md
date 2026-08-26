# AS IS — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: as-is-go-plan-convergence -->

## Fluxo observado

1. `harness-contract-digest.ts` ensinava forma, escopo e comandos, mas não exigia que critérios sobrevivessem à lista completa de validações.
2. `execution-contract.ts` validava gramática e relações internas do `rb-execution/v1`, sem representar o efeito normalizador de `go mod tidy`.
3. `harness-workspace.ts` e `artifact-verifier.ts` consumiam as mesmas validações estruturais, portanto uma contradição semanticamente finita podia atravessar staging e verificação.
4. O executor tentava restaurar `go.mod` depois de `tidy` ou criar fonte fora do `Scope`; a validação seguinte removia novamente a dependência ou a fase terminava com expansão de escopo.

## Causa raiz

- OBSERVED no incidente: o estado exigido pelo critério, a autoridade de escrita e o estado pós-validação não eram relacionados.
- OBSERVED no contrato: nomes comerciais não forneciam identidade estruturada para ligar uma dependência a um import.
- OBSERVED nas portas: a ausência de um import existente exige conhecimento do projeto, mas o parser puro corretamente não possui essa autoridade.
- ACCIDENTAL LEGACY: tarefas de instalação antecipada eram estruturalmente válidas mesmo quando o gerenciador canônico removia seu resultado.

## Comportamento intencional preservado

`go mod tidy` comum, dependências já importadas, imports de subpacotes, tarefas sem novo requisito direto e validação sem toolchain Go continuam aceitos. O parser permanece puro e o filesystem entra somente por argumento nas portas workspace-aware.

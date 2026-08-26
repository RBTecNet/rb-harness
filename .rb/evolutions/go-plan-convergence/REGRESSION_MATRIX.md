# Matriz de regressão — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: regression-matrix-go-plan-convergence -->

| ID | Cenário | Resultado observável | Requisito | Validação |
|---|---|---|---|---|
| RG-001 | requisito direto + `tidy` + primeiro import em fase posterior | blocker identifica T001, AC, módulo, `tidy` e produtor posterior | RF-001, RF-003 | `go-plan-convergence.test.ts` |
| RG-002 | declaração/import/`tidy` na mesma tarefa e `Scope` | nenhum finding | RF-003, RF-004 | `go-plan-convergence.test.ts` |
| RG-003 | import existente de módulo ou subpacote | nenhum finding em staging/verificador/CLI | RF-004, RF-005 | teste focal e pacote instalado |
| RG-004 | produtor anterior explicitamente dependido | nenhum finding | RF-004 | `go-plan-convergence.test.ts` |
| RG-005 | produtor posterior sem `.go` no `Scope` | blocker sem aceitar o falso produtor | RF-003, RF-004 | `go-plan-convergence.test.ts` |
| RG-006 | `tidy` sem requisito direto ou critério negativo | nenhum finding | PR-003 | `go-plan-convergence.test.ts` |
| RG-007 | nome comercial sem caminho de módulo | finding de identidade, inclusive headless | RF-002, RF-005 | testes de contrato/headless |
| RG-008 | mesma árvore em staging e `artifacts verify` | código e evidência idênticos | RF-005 | `go-plan-convergence.test.ts` |
| RG-009 | geração recebe finding reparável | apenas `PHASES.md` é corrigido e publicado convergente | RF-006 | `standalone.test.ts` |
| RG-010 | pacote instalado valida variante inválida e existente | rejeita antes do import; aceita depois do import existente | RF-005 | `npm run check:package` |
| RG-011 | Go disponível, dois `tidy` consecutivos | hashes de `go.mod`/`go.sum` idênticos | RF-001 | integração condicional Vitest |

# Solicitação de evolução — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: change-request-go-plan-convergence -->

## Origem e objetivo

O incidente `docs/incidents/2026-08-26-harness-go-plan-convergence-correction.md` demonstrou que o Harness publicou uma tarefa que exigia dependências Go diretas, limitava o `Scope` a `go.mod`/`go.sum`, executava `go mod tidy` e adiava o primeiro import para uma fase futura. O objetivo é impedir que `init`, `plan`, `evolve`, `contract validate`, `artifacts verify` ou headless aprovem novamente essa combinação.

## Atores, gatilho e escopo

- Autor documental: recebe regras de convergência no digest code-owned.
- Staging e reparador: bloqueiam ou corrigem apenas o `PHASES.md` afetado antes da publicação.
- Operador: recebe o mesmo código estável no contrato, verificador e headless.
- RB Ralph: recebe somente planos cujo requisito continue verdadeiro depois do normalizador.

O escopo inclui classificação determinística Go de alta confiança, inventário explícito de imports, integração nas portas, orientação de autoria/reparo e regressões do pacote instalado.

## Fora de escopo

- Interpretar gerenciadores de dependência arbitrários.
- Executar `go mod tidy` durante toda validação documental.
- Alterar planos legados in-place ou modificar o projeto `tui_admin_samba`.
- Inventar imports sentinela, blank imports sem função de produto ou novas fronteiras arquiteturais.

## Decisões e prontidão

- CONFIRMED pelo incidente: HGC-001 a HGC-005 e os critérios de aceitação são autoridade da mudança.
- OBSERVED: o parser puro não acessa o filesystem; staging, verificador, CLI e headless possuem uma raiz de projeto explícita.
- ASSUMPTION de baixo risco: inventário truncado ou ilegível não prova ausência e portanto não pode gerar o finding de não convergência.
- Prontidão: `READY_WITH_ASSUMPTIONS`; nenhuma decisão material permanece aberta.

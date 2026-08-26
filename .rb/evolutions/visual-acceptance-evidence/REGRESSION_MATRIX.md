# Matriz de regressão: evidência de aceitação visual

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-regression

| ID | Cenário | Esperado | Validação |
|---|---|---|---|
| RG-001 | critério renderizado + `manual:` | rejeitar `visual-manual` e `visual-unproven` | execution-contract.test.ts |
| RG-002 | critério renderizado + teste fake DOM | rejeitar `visual-unproven` | execution-contract.test.ts |
| RG-003 | comando e2e sem artefato/viewport/geometria | rejeitar contrato incompleto | execution-contract.test.ts |
| RG-004 | critério sem controle negativo | rejeitar `visual-negative-control` | execution-contract.test.ts |
| RG-005 | automação visual com contrato completo | aceitar | execution-contract.test.ts |
| RG-006 | automação indisponível + `human:` completo | aceitar e preservar pausa | execution-contract.test.ts |
| RG-007 | interação sem antes/depois | rejeitar `visual-state-pair` | execution-contract.test.ts |
| RG-008 | stdout de CLI | não classificar como UI | execution-contract.test.ts |
| RG-009 | metacontrato sobre critérios visuais | não classificar como UI renderizada | execution-contract.test.ts |
| RG-010 | plano original Atravessar_a_rua | rejeitar T014 antes da execução | CLI contract validate |
| RG-011 | suíte completa do core | permanecer verde | npm test workspace |
| RG-012 | pacote/plugin | build e checks verdes | npm check |

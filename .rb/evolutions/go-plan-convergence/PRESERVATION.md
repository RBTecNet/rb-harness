# Preservação — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: preservation-go-plan-convergence -->

| ID | Disposição | Comportamento |
|---|---|---|
| PR-001 | CHANGE | plano com requisito direto, `tidy` e primeiro import posterior deixa de ser publicável |
| PR-002 | CHANGE | requisito direto sem caminho de módulo recebe finding de identidade |
| PR-003 | PRESERVE | `go mod tidy` sem novo requisito direto continua válido |
| PR-004 | PRESERVE | import existente do módulo ou subpacote evita falso positivo |
| PR-005 | PRESERVE | declaração, primeiro uso e validação na mesma tarefa continuam válidos |
| PR-006 | PRESERVE | produtor anterior explicitamente dependido continua válido |
| PR-007 | PRESERVE | validação documental não exige Go instalado |
| PR-008 | PRESERVE | parser de `rb-execution/v1` não realiza I/O implícito |
| PR-009 | PRESERVE | reparo não pode alterar documentos que o finding não nomeia |
| PR-010 | DEPRECATE | instalação Go antecipada que o normalizador poda antes do primeiro uso |
| PR-011 | UNKNOWN | gerenciadores e normalizadores fora da forma Go finita permanecem sem classificação semântica |

Todo comportamento não listado como `CHANGE` ou `DEPRECATE` permanece por padrão.

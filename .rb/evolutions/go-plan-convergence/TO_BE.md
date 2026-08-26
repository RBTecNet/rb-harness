# TO BE — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: to-be-go-plan-convergence -->

## Requisitos RIGID

- RF-001: critérios de aceitação são avaliados no estado deixado pela última validação canônica.
- RF-002: uma tarefa que exige dependência Go direta nomeia cada caminho de módulo em backticks; nomes comerciais isolados geram `execution.go-direct-requirement.module-identity-missing`.
- RF-003: requisito direto + `go mod tidy` + `go.mod` sob autoridade + ausência comprovada de import/produtor compatível gera `execution.go-tidy.nonconvergent-direct-requirement`.
- RF-004: um produtor planejado é compatível somente se possui fonte `.go` no `Scope`, cita import do módulo ou subpacote e é a mesma tarefa ou uma tarefa anterior da qual a resolução depende explicitamente.
- RF-005: staging, `artifacts verify`, `contract validate` com `--project` e headless usam a regra compartilhada e não declaram ausência quando o inventário é incompleto.
- RF-006: o finding é reparável e autoriza somente documentos afetados; a correção não cria fonte real nem reescreve documentos irmãos.

## Escolhas FLEXIBLE

A correção documental pode fundir declaração e primeiro uso, mover a declaração para a tarefa de uso ou ordenar um produtor anterior. A implementação interna pode usar regex e inventário estático desde que mantenha os limites de alta confiança.

## Falhas e aceitação

Inventário truncado ou arquivo `.go` ilegível resulta em ausência desconhecida e não em falso blocker. Um plano com primeiro uso posterior é rejeitado antes da publicação; a variante corrigida, um import existente e um `tidy` sem requisito novo são aceitos. Duas execuções reais consecutivas de `go mod tidy` deixam hashes idênticos quando Go está disponível.

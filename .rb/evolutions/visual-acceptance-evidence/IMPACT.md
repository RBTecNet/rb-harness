# Impacto: evidência de aceitação visual

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-impact

| Fronteira | Escritor | Leitor/reator | Impacto |
|---|---|---|---|
| PHASES.md | writers de init/plan/evolve/review | execution validator | novas falhas semânticas reparáveis |
| Validation | writer | Ralph executor/manager | UI usa browser real ou pausa humana |
| Expected evidence | writer | manager/auditor | prova contém viewport, screenshot e geometria |
| Critérios | specifier/planner | executor/manager | controle negativo explícito |
| Contrato Ralph | Harness | implementação Ralph | manual declarado não equivale a manual executado |
| Bundle standalone | build | CLI instalado/plugin | mesma contenção fora do checkout fonte |

## Compatibilidade

- Documentos sem semântica visual preservam o comportamento.
- Planos visuais antigos podem deixar de validar; isso é quebra deliberada de
  safety para planos ainda não executados, sem migração automática que invente
  ferramenta ou viewport.
- `human:` e a gramática Markdown existente são preservados; não há novo tipo
  de campo nem dependência de provider.

## Segurança e tenancy

Não há mudança de dados, segredo, autorização ou tenancy. Screenshots seguem a
política existente de não capturar segredos; o Harness apenas exige o contrato,
não acessa credenciais nem executa navegador externo.

## Frescor

Inspeção feita contra HEAD `8139720` e contra o plano original cujo SHA-256 é
`6c21416c140bc27952b8c83b03ca7b3f74f57208336e8f85d1dbcb5401c958cf`.

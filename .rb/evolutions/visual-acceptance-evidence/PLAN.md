# Plano: evidência de aceitação visual

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-plan

## P01 — Gate semântico

- T001 implementa detecção, rejeições e regressões focadas para RF-001..RF-003.

## P02 — Propagação contratual

- T002 propaga RF-001..RF-004 aos prompts, referências e writers.
- T003 atualiza contratos, invariantes de pacote e bundle instalado.

## Riscos

- Heurística lexical pode produzir falso positivo: preservar controles de CLI e
  metacontratos nos testes.
- Tooling visual não pode ser inventado: fallback obrigatório é `human:`.
- Cópias standalone/plugin podem divergir: o build e check-plugin são gates.

## Rollback

Reverter o gate e a documentação juntos. Não manter prompts que prometam uma
regra não aplicada nem um validador sem instruções de reparo.

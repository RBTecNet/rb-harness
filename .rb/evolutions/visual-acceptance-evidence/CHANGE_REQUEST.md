# Solicitação de Evolução: evidência de aceitação visual

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-change-request
**Readiness:** READY

## Objetivo

Impedir que critérios de UI sejam publicados como executáveis quando a única
prova é uma instrução `manual:`, presença de DOM ou mudança de estado lógico.

## Gatilho e atores

- Gatilho: incidente `Atravessar_a_rua`, documentado em
  `docs/incidents/2026-08-26-visual-acceptance-false-positive-harness.md`.
- Atores: autor do plano, validador determinístico, executor Ralph, gerente e
  operador responsável por evidência humana.

## Escopo

- Semântica visual de `rb-execution/v1`.
- Digest e writers de `init`, `plan`, `evolve` e `review`.
- Contratos de interoperabilidade Harness/Ralph.
- Regressões determinísticas do validador.

## Não objetivos

- Implementar o runner de screenshots do Ralph.
- Escolher framework frontend ou ferramenta de navegador universal.
- Corrigir o produto `Atravessar_a_rua`.

## Decisão normalizada

Sem automação visual grounded, o plano usa `human:` e pausa. Com automação, a
prova registra screenshot, viewport, geometria/computed style, controles
negativos e, quando aplicável, estados antes/depois.

Não há pergunta material em aberto; viewport concreta é parâmetro FLEXIBLE de
validação, não requisito inventado do produto.

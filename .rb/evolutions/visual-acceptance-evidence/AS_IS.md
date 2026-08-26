# AS IS: aceitação visual antes da contenção

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-as-is

- **OBSERVED:** `parseValidationInstruction` distinguia `command`, `manual` e
  `human`, mas `validateExecutionMarkdown` não comparava a capacidade da prova
  com o texto dos critérios (`packages/core/src/execution-contract.ts`).
- **OBSERVED:** o digest permitia `manual:` para qualquer inspeção observável,
  sem regra especial de UI (`packages/core/src/harness-contract-digest.ts`).
- **OBSERVED:** o template operacional mencionava screenshots como opção, mas
  não exigia viewport, geometria nem artefato durável
  (`resources/references/operational-template.md`).
- **OBSERVED:** a política forte de geometria e cobertura visual existia no
  fluxo de review, não nos writers que produziram o plano do incidente
  (`plugins/rb-harness/skills/rb-review/references/responsive-evidence.md`).
- **OBSERVED:** o plano `Atravessar_a_rua` omitiu `OPERATIONS.json` por falta de
  entrypoint grounded, mas publicou tasks visuais com `manual:` e readiness.
- **ACCIDENTAL LEGACY:** `manual:` virou fallback geral de greenfield quando a
  stack não estava definida.
- **CONFLICT:** a documentação dizia para não fingir prova visual automática,
  enquanto o validador aceitava um plano sem prova visual e sem pausa.

O Harness não causou o CSS defeituoso nem o `PASS` final do gerente, mas tornou
o falso positivo possível ao publicar um contrato de execução subespecificado.

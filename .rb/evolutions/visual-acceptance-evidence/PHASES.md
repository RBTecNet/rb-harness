# RB Execution Plan: visual-acceptance-evidence

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: evolution-visual-acceptance-phases -->

## Phase 1: Rejeitar prova visual insuficiente

**Phase ID:** P01
**Goal:** O contrato rejeita planos no formato do incidente sem afetar critérios não visuais.
**Depends on:** none
**Context:**
- `.rb/evolutions/visual-acceptance-evidence/AS_IS.md`
- `.rb/evolutions/visual-acceptance-evidence/TO_BE.md`
- `.rb/evolutions/visual-acceptance-evidence/REGRESSION_MATRIX.md`

- [x] T001 — Implementar o gate semântico e regressões
  - **Scope:** `packages/core/src/execution-contract.ts`, `packages/core/test/execution-contract.test.ts`, `tests/fixtures/execution/invalid/visual-manual/`
  - **Change:** Relacionar a capacidade da validação à semântica dos critérios, rejeitar prova insuficiente e preservar controles contra falsos positivos.
  - **Covers:** RF-001, RF-002, RF-003, RG-001, RG-002, RG-003, RG-004, RG-005, RG-006, RG-007, RG-008, RG-009, RG-010
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: O validador rejeita critérios de aceitação visual sustentados apenas por `manual:`, DOM falso ou teste genérico.
    - AC-T001-02: O validador exige artefato, viewport, geometria, controle negativo e estados antes/depois conforme a categoria do critério.
    - AC-T001-03: Critérios comuns de stdout e metacontratos sobre validação visual continuam aceitos sem gate de UI.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- execution-contract.test.ts`
    - `npm run typecheck --workspace @rb-harness/core`
  - **Expected evidence:** Código do gate, regressões focadas e exit status zero dos dois comandos.

## Phase 2: Propagar a política e empacotar

**Phase ID:** P02
**Goal:** Todos os writers e consumidores recebem a mesma política validada no bundle instalado.
**Depends on:** P01
**Context:**
- `.rb/evolutions/visual-acceptance-evidence/TO_BE.md`
- `.rb/evolutions/visual-acceptance-evidence/IMPACT.md`
- `.rb/evolutions/visual-acceptance-evidence/PRESERVATION.md`

- [x] T002 — Propagar a política aos autores
  - **Scope:** `packages/core/src/harness-contract-digest.ts`, `resources/references/`, `resources/workflows/`, `plugins/rb-harness/references/`, `plugins/rb-harness/agents/`, `plugins/rb-harness/skills/`
  - **Change:** Instruir init, plan, evolve e review a produzir automação visual grounded ou pausa humana com evidência durável e controle negativo.
  - **Covers:** RF-001, RF-002, RF-003, RF-004
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: O digest e cada writer relevante descrevem a mesma fronteira entre browser automation, `human:` e prova insuficiente.
    - AC-T002-02: A política não inventa stack, ferramenta de navegador nem requisito de produto.
  - **Validation:**
    - `node scripts/check-plugin.mjs`
  - **Expected evidence:** Recursos e writers sincronizados e check de invariantes com exit status zero.

- [x] T003 — Publicar contratos e bundle coerentes
  - **Scope:** `contracts/`, `scripts/check-plugin.mjs`, `packages/core/test/documentation-core.test.ts`, `plugins/rb-harness/contracts/`, `plugins/rb-harness/standalone-resources/`, `plugins/rb-harness/scripts/rb-harness.cjs`, `docs/incidents/`
  - **Change:** Documentar a semântica interoperável, verificar os invariantes e reconstruir as cópias distribuídas e o CLI plugin.
  - **Covers:** RF-004, RG-011, RG-012
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T003-01: O contrato distribuído declara que `manual:` é instrução e que critérios de aceitação visual exigem prova executável ou pausa humana.
    - AC-T003-02: O pacote e o plugin contêm os mesmos contratos, recursos e gate determinístico.
  - **Validation:**
    - `npm run build --workspace @rb-harness/core`
    - `npm run check:package`
    - `node scripts/check-plugin.mjs`
  - **Expected evidence:** Contratos, bundle reconstruído e exit status zero de build, package check e plugin check.

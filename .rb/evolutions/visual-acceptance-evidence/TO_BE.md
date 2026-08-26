# TO BE: contrato de evidência visual

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-to-be

## Requisitos RIGID

### RF-001 — Capacidade da prova

Um critério que exige apresentação renderizada não pode usar `manual:` como
prova de conclusão. Deve usar comando one-shot de navegador/visual ou `human:`.

### RF-002 — Evidência durável

Expected evidence de uma task de apresentação deve nomear screenshot durável,
viewport numérica exata e geometria ou estilo computado. Mudanças visuais por
interação preservam estados antes e depois.

### RF-003 — Controle negativo

Cada task de apresentação deve rejeitar ao menos uma classe representativa de
corrupção: elemento essencial oculto, cortado, sobreposto, fora da viewport,
área zero ou texto CSS/JavaScript exposto como conteúdo.

### RF-004 — Propagação e interoperabilidade

A regra deve existir no digest code-owned, referências, workflows/writers,
contrato distribuído e validador. Uma linha `manual:` continua sendo instrução;
sem registro separado de execução permanece `UNPROVEN`.

## FLEXIBLE

- Ferramenta de browser automation.
- Viewport representativa usada como parâmetro de validação.
- Local exato do screenshot, desde que seja durável e auditável.

## Critérios de aceitação

- Um plano no formato do incidente é rejeitado antes da publicação.
- Automação Playwright/Cypress/Puppeteer/Selenium/CDP ou script visual grounded
  pode validar quando cumpre o contrato de evidência.
- `human:` permanece uma rota honesta e pausável quando automação inexiste.
- Um critério comum de stdout não é classificado como apresentação renderizada.

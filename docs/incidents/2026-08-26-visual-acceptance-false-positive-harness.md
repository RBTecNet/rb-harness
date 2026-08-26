# Incidente: Harness aceitou prova manual para critérios visuais

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

- Data da análise: 2026-08-26
- Incidente de origem: `Atravessar_a_rua`, run `phases-init-6c21416c140b`
- Fonte fornecida: relatório do RB Ralph com SHA-256
  `d0301aededc10585ecbc38bd8ce48da23ab71e99b6c792d362ed483df80f7e89`
- Escopo deste registro: causas e contenções pertencentes ao RB Harness

## Falha observada

O Harness publicou `T014` com critérios que exigiam tabuleiro e veículos
visíveis, mas a única validação era `manual: inspect the board renderer...`.
`Expected evidence` citava somente os diretórios de implementação. O documento
passou no validador determinístico e ficou elegível para execução, embora não
exigisse renderer real, screenshot, viewport, estilo computado ou geometria.

O defeito de produto — um `<style class="board-style">` com `display: contents`
que expunha o texto CSS no grid — preservava DOM, seletores, teclado e mudanças
de estado. Por isso provas estruturais não o detectaram.

## Causas no Harness

1. `rb-execution/v1` validava a forma de `manual:`, mas não relacionava a
   capacidade da validação com a semântica visual dos critérios.
2. Em projeto greenfield sem stack ou entrypoint confirmados, o gerador usou
   `manual:` como fallback inclusive para UI e ainda publicou readiness.
3. A orientação de `human:`/`HUMAN_PENDING` já existia, mas não era obrigatória
   quando a prova visual não podia ser automatizada.
4. A orientação operacional mencionava screenshots, porém não exigia um
   contrato durável com viewport, estados e geometria, e `OPERATIONS.json` foi
   honestamente omitido por falta de entrypoint.
5. A política responsiva forte estava restrita ao fluxo `review`; os writers de
   `init`, `plan` e `evolve` não compartilhavam essa contenção.
6. Não havia controle negativo obrigatório para CSS/JS exposto, elementos
   ocultos/cortados/sobrepostos/fora da viewport ou geometria com área zero.

## Correções

- O validador agora reconhece critérios visuais em inglês e português e rejeita
  `manual:` como prova de conclusão.
- Sem comando one-shot de navegador/visual reconhecível, o plano precisa usar
  `human:`, preservando a pausa explícita.
- A evidência visual precisa nomear screenshot durável, viewport numérica exata
  e medidas de geometria/estilo computado.
- Critérios visuais precisam de um controle negativo de corrupção; interações e
  animações precisam preservar evidência antes e depois.
- A mesma política foi propagada ao digest code-owned, referências, contratos,
  workflows standalone e writers de `init`, `plan`, `evolve` e `review`.
- O contrato distribuído ao Ralph esclarece que uma linha `manual:` é instrução,
  não resultado; sem registro separado de execução ela permanece `UNPROVEN`.

## Regressão

`packages/core/test/execution-contract.test.ts` cobre:

- rejeição de inspeção manual para UI;
- rejeição de DOM falso ou teste genérico como prova visual;
- screenshot, viewport, geometria e controle negativo obrigatórios;
- aceitação de automação visual real;
- aceitação de `human:` quando automação não existe;
- par antes/depois para estado visual interativo;
- ausência de falso positivo para stdout de CLI.

O plano original de `Atravessar_a_rua` passa a falhar deterministicamente nos
critérios visuais, inclusive em `T014`, antes da publicação/execução.

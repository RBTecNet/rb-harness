# Project Brief: cron-helper-web

## Objective

Aplicação web em Node.js e TypeScript com duas abas: explicar uma linha cron existente e gerar uma linha cron via modelo de IA a partir de um prompt, com explicação campo a campo.

## Confirmed determinations

- O projeto é uma aplicação web em Node.js com TypeScript. — Explicitamente pedido no request.
- A interface é dividida em duas abas: explicação de cron e geração por IA. — Estrutura de UI exigida pelo request.
- O modelo de IA é configurado por variáveis de ambiente .env: AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_TIMEOUT_MS, AI_TEMPERATURE, AI_MAX_OUTPUT_TOKENS. — Nomes definidos literalmente no request.
- A resposta da aba de IA retorna a linha cron completa e a explicação de cada campo. — Requisito explícito de saída.
- API compatível com OpenAI (POST /chat/completions) — Formato mais suportado por provedores e servidores locais; troca de modelo apenas mudando AI_BASE_URL.
- HTML/TS estático servido pelo Express — Duas abas simples não justificam framework; reduz build e dependências no MVP.
- 5 campos + macros @daily/@reboot — Cobre o crontab real do Linux, foco do projeto, sem extensões não-padrão.

## Assumptions and defaults

- A explicação de linhas cron existentes usa parser local determinístico, sem chamar IA. — Aba 1 fica rápida, offline e testável.
- Textos da interface e explicações em português. — Request escrito em português.

## Requirements

- R-001 — Aba 1 permite digitar uma linha cron existente e exibe em linguagem natural o que ela faz.
- R-002 — Aba 2 permite digitar um prompt e retorna a linha cron gerada pela IA com explicação de cada campo.
- R-003 — Cliente de IA configurado por AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_TIMEOUT_MS, AI_TEMPERATURE, AI_MAX_OUTPUT_TOKENS.
- R-004 — Carregamento e validação das variáveis .env na inicialização, com erro claro quando ausentes ou inválidas.
- R-005 — Parser de expressões cron de 5 campos com suporte a *, listas, intervalos, passos e nomes de mês/dia.
- R-006 — API HTTP com endpoints para explicar e para gerar linha cron, com validação de entrada.
- R-007 — Interface web servida pelo backend com navegação entre as duas abas.
- R-008 — Tratamento de entrada inválida e de falha/timeout do provedor de IA com mensagem ao usuário.
- R-009 — Testes automatizados do parser cron e dos endpoints, com cliente de IA mockado.

## Protected paths

- `.rb` — RB artifact control plane
- `.rb-harness` — RB Harness orchestration state
- `.git` — Version-control internals

## Quality context

- build
- lint
- test
- typecheck

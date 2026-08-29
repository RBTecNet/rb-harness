# RB Execution Plan: cron-helper-web

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: cron-helper-web-execution -->

## Phase 1: Base do projeto e configuração

**Phase ID:** P01
**Goal:** Estabelecer projeto Node/TypeScript com carregamento validado das variáveis de ambiente de IA.
**Depends on:** none
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T001 — Configurar projeto Node.js + TypeScript
  - **Scope:** `.gitignore`, `eslint.config.js`, `package.json`, `tsconfig.json`
  - **Change:** Criar package.json, tsconfig e scripts npm de typecheck, lint, test e build para o backend Express em TypeScript.
  - **Covers:** R-006
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: Os scripts npm typecheck, lint, test e build existem e terminam com código de saída 0.
    - AC-T001-02: O compilador TypeScript emite artefatos em dist/ a partir de src/.
  - **Validation:**
    - `npm ci`
    - `npm run typecheck`
    - `npm run lint`
    - `npm run build`
  - **Expected evidence:** Saída dos comandos npm ci, npm run typecheck, npm run lint e npm run build sem erros.

- [ ] T002 — Carregar e validar variáveis .env de IA
  - **Scope:** `.env.example`, `src/config/env.ts`, `tests/env.test.ts`
  - **Change:** Implementar módulo de configuração que lê e valida AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_TIMEOUT_MS, AI_TEMPERATURE e AI_MAX_OUTPUT_TOKENS na inicialização.
  - **Covers:** R-004, R-008
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: Com as seis variáveis definidas e válidas, a função de carga retorna um objeto tipado com valores numéricos convertidos.
    - AC-T002-02: Com variável obrigatória ausente ou numérica inválida, a carga lança erro cuja mensagem cita o nome da variável.
    - AC-T002-03: O arquivo .env.example lista exatamente as seis variáveis exigidas.
  - **Validation:**
    - `npm test`
    - `npm run typecheck`
  - **Expected evidence:** Relatório de npm test com casos de env válido e inválido aprovados.

## Phase 2: Parser cron e cliente de IA

**Phase ID:** P02
**Goal:** Fornecer explicação determinística de cron e geração via provedor de IA compatível com OpenAI.
**Depends on:** P01
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T003 — Implementar parser e explicador de expressões cron
  - **Scope:** `src/cron/explain.ts`, `src/cron/parser.ts`, `tests/cron-parser.test.ts`
  - **Change:** Implementar parser de cron de 5 campos com *, listas, intervalos, passos, nomes de mês/dia e macros @daily/@reboot, gerando explicação em português por campo.
  - **Covers:** R-001, R-005
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T003-01: A entrada "*/15 9-17 * * 1-5" produz explicação em português com um texto por campo minuto, hora, dia do mês, mês e dia da semana.
    - AC-T003-02: As macros @daily e @reboot são reconhecidas e explicadas sem erro.
    - AC-T003-03: Entrada com número de campos inválido ou valor fora de faixa gera erro de validação identificando o campo.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** Relatório de npm test com a suíte do parser cron totalmente aprovada.

- [ ] T004 — Implementar cliente de IA configurável
  - **Scope:** `src/ai/client.ts`, `src/ai/prompt.ts`, `tests/ai-client.test.ts`
  - **Change:** Implementar cliente HTTP para POST /chat/completions compatível com OpenAI usando a configuração de ambiente e retornando linha cron mais explicação por campo.
  - **Covers:** R-002, R-003, R-008
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T004-01: A requisição enviada usa AI_BASE_URL, cabeçalho de autorização com AI_API_KEY e corpo com AI_MODEL, AI_TEMPERATURE e AI_MAX_OUTPUT_TOKENS.
    - AC-T004-02: A resposta do provedor é convertida em objeto com a linha cron completa e a lista de explicações por campo.
    - AC-T004-03: Quando o provedor excede AI_TIMEOUT_MS ou responde com erro, o cliente lança erro tipado com mensagem em português.
  - **Validation:**
    - `npm test`
    - `npm run typecheck`
  - **Expected evidence:** Relatório de npm test com provedor de IA mockado cobrindo sucesso, timeout e erro.

## Phase 3: API HTTP e interface web

**Phase ID:** P03
**Goal:** Expor endpoints validados e servir a interface de duas abas.
**Depends on:** P02
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T005 — Expor endpoints de explicação e geração
  - **Scope:** `src/routes/cron.ts`, `src/server.ts`, `tests/api.test.ts`
  - **Change:** Criar servidor Express com POST /api/explain e POST /api/generate, validação de entrada e mapeamento de erros para status HTTP.
  - **Covers:** R-006, R-008, R-009
  - **Depends on:** T003, T004
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T005-01: POST /api/explain com expressão válida responde 200 com JSON contendo explicação por campo.
    - AC-T005-02: POST /api/explain com corpo vazio ou expressão inválida responde 400 com mensagem de erro em português.
    - AC-T005-03: POST /api/generate com prompt válido responde 200 com linha cron e explicações, usando o cliente de IA mockado nos testes.
    - AC-T005-04: Falha ou timeout do provedor de IA em /api/generate responde 502 com mensagem de erro.
  - **Validation:**
    - `npm test`
    - `npm run lint`
  - **Expected evidence:** Relatório de npm test com casos de API 200, 400 e 502 aprovados.

- [ ] T006 — Servir interface web com duas abas
  - **Scope:** `public/index.html`, `src/client/main.ts`, `tests/ui.test.ts`
  - **Change:** Criar página HTML com TypeScript de front-end contendo abas de explicação e de geração, servida estaticamente pelo Express.
  - **Covers:** R-001, R-002, R-007
  - **Depends on:** T005
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T006-01: GET / responde 200 e o HTML contém dois controles de aba e os dois formulários com identificadores distintos.
    - AC-T006-02: Ao ativar uma aba, o painel correspondente fica presente no DOM e o outro painel recebe o atributo hidden.
    - AC-T006-03: O envio do formulário da aba 1 chama POST /api/explain e insere o texto da explicação no elemento de resultado.
    - AC-T006-04: O envio do formulário da aba 2 chama POST /api/generate e insere a linha cron e as explicações por campo no elemento de resultado.
    - AC-T006-05: Erro retornado pela API é inserido como texto na região de mensagem de erro do DOM.
  - **Validation:**
    - `npm test`
    - `npm run build`
    - human: Executar a aplicação no navegador e confirmar que a navegação entre as duas abas e os dois fluxos são utilizáveis.
  - **Expected evidence:** Relatório de npm test com asserções de DOM das abas e chamadas de API aprovadas, e build sem erros.

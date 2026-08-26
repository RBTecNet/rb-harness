# Contrato consolidado do RB Ralph

Este documento especifica a fronteira completa observável do RB Ralph: quais
artefatos um gerador deve produzir, como esses artefatos são descobertos e
validados, como executor e gerente se comunicam com o runtime e quais estados,
gates, evidências e códigos de saída um operador pode esperar.

Esta consolidação corresponde ao RB Ralph `0.8.11`. Os contratos de dados
consumidos pelo runtime possuem versões próprias e continuam sendo a autoridade
formal:

- `rb-manifest/v1` para descoberta e integridade da árvore de artefatos;
- `rb-execution/v1` para o plano executável em Markdown;
- `rb-operational/v1` para aceitação operacional opcional em ambiente limpo;
- `rb-ralph-usage/v1` para telemetria opcional de providers.

Alterações incompatíveis em qualquer uma dessas fronteiras exigem uma nova
versão do respectivo contrato. Uma versão nova do executável, isoladamente, não
altera a semântica de um contrato versionado.

## 1. Papéis e autoridade

O RB Ralph coordena quatro autoridades distintas:

1. O plano validado define o trabalho, suas dependências, critérios e provas
   exigidas.
2. O executor altera o projeto, mas não decide sozinho que concluiu.
3. Os gates determinísticos executam e registram as validações declaradas.
4. O gerente inspeciona código e evidências em uma chamada independente e
   decide `COMPLETE`, `RETRY` ou `BLOCKED`.

A ordem de autoridade aplicada ao executor é:

1. extrato validado da task ou fase atual;
2. estado atual do repositório;
3. validações e evidências canônicas;
4. memória e narrativa anterior, apenas como contexto consultivo.

Uma afirmação otimista do executor ou do gerente nunca supera:

- exit code não zero do executor;
- falha de integração de patches paralelos;
- validação determinística vermelha;
- violação do plano de controle do Ralph;
- contrato operacional explícito com falha.

O Ralph não cria commit visível, não muda a branch atual e não executa push.
Objetos Git temporários criados por worktrees não alteram essa garantia.

## 2. Pacote mínimo aceito

### 2.1 Com manifesto

O pacote canônico contém:

```text
<project-root>/
└── .rb/
    ├── rb-manifest.json
    ├── artifacts.tsv                 # índice derivado, não é a autoridade
    └── <workflow>/
        ├── PHASES.md                 # obrigatório para execução
        ├── OPERATIONS.json           # opcional, recomendado
        └── demais documentos citados por Context
```

O operador pode selecionar outro diretório físico com `--artifacts-dir` ou
`--fragments-dir`. Mesmo nesse caso, os paths lógicos do manifesto permanecem
sob `.rb/`. Por exemplo, `.rb/init/PHASES.md` pode ser resolvido fisicamente
como `.spec/init/PHASES.md`.

Antes de iniciar qualquer provider, o Ralph valida a árvore inteira. Manifesto
inválido, hash stale, arquivo ausente, path inseguro, ID duplicado ou contrato
incompatível encerram o comando sem cobrar uma chamada de IA.

### 2.2 Sem manifesto

Se o diretório selecionado não contém `rb-manifest.json`, o Ralph ativa a
descoberta limitada de fragmentos compatíveis. Atualmente essa compatibilidade
procura recursivamente:

- `PHASES.md`;
- `project-phases.md` no formato importável `beer-and-code/v1`.

Restrições da descoberta:

- o diretório deve ser uma pasta regular dentro do projeto, nunca symlink;
- symlinks encontrados durante a varredura são ignorados;
- no máximo 10.000 entradas e 2.000 candidatos;
- planos convertidos são materializados numa pasta temporária, validados como
  `rb-execution/v1` e removidos após a execução;
- um fragmento não importável é ignorado com aviso; se nenhum plano for
  compatível, nenhum provider é iniciado.

A conversão de formatos externos é uma conveniência específica do runtime. Um
novo harness deve preferir emitir diretamente os três contratos versionados.

## 3. `rb-manifest/v1`

### 3.1 Forma obrigatória

```json
{
  "manifestVersion": "rb-manifest/v1",
  "project": {
    "id": "project-id",
    "name": "Project name"
  },
  "artifactRoot": ".rb",
  "generatedAt": "2026-08-25T00:00:00.000Z",
  "artifacts": [
    {
      "id": "project-execution",
      "kind": "execution-plan",
      "path": ".rb/init/PHASES.md",
      "status": "ready",
      "sha256": "<64 caracteres hexadecimais minúsculos>",
      "contract": "rb-execution/v1"
    }
  ]
}
```

Não são aceitas propriedades extras no objeto raiz, em `project` ou nos
registros de `artifacts`.

### 3.2 Invariantes

- `manifestVersion` deve ser exatamente `rb-manifest/v1`.
- `project.id` corresponde a `^[a-z0-9][a-z0-9-]*$`.
- `project.name` não pode ser vazio.
- `artifactRoot` é sempre `.rb` na versão 1.
- `generatedAt` deve ser uma data/hora ISO válida.
- IDs e paths de artefatos devem ser únicos.
- Todo path deve começar com `.rb/`, permanecer dentro do diretório físico de
  artefatos e apontar para um arquivo existente.
- `sha256` deve coincidir com os bytes atuais do arquivo.
- `status` admite apenas `draft`, `ready`, `blocked` ou `invalid`.
- Um plano selecionável possui `kind: execution-plan`, `status: ready` e
  `contract: rb-execution/v1`.
- O `id` do registro de um plano deve coincidir com o marcador
  `rb-artifact-id` dentro de `PHASES.md`.

Para planos, a sincronização deriva o status desta forma:

- contrato estrutural inválido: `invalid`;
- documento contendo `[NEEDS DECISION]` ou
  `<!-- rb-readiness: blocked -->`: `blocked`;
- documento contendo `[DRAFT]` ou `<!-- rb-readiness: draft -->`: `draft`;
- contrato válido sem marcador de bloqueio/rascunho: `ready`.

O arquivo `artifacts.tsv`, quando presente, é derivado do JSON e começa com:

```text
# rb-artifacts-index: rb-manifest/v1
# generated-from: .rb/rb-manifest.json
id	kind	status	contract	path	sha256
```

## 4. `rb-execution/v1` — `PHASES.md`

### 4.1 Gramática do documento

O primeiro conteúdo não vazio deve ser:

```markdown
# RB Execution Plan: <nome não vazio>
```

Antes da primeira fase devem existir exatamente uma vez:

```markdown
<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: project-execution -->
```

O ID do artefato segue `^[a-z0-9][a-z0-9-]*$`.

Os únicos headings de nível 2 permitidos são fases contíguas:

```markdown
## Phase 1: <título>
## Phase 2: <título>
```

A numeração começa em 1 e não pode pular ou repetir valores.

### 4.2 Forma de uma fase

```markdown
## Phase 1: Implement the capability

**Phase ID:** P01
**Goal:** Observable outcome owned by this phase.
**Depends on:** none
**Context:**
- `.rb/init/PROJECT.md`
- `.rb/init/REQUIREMENTS.md`
```

Regras:

- `Phase ID` é derivado do número: fase 1 é `P01`, fase 12 é `P12`.
- `Goal` é obrigatório e não vazio.
- `Depends on` é obrigatório. Use `none` ou IDs de fases anteriores,
  separados por vírgula.
- `Context` deve listar ao menos um item. Os itens devem permitir que um agente
  iniciado sem contexto de conversa encontre a autoridade necessária.
- Dependências futuras ou inexistentes são inválidas.
- Fases são sempre executadas sequencialmente pelo Ralph.

### 4.3 Forma de uma task

```markdown
- [ ] T001 — Implement behavior
  - **Scope:** `src/`, `tests/`
  - **Change:** Implement RF-001 while preserving unrelated behavior.
  - **Covers:** RF-001, RNF-002
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: Given a valid request, the public operation returns status 200 and the persisted result is observable through the documented read interface.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** Changed source, regression coverage and passing command output.
```

Regras estruturais:

- `Scope` cobre somente caminhos de implementação. `.rb`, `.rb/**` e qualquer
  artefato gerado são autoridade imutável: podem ser lidos via `Context` ou por
  um validador read-only, nunca criados ou alterados por uma task;

- O heading corresponde exatamente a
  `- [ ] TNNN — <título>` ou `- [x] TNNN — <título>`.
- O travessão é `—`; hífen comum não substitui o delimitador no contrato
  canônico.
- IDs seguem `T` e pelo menos três dígitos (`T001`, `T1000`).
- IDs são globalmente únicos, numericamente ascendentes no documento inteiro e
  nunca reiniciam em outra fase.
- `[x]` significa documentalmente concluída; `[ ]` significa pendente.
- Toda fase possui pelo menos uma task.
- São obrigatórios e não vazios: `Scope`, `Change`, `Covers`, `Depends on`,
  `Parallel safe`, `Acceptance criteria`, `Validation` e `Expected evidence`.
- `Depends on` aceita `none` ou somente IDs de tasks anteriores separados por
  vírgula.
- `Parallel safe` aceita exatamente `true` ou `false`.
- Cada task possui ao menos um critério e uma validação.

### 4.4 Critérios de aceitação

Cada critério segue:

```text
AC-TNNN-NN: <resultado observável e binário>
```

O prefixo deve usar exatamente o ID da task. O critério precisa declarar o
comportamento observável; não pode terceirizar seu significado para `RF-001`,
`RNF-002`, `UI-003` ou `CT-004`.

São rejeitados, entre outros:

- “satisfaz RF-001” ou “comportamento conforme RNF-002”;
- “funciona corretamente”, “trata os erros”, “quando aplicável”;
- “adequado”, “apropriado”, “razoável”, “conforme necessário”, `etc.`;
- exigir que `OPERATIONS.json` já tenha passado durante uma fase normal.

O Harness cria e valida `OPERATIONS.json` antes de publicar. Nenhuma task normal
é dona desse arquivo. A execução clean-room do contrato pertence exclusivamente
à fase final RBF, criada em runtime.

### 4.5 Validações

Cada entrada possui exatamente uma destas formas:

```markdown
- `comando não interativo`
- manual: inspeção observável pelo gerente
- human: evidência externa indisponível ao executor/gerente
```

Semântica:

- `command` é executado pelo Ralph em `validation-mode=run`.
- `manual` é enviado ao gerente e não deve disfarçar um comando executável.
- `human` pausa a fase antes de chamar qualquer provider e encerra com status 2.

Um comando não pode esconder falha com `|| true`, `; true` ou `exit 0`. Ele
deve ser não interativo, não destrutivo para o projeto/estado externo e retornar
o exit code real.

Textos como `manual: execute npm test` são inválidos: declare o comando exato
entre crases. Use `human:` apenas quando a prova realmente depende de uma
pessoa ou sistema externo.

### 4.6 Escopo e validação incremental

`Scope` é texto para o executor, mas também possui uma função mecânica. Para que
o cache incremental prove impacto limitado, os paths devem aparecer entre
crases, por exemplo:

```markdown
  - **Scope:** `src/auth/`, `tests/auth/**`, `config/security.ts`
```

Após a baseline de validação da fase, o Ralph cruza paths alterados com esses
tokens e expande o impacto para tasks dependentes. Resultados verdes de
comandos não afetados podem ser reutilizados.

O fallback é executar a matriz completa quando:

- não existem paths alterados observáveis;
- a captura de mudanças possui limitações;
- uma task pendente não tem scope delimitável por paths entre crases;
- algum path alterado não pertence ao scope de nenhuma task pendente.

Logo, um scope amplo é válido, mas reduz a capacidade de economizar testes; um
scope incorreto pode causar fallback ou evidência insuficiente.

### 4.7 Exemplo mínimo completo

```markdown
# RB Execution Plan: example

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: example-execution -->

## Phase 1: Implement example

**Phase ID:** P01
**Goal:** Expose the requested behavior through the public interface.
**Depends on:** none
**Context:**
- `.rb/init/PROJECT.md`
- `.rb/init/REQUIREMENTS.md`

- [ ] T001 — Implement behavior
  - **Scope:** `src/`, `tests/`
  - **Change:** Implement RF-001 without changing unrelated behavior.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: Given a valid input, the public interface returns the documented result and persists exactly one record.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** Source changes, positive and negative regression tests, and a zero exit status from the declared command.
```

## 5. Seleção e identidade da execução

O Ralph resolve somente registros `execution-plan` com status `ready`.

- `--plan` aceita o ID do artefato ou o path lógico registrado no manifesto.
- Se houver exatamente um plano pronto, ele pode ser selecionado
  automaticamente.
- Se houver mais de um, `--plan` é obrigatório.
- Um seletor desconhecido encerra antes do provider.
- `--list` e `--dry-run` não criam estado de execução nem chamam IA.

Após validar o plano, o runtime define:

```text
RUN_ID = <artifact-id>-<primeiros-12-caracteres-do-sha256>
STATE_DIR = <project>/.rb/runs/<RUN_ID>/
```

Mesmo quando os artefatos de entrada estão em outro diretório físico, o estado
durável do Ralph permanece sob `.rb/runs`.

Uma mudança nos bytes do plano muda o hash e, portanto, cria outra identidade
de run. Evidência de um plano anterior não aceita silenciosamente um plano
alterado.

## 6. Ciclo de execução e gates

Para cada fase pendente, o Ralph aplica:

1. **G0 — executor:** uma chamada efêmera implementa a task/fase.
2. **G1 — evidência:** o Ralph calcula paths adicionados, modificados e
   removidos e protege o plano de controle.
3. **G2 — validação:** comandos aplicáveis são executados ou reutilizados por
   prova de impacto.
4. **G3 — gerente:** uma chamada efêmera e independente revisa matriz completa,
   código e evidências.

Uma fase só registra `COMPLETE` após decisão válida do gerente e todos os gates
determinísticos aplicáveis verdes.

### 6.1 Unidade de execução

O padrão é `--execution-unit task`:

- cada task pendente recebe um contexto novo;
- o prompt contém o preâmbulo, contexto da fase e apenas a task selecionada;
- nenhuma sessão de chat é compartilhada entre tasks, retries ou gerente.

`--execution-unit phase` envia a fase inteira para uma chamada e existe por
compatibilidade. Ele acumula mais contexto e reduz o isolamento semântico.

### 6.2 Paralelismo

Uma fase usa paralelismo apenas quando:

- `--parallel` é maior que 1;
- existem pelo menos duas tasks pendentes;
- todas as tasks pendentes declaram `Parallel safe: true`;
- nenhuma task pendente depende de outra task ainda pendente;
- `--isolation worktree` está ativo;
- o projeto é um repositório Git com `HEAD` existente.

Cada agente paralelo recebe uma worktree criada do mesmo snapshot imutável. O
Ralph gera patches binários, rejeita alteração de `.rb`, rejeita dois agentes
tocando o mesmo path, valida conflitos e somente então aplica o patch combinado
na árvore principal. Uma falha mantém a árvore principal sem integração parcial
daquele lote.

Fases nunca são paralelizadas.

### 6.3 Evidência capturada

A captura do projeto ignora segredos, `.git`, `.rb/runs`, dependências e outputs
comuns. Limites atuais:

- até 20.000 arquivos;
- até 8 MiB por arquivo;
- symlinks são registrados pelo hash do target textual, sem segui-los.

O diff gera `rb-ralph-changes/v1` com `added`, `modified`, `deleted`, contagem de
inalterados e limitações. O índice entregue ao gerente é
`rb-ralph-evidence-index/v1`, contendo paths limitados, hashes, marcadores do
executor e resultados de validação. Logs brutos só devem ser abertos para uma
linha concreta ainda não resolvida.

### 6.4 Integridade do plano de controle

Antes de executor e gerente, o Ralph cria um snapshot dos arquivos existentes
em `.rb/runs/<RUN_ID>`. Alterar ou apagar evidência anterior produz
`CONTROL_PLANE_VIOLATION` e invalida a tentativa. Arquivos novos esperados pelo
orquestrador são permitidos; estado anterior não pode ser reescrito para forjar
prova.

Os artefatos de especificação selecionados são somente leitura conceitual. O
executor deve modificar o produto, não `PHASES.md`, manifesto ou fragments.

## 7. Protocolo do executor

### 7.1 Processo

Um adapter é um executável que:

- roda no root do projeto ou na worktree isolada;
- recebe o prompt completo em `stdin`;
- escreve sua resposta em stdout/stderr;
- retorna exit code real;
- não depende de sessão persistente.

O prompt pede que uma entrega realmente concluída termine com:

```text
RB_RALPH_EXECUTOR_STATUS: COMPLETE
```

Para providers embutidos, um processo que termina com exit 0, não altera nenhum
path e não fornece esse marcador é tratado como turno incompleto. O gerente não
é chamado; o executor recebe uma repetição limitada que não consome attempt de
implementação.

### 7.2 Variáveis fornecidas

Toda chamada recebe, conforme o papel:

```text
RB_RALPH_ROLE=agent|manager
RB_RALPH_PROJECT_ROOT
RB_RALPH_PLAN_PATH
RB_RALPH_PHASE_ID
RB_RALPH_ATTEMPT
RB_RALPH_OPERATIONAL_CONTRACT
RB_RALPH_TELEMETRY_FILE
RB_RALPH_DIRECT_API_CORE
RB_RALPH_PROVIDER
RB_RALPH_CREDENTIAL
RB_RALPH_ARTIFACTS_DIR
RB_RALPH_MODEL
RB_RALPH_AGENT_MODEL
RB_RALPH_MANAGER_MODEL
RB_RALPH_EFFORT
RB_RALPH_AGENT_EFFORT
RB_RALPH_MANAGER_EFFORT
RB_RALPH_PERMISSION_MODE=yolo|protected
RB_RALPH_YOLO=0|1
```

O executor também recebe:

```text
RB_RALPH_TASK_ID
RB_RALPH_AGENT_EVIDENCE_DIR
```

O diretório de submissão é externo ao plano de controle. Evidências opcionais
escritas ali são copiadas para o run após o provider terminar.

### 7.3 Timeouts e árvore de processos

O supervisor distingue:

- `first-output`: nenhum byte inicial dentro da janela;
- `idle`: nenhuma saída nem atividade CPU/I/O observável;
- `wall`: tempo total excedido.

Em timeout, registra:

```text
RB_RALPH_PROCESS_STATUS: TIMEOUT
RB_RALPH_TIMEOUT_KIND: first-output|idle|wall
RB_RALPH_TIMEOUT_ROLE: executor|manager
RB_RALPH_TIMEOUT_LIMIT_SECONDS: <n>
RB_RALPH_TIMEOUT_ACTION: process tree terminated; evidence is resumable
```

O grupo e descendentes observados recebem `SIGTERM` e depois `SIGKILL` se
necessário. Helpers restantes também são encerrados após saída normal.

## 8. Protocolo do gerente

O gerente é uma chamada nova, sem sessão do executor, e não pode implementar
correções. Ele recebe código atual, fase validada, paths alterados, exit code do
executor, índice de evidência, validações, findings abertos e, quando necessário,
referências a logs brutos.

Variáveis adicionais:

```text
RB_RALPH_PHASE_TITLE
RB_RALPH_MANAGER_RETRY
RB_RALPH_AGENT_LOG
RB_RALPH_VALIDATION_LOG
RB_RALPH_EVIDENCE_INDEX
RB_RALPH_CHANGED_PATHS_FILE
RB_RALPH_AGENT_EXIT_CODE
```

### 8.1 Saída estruturada

```text
RB_RALPH_AUDIT_STATUS: COMPLETE
RB_RALPH_CRITERION: <id> | <status> | <evidência canônica>
RB_RALPH_FINDING: <id[,id]> | <fronteira> | <esperado> | <observado> | <evidência/reprodução>
RB_RALPH_DECISION: <COMPLETE|RETRY|BLOCKED>
RB_RALPH_REASON: <motivo curto baseado em evidência>
```

Esse bloco é um protocolo de texto plano, não Markdown. Cada chave começa na
primeira coluna, sem marcador, indentação ou cerca de código. Chaves, IDs e
valores enumerados não podem conter espaços horizontais antes ou depois do
valor; cada registro termina imediatamente antes de `LF` ou `CRLF`. O produtor
emite exatamente um dos valores entre `<>`, nunca a expressão de alternativas
literal.

Antes de emitir a decisão, o gerente deve fazer uma conferência mecânica contra
a `REQUIRED ACCEPTANCE MATRIX` recebida: copiar cada ID, inclusive IDs de task
sintética como `RBT-FINAL`, emitir exatamente uma linha
`RB_RALPH_CRITERION` por ID e confirmar que a contagem e o conjunto de IDs são
idênticos. Critérios filhos aprovados não substituem a linha da task pai.

Status permitidos para cada linha da matriz:

- `PASS`;
- `FAIL`;
- `UNPROVEN`;
- `HUMAN_PENDING`;
- `NOT_APPLICABLE`.

Em `--manager-audit exhaustive`, o gerente deve:

- retornar uma linha `RB_RALPH_CRITERION` exatamente uma vez para cada task e
  cada `AC-*` da fase;
- não adicionar IDs desconhecidos;
- emitir um finding estruturado cobrindo todo `FAIL` e `UNPROVEN`;
- não duplicar findings equivalentes;
- em `RETRY`, devolver ao menos um finding;
- em `COMPLETE`, deixar todas as linhas em `PASS` ou `NOT_APPLICABLE`;
- auditar a matriz inteira antes da decisão, sem parar na primeira falha.

O consumidor deve aceitar `LF` e `CRLF`, remover `CR` e espaços horizontais nas
duas extremidades dos valores antes da validação e então exigir igualdade exata
do token normalizado. Por exemplo, `COMPLETE  ` normaliza para `COMPLETE`, mas
`COMPLETE extra` continua inválido. Quando o relatório estruturado da chamada
atual for válido, ele é a autoridade única para status, decisão, razão e matriz.
Feedback e resultados transitórios de uma chamada anterior são substituídos no
início da chamada seguinte; uma resposta atual válida encerra imediatamente o
retry do gerente e nenhum evento pode citar feedback ou log já superado.

Findings são identificados pela combinação normalizada de critérios, fronteira
e estado esperado. Eles permanecem abertos entre retries. Um gerente não pode
fechar um finding com o mesmo fingerprint de código/validação que o abriu;
precisa existir mudança, nova prova canônica ou waiver autorizado.

### 8.2 Semântica das decisões

- `COMPLETE`: todos os critérios estão provados. Ainda será convertido em
  `RETRY` se executor/integração falhou, se G2 está vermelho ou se um finding
  permanece aberto sobre a mesma evidência.
- `RETRY`: outra alteração de implementação pode resolver o resultado.
  Defeitos, testes vermelhos, implementação incompleta e abordagem técnica
  incorreta pertencem aqui.
- `BLOCKED`: somente decisão externa ausente, autoridade insuficiente,
  credencial/provider indisponível ou ambiguidade insegura impede progresso.
  Não deve ser usado como sinônimo de “difícil”.

Falha transitória ou saída estruturalmente inválida do gerente repete somente o
gerente sobre a mesma evidência. O executor não paga novamente por essa falha.

## 9. Retry, progresso e circuit breakers

Defaults:

| Controle | Default | Semântica |
| --- | ---: | --- |
| `--max-attempts` | 3 | tentativas consecutivas sem progresso antes de recuperar estratégia |
| `--max-strategy-resets` | 1 | recuperações de estratégia antes de pausar |
| `--max-total-attempts` | 12 | teto de attempts do executor por fase nesta invocação; `0` desliga |
| `--manager-retries` | 3 | retries adicionais do gerente sobre a mesma evidência |
| `RB_RALPH_MAX_INCOMPLETE_RETRIES` | 2 | retries de first-output/turno incompleto sem consumir attempt |
| `--max-limit-waits` | 20 | esperas de rate limit por fase |

Progresso comprovável requer mudança em paths e novo lote técnico. Nenhuma
mudança ou repetição do mesmo lote incrementa a janela de estagnação. Ao atingir
`max-attempts`, o próximo executor recebe uma recuperação explícita exigindo
estratégia materialmente diferente. Esgotar as recuperações pausa o run.

Rate limit reconhecido usa exit code 75 do adapter e opcionalmente:

```text
RB_RALPH_PROVIDER_STATUS: RATE_LIMIT
RB_RALPH_RETRY_AFTER: <segundos>
```

Essa espera não consome attempt lógico. O valor é limitado pelas flags de
rate-limit.

## 10. Locks, retomada e estado durável

O lock fica em:

```text
.rb/runs/<RUN_ID>/.lock/
```

Antes de recuperar um lock existente, o Ralph verifica:

- PID proprietário compatível com RB Ralph;
- dashboard marcado como ativo;
- status de providers em `live/*.json`;
- processos cujo comando referencia o `RUN_ID`.

Se algum processo relacionado estiver vivo, a nova execução falha. Se nenhum
estiver vivo, o lock é movido atomicamente para quarentena, um novo lock é
adquirido e o antigo é removido quando seguro. Falta de energia não apaga
eventos, logs, findings ou evidências.

Na retomada:

- fases `COMPLETE` com o mesmo RUN_ID são reutilizadas;
- attempts continuam da maior numeração encontrada em eventos, prompts, logs
  ou evidências;
- findings são reconstruídos por replay dos audits canônicos;
- a aceitação RBF é repetida quando o contrato operacional ou versão relevante
  mudou.

Arquivos principais do run:

```text
.rb/runs/<RUN_ID>/
├── run.tsv
├── events.tsv
├── findings.tsv
├── prompts/
├── logs/
├── phases/
├── evidence/
├── patches/                 # quando há paralelismo
├── usage/
├── memory/checkpoints/
└── operational-accepted.txt
```

`events.tsv` possui:

```text
timestamp	phase_id	attempt	status	reason
```

Estados observáveis incluem `COMPLETE`, `RETRY`, `BLOCKED`, `PAUSED`,
`PAUSED_HUMAN`, `MANAGER_RETRY`, `RATE_LIMIT`, `RATE_LIMIT_EXHAUSTED`,
`EXECUTOR_FIRST_OUTPUT_TIMEOUT`, `EXECUTOR_INCOMPLETE`, `STRATEGY_RESET`,
`CONTROL_PLANE_VIOLATION` e `CONTEXT_COMPACTION`.

## 11. `rb-operational/v1` e fase RBF

A auditoria final é habilitada por padrão e cria, somente em runtime:

```text
RBF — Independent operational acceptance
```

Ela não modifica `PHASES.md` e ocorre após todas as fases normais.

O contrato operacional é descoberto nesta precedência:

1. `--operations`;
2. `RB_RALPH_OPERATIONAL_CONTRACT`;
3. `OPERATIONS.json` ao lado do plano;
4. `<artifacts-dir>/OPERATIONS.json`;
5. `<artifacts-dir>/init/OPERATIONS.json`;
6. `<artifacts-dir>/context/OPERATIONS.json`.

Sem arquivo explícito, o gerente final deriva um cenário real a partir dos
entrypoints documentados. Com arquivo explícito, sua execução é determinística
e uma falha não pode ser anulada pelo gerente.

### 11.1 Forma do contrato

```json
{
  "contract": "rb-operational/v1",
  "cleanRoom": {
    "exclude": ["node_modules", "dist"]
  },
  "environment": {
    "inherit": [],
    "set": { "APP_ENV": "verification" }
  },
  "scenarios": [
    {
      "id": "consumer-flow",
      "title": "Build and exercise the product",
      "platforms": ["linux"],
      "steps": [
        {
          "id": "build",
          "kind": "command",
          "command": { "argv": ["npm", "run", "build"] },
          "expect": { "exitCode": 0 }
        }
      ]
    }
  ]
}
```

O objeto raiz aceita somente `contract`, `cleanRoom`, `environment` e
`scenarios`. Cenários possuem ID único, título, lista não vazia de steps e
`platforms` opcional com `linux`, `darwin` e/ou `win32`.

### 11.2 Ambiente limpo

O projeto é copiado para uma pasta temporária. São excluídos por padrão:

```text
.git
.rb/runs
.env
.env.local
.env.production
.env.development
```

Outros arquivos `.env.*` também são excluídos, exceto templates como
`.env.example`, `.env.sample` e `.env.template`. Symlink absoluto ou apontando
para fora do projeto invalida a cópia.

O ambiente herda apenas uma base operacional limitada, mais nomes declarados
em `environment.inherit`. O runtime define:

```text
RB_VERIFY_ROOT=<root da cópia>
RB_VERIFY_PORT=<porta local temporária>
HOME=<home temporário>
USERPROFILE=<home temporário>
XDG_CACHE_HOME=<temporário>
XDG_CONFIG_HOME=<temporário>
```

`${RB_VERIFY_ROOT}` e `${RB_VERIFY_PORT}` podem ser interpolados em strings do
contrato. Variável desconhecida falha explicitamente.

### 11.3 Steps e probes

#### `command`

```json
{
  "id": "test",
  "kind": "command",
  "command": {
    "argv": ["npm", "test"],
    "cwd": ".",
    "env": { "MODE": "acceptance" }
  },
  "timeoutSeconds": 900,
  "expect": {
    "exitCode": 0,
    "stdoutIncludes": ["passed"],
    "stderrIncludes": []
  }
}
```

`argv` é obrigatório, não usa shell e evita ambiguidades de quoting.
`exitCode` esperado é 0 quando omitido.

#### `process`

```json
{
  "id": "server",
  "kind": "process",
  "command": { "argv": ["npm", "start"] },
  "ready": {
    "kind": "http",
    "url": "http://127.0.0.1:${RB_VERIFY_PORT}/health",
    "status": 200
  },
  "readyTimeoutSeconds": 30,
  "checks": []
}
```

O processo é encerrado em `finally`, inclusive após falha. `ready` aceita probe
`http`, `tcp`, `file` ou `stdout`.

#### Probes independentes

- `http`: `url`; opcionais `method`, `body`, `status`, `headers`,
  `bodyIncludes`, `timeoutSeconds`. Status esperado padrão: 200.
- `tcp`: `host`, `port`; opcional `timeoutSeconds`.
- `file`: `path`; opcionais `exists` e `includes`. Existência esperada padrão:
  `true`.
- `stdout`: somente como prontidão/check de processo, com `includes`.

Se nenhum cenário for aplicável ao sistema atual, o contrato falha. Executar um
cenário Linux não prova suporte Windows ou macOS.

## 12. Providers, permissões e effort

Providers CLI embutidos:

- `codex`;
- `claude`;
- `opencode`.

Providers por API direta:

- `openai`;
- `anthropic`;
- `gemini`;
- `deepseek`;
- `minimax`;
- `openrouter`.

Um provider direto exige modelo explícito. Executor de API direta exige
`--yolo`, pois o runtime de API não oferece sandbox de sistema operacional; o
gerente de API permanece observacional pelo papel interno.

O padrão geral é `yolo`. `--protected` solicita:

- Codex executor `workspace-write` e gerente `read-only`;
- Claude executor `acceptEdits` e gerente `plan`;
- OpenCode gerente sem edit, shell, task ou diretório externo;
- adapter custom deve honrar o modo ou falhar claramente.

`effort` é um token do provider, não uma enumeração universal. O Ralph aceita
letras, números, ponto, underscore e hífen, e o adapter encaminha:

- Codex: `model_reasoning_effort`;
- Claude: `--effort`;
- OpenCode: `--variant`.

Modelo, effort, credential e provider podem ser compartilhados ou definidos
separadamente para executor e gerente. Quando o gerente não é configurado
explicitamente, ele herda o adapter do executor, mas continua sendo outra
chamada efêmera.

## 13. Telemetria opcional

Um adapter pode escrever no path `RB_RALPH_TELEMETRY_FILE`:

```json
{
  "schema": "rb-ralph-usage/v1",
  "provider": "codex",
  "model": "gpt-5.6-sol",
  "effort": "high",
  "role": "agent",
  "phaseId": "P01",
  "taskId": "T001",
  "attempt": 1,
  "measured": true,
  "inputTokens": 100,
  "cachedInputTokens": 20,
  "cacheCreationInputTokens": 0,
  "outputTokens": 40,
  "totalTokens": 140,
  "costUsd": null,
  "costSource": "unavailable"
}
```

Telemetria ausente permanece explicitamente não medida. Zero não deve ser
inventado como custo real. Um pricing file pode estimar custo, mas não altera
gates de aceitação.

## 14. Códigos de saída

| Código | Significado observável |
| ---: | --- |
| 0 | listagem, dry-run ou execução concluída com todas as fases aceitas |
| 1 | erro de contrato/configuração, blocker terminal, falha interna ou limite de rate limit |
| 2 | run pausado e retomável, inclusive circuit breaker ou `human:` pendente |
| 75 | protocolo interno de adapter para rate limit; normalmente consumido pelo Ralph |
| 124 | timeout emitido pelo supervisor de processo; normalmente convertido em evidência/retry |
| 130 | interrupção por Ctrl-C no processo principal |

Um consumidor não deve interpretar todo código diferente de zero como perda de
estado. Código 2 declara precisamente que o run foi preservado para retomada.

## 15. Defaults operacionais

| Opção | Default |
| --- | ---: |
| `--execution-unit` | `task` |
| `--manager-audit` | `exhaustive` |
| `--validation-mode` | `run` |
| `--parallel` | `1` |
| `--isolation` | `shared` |
| `--agent-timeout` | `3600` s |
| `--agent-idle-timeout` | `300` s |
| `--agent-first-output-timeout` | `300` s |
| `--manager-timeout` | `900` s |
| `--manager-idle-timeout` | `180` s |
| `--manager-first-output-timeout` | `180` s |
| `--validation-timeout` | `900` s por comando |
| `--max-prompt-bytes` | `262144` |
| auditoria operacional final | ligada |
| permissão | `yolo` |

Timeout igual a `0` desliga o respectivo limite quando a opção documenta essa
possibilidade. Prompt acima de `max-prompt-bytes` é rejeitado antes da chamada.

## 16. Checklist para um gerador compatível

Antes de declarar um pacote “Ralph-ready”, o gerador deve provar:

- [ ] manifesto estruturalmente válido e sem campos extras;
- [ ] hashes correspondem exatamente aos arquivos atuais;
- [ ] um registro `execution-plan/ready/rb-execution-v1` selecionável;
- [ ] ID do manifesto igual ao marcador do plano;
- [ ] fases contíguas e IDs `P##` corretos;
- [ ] tasks globais `TNNN`, únicas e ascendentes;
- [ ] dependências referenciam somente fases/tasks anteriores;
- [ ] contexto suficiente para agentes frios;
- [ ] scopes com paths entre crases e sem colisões quando paralelos;
- [ ] `Parallel safe: true` somente quando patches podem ser isolados;
- [ ] critérios binários, observáveis, sem linguagem vaga ou circular;
- [ ] validações exatas, não interativas e sem mascarar falha;
- [ ] `manual:` reservado a inspeção real do gerente;
- [ ] `human:` usado deliberadamente, sabendo que pausa antes do provider;
- [ ] nenhuma task normal depende do resultado futuro da fase RBF;
- [ ] `OPERATIONS.json` válido quando o produto possui um entrypoint
  automatizável;
- [ ] cenários operacionais exercitam fronteiras reais e plataformas honestas;
- [ ] documentos de `Context` existem e não contradizem `PHASES.md`;
- [ ] nenhum provider, modelo, branch, commit ou topologia de agentes foi
  incorporado como requisito do plano.

## 17. Comandos de conformidade

Validar o plano diretamente:

```bash
rb-harness contract validate .rb/init/PHASES.md
rb-harness contract inspect .rb/init/PHASES.md --format json
```

Validar o contrato operacional:

```bash
rb-harness operations validate .rb/init/OPERATIONS.json
rb-harness artifacts verify --project .
```

Sincronizar e validar a árvore:

```bash
rb-harness manifest sync .
rb-harness tree validate .
```

Validar como o próprio consumidor, sem provider e sem criar run:

```bash
rb-ralph --project . --list
rb-ralph --project . --plan <artifact-id> --dry-run
```

Para diretório físico alternativo:

```bash
rb-ralph --project . --artifacts-dir .spec --list
rb-ralph --project . --artifacts-dir .spec --plan <artifact-id> --dry-run
```

## 18. Fronteiras que não pertencem ao contrato documental

Um plano compatível não deve fixar:

- provider ou modelo;
- effort;
- quantidade de agentes;
- modo protegido ou YOLO;
- estratégia de branch/commit;
- dashboard;
- pricing;
- integração com RB Memory;
- número de retries/timeouts do operador.

Esses itens configuram uma execução específica. O documento pode declarar
dependências, isolamento semântico e se uma task é paralelizável, mas permanece
neutro quanto ao executor escolhido.

## 19. Fontes normativas desta consolidação

- `contracts/rb-manifest-v1.md` e `.schema.json`;
- `contracts/rb-execution-v1.md` e `.schema.json`;
- `contracts/rb-operational-v1.md` e `.schema.json`;
- parser e manifesto do core empacotado do RB Harness;
- `rb-ralph/bin/rb-ralph`;
- `rb-ralph/adapters/`;
- `rb-ralph/lib/manager-audit.cjs`;
- `rb-ralph/lib/validation-cache.cjs`;
- `rb-ralph/lib/operational-verifier.cjs`;
- `rb-ralph/lib/process-supervisor.cjs`;
- `rb-ralph/lib/control-plane.cjs`;
- `rb-ralph/lib/evidence.cjs` e `evidence-index.cjs`.

Em caso de divergência, o validador empacotado com a versão do RB Ralph usada
na execução é a autoridade mecânica. O documento deve ser atualizado junto com
qualquer mudança observável nessas fronteiras.

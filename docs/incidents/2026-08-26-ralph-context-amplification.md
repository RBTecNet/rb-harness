# Incidente: amplificação de contexto e tokens dentro das tarefas do RB Ralph

- Data: 2026-08-26
- Estado: diagnóstico confirmado; plano de correção pronto para implementação
- Produto responsável: RB Ralph
- Incidente de origem: `tui_admin_samba`, run `init-phases-266cf96f2a49`
- Versão efetivamente executada: RB Ralph `0.10.0`
- Escopo desta entrega: contexto do executor, telemetria, atividade, retries e dashboard do Ralph

## Conclusão executiva

O Ralph está criando um processo e uma thread efêmeros para cada tarefa. Não foi encontrada retenção indevida da conversa de T040 em T041 ou de T041 em T042.

O crescimento observado ocorre dentro de cada chamada efêmera. Durante uma tarefa, o agente executa sucessivos comandos, recebe saídas extensas e continua raciocinando sobre o histórico acumulado daquela mesma chamada. O provedor contabiliza a soma dos tokens de entrada processados em todas essas interações internas, incluindo os prefixos reaproveitados por cache. Por isso, milhões de tokens contabilizados não significam que existiam milhões de tokens simultaneamente na janela de contexto.

Mesmo com essa distinção, há amplificação operacional real e evitável. O Ralph pré-carrega contexto por ordem de arquivo, inclui caminhos de controle irrelevantes no catálogo, pode cortar os requisitos específicos da tarefa depois de incluir seções anteriores, não limita a forma das leituras feitas pelo agente e, em retries de fase, volta a executar tarefas que não possuem achado aberto.

No estado analisado, 69 chamadas contabilizaram 44.001.930 tokens. Desses, 39.858.176 eram tokens de entrada em cache. A execução produziu código real e testes válidos, mas o volume é desproporcional à entrega e torna difícil ao operador distinguir contexto útil, reenvio acumulado e desperdício.

## O que está funcionando corretamente

### Há reset conversacional por tarefa

Em `adapters/codex.sh:63-68`, cada chamada usa:

```sh
exec
--cd "$PROJECT_ROOT"
--skip-git-repo-check
--ephemeral
```

O prompt produzido por `bin/rb-ralph:1023-1026` também declara explicitamente `fresh execution context`.

Os logs das tarefas começam com um novo evento `thread.started`. Por exemplo:

```text
.rb/runs/init-phases-266cf96f2a49/logs/P08-T041-attempt-1-agent.log:1
{"type":"thread.started","thread_id":"01a0401b-1dbc-7d00-a7df-8cf5aa7cb8fe"}
```

Portanto, remover `--ephemeral` ou compartilhar uma sessão longa entre tarefas não é uma correção aceitável. Isso reduziria isolamento, misturaria autoridades e aumentaria o risco de uma tarefa operar com narrativa obsoleta.

### A telemetria preserva o valor informado pelo provedor

`lib/provider-telemetry.cjs:60-70` lê a utilização do evento final do Codex e grava `inputTokens`, `cachedInputTokens`, `outputTokens` e `totalTokens`. `lib/usage-summary.cjs:78-85` soma os registros por chamada.

O número exibido é, portanto, utilização cumulativa informada pelo provedor, não uma medição da maior janela simultânea. A correção deve melhorar a nomenclatura e acrescentar métricas derivadas, mas não deve reclassificar esses números como inválidos.

## Evidências quantitativas

### 1. Utilização acumulada da run

Em `.rb/runs/init-phases-266cf96f2a49/usage-summary.tsv:1-15`:

```text
calls                 69
inputTokens           43.439.317
cachedInputTokens     39.858.176
outputTokens             562.613
totalTokens           44.001.930
```

Os tokens em cache representam aproximadamente 91,8% da entrada contabilizada. A entrada não cacheada derivada é 3.581.141 tokens.

`cachedInputTokens` é subconjunto de `inputTokens` para o adaptador Codex; não deve ser somado novamente ao total.

### 2. T041 começou com prompt pequeno e terminou com entrada acumulada grande

O prompt de T041 possui 39.230 bytes:

```text
.rb/runs/init-phases-266cf96f2a49/prompts/P08-T041-attempt-1-agent.txt
```

O registro da mesma chamada informa:

```text
.rb/runs/init-phases-266cf96f2a49/usage/.../P08-T041-attempt-1-agent.usage.json:11-15
inputTokens=3.311.642
cachedInputTokens=3.187.456
outputTokens=27.243
totalTokens=3.338.885
```

O log termina com exatamente os mesmos valores em `turn.completed`, comprovando que a telemetria não somou arquivos duplicados por fora do provedor.

A análise estruturada do log encontrou:

- 27 comandos;
- 18 comandos de descoberta/leitura por padrões como `rg`, `sed`, `cat` e `find`;
- 366.528 bytes de saída agregada de comandos;
- log final com aproximadamente 417 KB.

Esse formato é consistente com reenvio cumulativo do histórico da própria tarefa: a cada novo passo, prompt, mensagens e saídas anteriores continuam compondo o prefixo, majoritariamente lido do cache.

### 3. O maior caso observado repete o mesmo padrão

T034/P06 apresentou:

```text
prompt: 44.463 bytes
log: 453.345 bytes
comandos: 27
inputTokens: 4.333.383
cachedInputTokens: 4.187.392
outputTokens: 29.023
totalTokens: 4.362.406
```

Novamente, mais de 96% da entrada estava em cache. Isso não elimina o custo nem o tempo: apenas mostra que o problema dominante é reapresentação de um prefixo crescente, não um prompt inicial de quatro milhões de tokens.

### 4. Retries amplificaram o volume entre tarefas

Agrupando os arquivos `usage/*.usage.json` cujo executor possui `attempt > 1`, foram encontradas:

```text
26 chamadas repetidas
6.435.903 input tokens
5.646.080 cached input tokens
97.426 output tokens
6.533.329 total tokens
```

Em P01, um achado restrito a T001 fez T001–T005 serem executadas novamente até a quinta tentativa. Em P02, um achado restrito à confirmação também repetiu todas as tarefas da fase. O reset ocorreu em cada chamada, mas o trabalho de descoberta e validação foi pago novamente.

### 5. A atividade já é medida, porém apenas depois da chamada

`lib/agent-activity.cjs` registra comandos, edições, mensagens e eventos depois que o executor termina. Para T041, o arquivo contém:

```text
ACTIVITY P08/T041-attempt-1 27 15 5 92
```

Essa observabilidade é útil, mas não participa do status ao vivo nem produz um finding de eficiência. Quando o registro é publicado, todo o volume da chamada já foi consumido.

## Evidências de seleção ineficiente do contexto inicial

### 1. O catálogo inclui o control plane do Harness

`lib/agent-context.cjs:236-243` remove somente caminhos iniciados por `.rb/` antes de construir `PROJECT FILES`. Consequentemente, o prompt de T041 inclui dezenas de entradas como:

```text
.rb-harness/runs/.../bundle.json
.rb-harness/runs/.../logs/generation-document-*.log
.rb-harness/runs/.../logs/interview-*.log
.rb-harness/verifications/.../report.json
```

Esses caminhos não pertencem ao produto que T041 deve implementar. Mesmo quando apenas seus nomes são enviados, eles aumentam ruído e incentivam inspeção de artefatos narrativos que o próprio prompt manda evitar.

### 2. Documentos são carregados por ordem, não pela rastreabilidade da tarefa

`lib/agent-context.cjs:246-255` lê os documentos declarados em `Context` na ordem em que aparecem, limitado a 16 KB por arquivo e 48 KB no total.

T041 cobre, entre outros, RF-014, RF-015, RF-016, RF-017 e RF-026. Porém, o prompt pré-carregou o começo de `PROJECT.md` e o começo de `REQUIREMENTS.md`, chegando somente até RF-013. O final contém:

```text
[context budget reached; not included: phase context beyond 2 file(s).
Open these yourself if a criterion needs them.]
```

Assim, o orçamento foi gasto com RF-001–RF-013 e cortou exatamente RF-014–RF-017. O agente teve de reabrir arquivos apesar de receber uma seção chamada `PRE-LOADED REPOSITORY CONTEXT`.

### 3. A tarefa já fornece identificadores suficientes para seleção exata

O work item de T041 contém `Covers: RF-014, RF-015, RF-016, RF-017, RF-026, UI-001, UI-002, UI-003, UI-004, CT-001, CT-002, RNF-005, RNF-006`.

Esses identificadores permitem extrair seções exatas dos documentos estruturados sem interpretação livre. O pré-carregador atual não utiliza essa rastreabilidade e prefere os primeiros bytes do documento.

### 4. O contexto de dependências é indireto

T041 depende de T023–T028, mas o prompt não entrega um índice explícito das fronteiras/API produzidas por essas tarefas. O agente precisa descobrir construtores, tipos e métodos em `internal/policy` e `internal/permissions`. Esse trabalho é legítimo, porém pode ser reduzido com um mapa limitado aos `Scope` das dependências declaradas.

## Causa raiz no Ralph

A causa não é uma única retenção de contexto, mas a combinação de cinco mecanismos:

1. Cada tarefa é corretamente efêmera e precisa receber novamente sua autoridade.
2. O pré-carregador seleciona contexto por ordem e prefixo de arquivos, em vez de rastreabilidade por critérios e dependências.
3. O catálogo inclui árvores de controle e evidência que não são código do produto.
4. Durante uma tarefa, comandos numerosos e saídas extensas passam a integrar o histórico reapresentado nas interações seguintes.
5. Em retry de fase, o Ralph reexecuta todas as tarefas ainda marcadas como `done=false` no documento imutável, mesmo quando os findings citam somente uma tarefa.

O resultado é uma amplificação em duas dimensões:

- intra-tarefa: prefixo crescente reapresentado muitas vezes;
- entre tentativas: tarefas sem finding repetem descoberta e validação em novas sessões.

## Invariantes requeridos

### RCA-001 — Isolamento preservado

Cada T continua recebendo uma nova sessão/processo. Nenhuma otimização pode depender do histórico conversacional de outra tarefa.

### RCA-002 — Métrica semanticamente correta

O dashboard deve distinguir:

- bytes/tokens do prompt inicial;
- entrada cumulativa processada pelo provedor;
- parcela cacheada da entrada;
- entrada não cacheada derivada;
- saída;
- comandos, edições, eventos e bytes de log;
- sinal de compactação do provedor, quando disponível.

Entrada cumulativa nunca deve ser rotulada como “tamanho do contexto”.

### RCA-003 — Relevância antes de abrangência

Critérios citados em `Covers`, arquivos no `Scope` e fronteiras das dependências declaradas devem receber orçamento antes de documentos ou árvores gerais.

### RCA-004 — Control plane não é contexto de produto

`.rb/runs`, `.rb-harness/runs`, `.git`, dependências instaladas, binários e logs não podem entrar no catálogo padrão entregue ao executor.

### RCA-005 — Leituras são limitadas por evidência

O executor deve começar com arquivos e seções exatas. Saídas de descoberta devem ser limitadas e uma leitura ampla precisa corresponder a um critério ainda não resolvido.

### RCA-006 — Retry é localizado

Um finding identificado por tarefa/critério deve reexecutar somente a menor task closure capaz de resolvê-lo. Tarefas já comprovadas não retornam ao conjunto pendente sem evidência de impacto.

### RCA-007 — Eficiência não substitui correção

Limites de contexto não podem truncar autoridade sem declarar a omissão, aceitar trabalho incompleto ou converter falta de prova em `COMPLETE`.

## Plano de correção — RB Ralph

### 1. Corrigir o seletor de contexto

Alterar `lib/agent-context.cjs` para construir contexto na seguinte ordem:

1. work item validado;
2. conteúdo atual do `Scope`;
3. seções exatas correspondentes aos identificadores de `Covers`;
4. mapa dos `Scope` das tarefas em `Depends on` e, quando pequeno, assinaturas públicas correspondentes;
5. arquivos alterados anteriormente na fase que intersectem essas fronteiras;
6. catálogo filtrado e reduzido do produto;
7. contexto geral restante somente se houver orçamento.

O extrator de seções deve operar sobre IDs e cabeçalhos estruturados, sem inferir relevância por palavras-chave.

### 2. Excluir árvores não produtivas do catálogo

Expandir o filtro de `PROJECT FILES` para excluir por padrão:

- `.rb/`;
- `.rb-harness/`;
- `.git/`;
- `node_modules/`, `vendor/` e caches conhecidos;
- diretórios de build/distribuição e binários detectados;
- logs e snapshots de execução.

Manter opção explícita para uma tarefa cujo próprio `Scope` autorize um desses caminhos. O filtro geral não pode ocultar um caminho declarado como autoridade.

### 3. Pré-carregar contexto das dependências da tarefa

Usar o JSON já gerado em `TASK_DETAILS_FILE` para resolver `Depends on`. Entregar uma seção curta com:

- task ID;
- scope produtor;
- arquivos existentes nesse scope;
- nomes públicos/exportados quando houver extrator determinístico disponível;
- indicação clara de conteúdo omitido.

Não enviar implementações completas de todas as dependências por padrão.

### 4. Estabelecer protocolo de leitura limitada

Reforçar `write_agent_prompt` com regras operacionais observáveis:

- usar `rg` para localizar símbolos antes de abrir arquivos;
- abrir intervalos limitados, não arquivos/pastas inteiros;
- não imprimir lockfiles, bundles, logs anteriores ou snapshots completos;
- limitar resultados de `find`/`rg` e refinar a consulta quando o resultado for amplo;
- não repetir uma leitura cuja saída já esteja no contexto atual;
- executar primeiro a validação específica da tarefa e somente depois a suíte mais ampla necessária.

Essas regras são uma defesa, não o único mecanismo; o contexto pré-carregado precisa ser correto mesmo quando o modelo não as segue perfeitamente.

### 5. Publicar métricas de amplificação por chamada

Criar um artefato paralelo, sugerido como `rb-ralph-context-efficiency/v1`, sem alterar retroativamente `rb-ralph-usage/v1`. Ele deve combinar:

- `promptBytes`;
- `providerInputTokens`;
- `cachedInputTokens`;
- `derivedUncachedInputTokens`;
- `outputTokens`;
- `commandCount`, `editCount`, `messageCount`;
- `providerLogBytes`;
- `contextCompactionObserved`;
- task, fase, tentativa, modelo e provider.

O dashboard deve mostrar por chamada e por fase os maiores consumidores, além de avisos para:

- entrada cumulativa excepcionalmente alta;
- muitos comandos sem edição ou sem nova evidência;
- grande volume de saída de ferramentas;
- repetição do mesmo padrão em tasks vizinhas.

O aviso deve dizer “amplificação de contexto” ou “entrada cumulativa”, nunca “janela com N tokens” sem uma métrica nativa do provedor.

### 6. Tornar a atividade parcialmente observável durante a chamada

Estender `lib/process-supervisor.cjs` para reconhecer eventos JSON por linha sem alterar o log bruto. O status vivo pode publicar contadores de:

- comandos concluídos;
- alterações de arquivo;
- mensagens;
- bytes de saída;
- tempo desde a última edição.

Limites suaves devem apenas sinalizar. Um limite duro opcional pode pausar de forma recuperável quando comandos ou bytes excederem uma configuração explícita, preservando mudanças e evidências. O padrão não deve matar uma tarefa correta apenas por ser complexa.

### 7. Localizar retries por findings

Ao receber matriz do gerente, extrair os task IDs e critérios em `FAIL`/`UNPROVEN`. Na tentativa seguinte:

1. selecionar as tarefas citadas;
2. acrescentar somente dependências cuja implementação precise mudar;
3. reutilizar validações bem-sucedidas de tarefas não impactadas;
4. manter tarefas concluídas fora de `PENDING_TASK_IDS`;
5. escalar para `PLAN_CONFLICT` quando o reparo exigir scope pertencente a outra tarefa e não houver closure autorizada.

Isso elimina o padrão observado em P01, no qual um finding de T001 repetiu T002–T005.

### 8. Corrigir a apresentação do dashboard

Alterar `lib/dashboard.cjs` para apresentar:

- `entrada acumulada` em vez de texto que possa ser interpretado como janela atual;
- `cache` como parcela da entrada, não componente adicional;
- entrada não cacheada;
- prompt inicial em bytes/tokens estimados quando disponível;
- top N chamadas por tokens, comandos e bytes de log;
- retries localizados versus chamadas repetidas de fase.

## Fronteiras de implementação

As principais fronteiras a avaliar são:

- `lib/agent-context.cjs`: seleção por critérios, dependências e filtros;
- `bin/rb-ralph`: construção do prompt, seleção de tarefas em retry e publicação dos novos artefatos;
- `lib/provider-telemetry.cjs`: preservação da telemetria nativa e campos de origem;
- `lib/usage-summary.cjs`: derivados sem dupla contagem;
- `lib/agent-activity.cjs`: métricas pós-chamada;
- `lib/process-supervisor.cjs`: contadores ao vivo e limites opcionais;
- `lib/dashboard.cjs`: semântica e ranking operacional;
- `adapters/codex.sh`: preservação obrigatória de `--ephemeral`;
- `tests/test-agent-context.sh`: seleção e filtros;
- `tests/test-execution-parallelism.sh`: retry localizado;
- `tests/test-portability-and-contract.sh`: telemetria, supervisor e pacote instalado;
- `tests/test-dashboard-focus.sh`: apresentação das métricas.

Essa lista é um mapa de impacto. A implementação deve manter contratos compartilhados e evitar cálculo duplicado entre dashboard e summary.

## Critérios de aceitação

1. Cada tarefa Codex continua iniciando com `--ephemeral` e novo `thread_id`.
2. Uma fixture equivalente a T041 recebe RF-014, RF-015, RF-016, RF-017 e RF-026 antes de qualquer requisito não coberto.
3. O catálogo padrão não contém `.rb-harness/runs`, `.rb/runs`, `.git` ou logs de geração.
4. Dependências T023–T028 aparecem como mapa limitado de fronteiras, sem despejar todo o código no prompt.
5. O relatório distingue prompt inicial, entrada cumulativa, entrada cacheada e entrada não cacheada.
6. `totalTokens` do Codex continua igual ao valor nativo ou a `inputTokens + outputTokens`; cache não é somado duas vezes.
7. Status vivo publica comandos, edições e bytes sem corromper o stream bruto do provedor.
8. Finding restrito a T001 não reexecuta T002–T005.
9. Validações bem-sucedidas e não impactadas são reutilizadas.
10. Um limite suave gera aviso, não falha da tarefa.
11. Um limite duro configurado explicitamente produz pausa recuperável com motivo e evidência, nunca `COMPLETE` artificial.
12. O pacote instalado preserva o mesmo comportamento e todas as suítes do Ralph passam.

## Testes de regressão

### Seleção de contexto

- projeto com milhares de arquivos sob `.rb-harness/runs`: nenhum aparece no prompt;
- tarefa cobrindo requisitos localizados no fim de `REQUIREMENTS.md`: seções exatas aparecem integralmente;
- requisitos anteriores e não cobertos não consomem o orçamento antes dos cobertos;
- scope inexistente continua explicitamente marcado como arquivo a criar;
- caminho de control plane explicitamente declarado no scope não é ocultado silenciosamente;
- contexto truncado declara exatamente o que foi omitido.

### Telemetria e dashboard

- fixture Codex com entrada total e parcela cacheada prova ausência de dupla contagem;
- fixture com prompt de 40 KB e uso cumulativo alto é rotulada como amplificação, não como janela de milhões de tokens;
- ranking identifica a chamada de maior entrada, maior número de comandos e maior log;
- provider sem métricas permanece `unmeasured`, nunca zero;
- compactação reportada pelo provider aparece no artefato e no evento.

### Retry localizado

- fase com cinco tarefas e finding somente em T001 executa apenas T001 na tentativa seguinte;
- finding em tarefa dependente seleciona a closure mínima autorizada;
- mudança compartilhada que impacta validação anterior invalida somente o cache correspondente;
- finding sem task ID não é adivinhado: a fase é pausada ou usa fallback explicitamente registrado;
- manager retry de protocolo continua sem repetir nenhum executor.

### Benchmark de integração

Executar três vezes uma fixture equivalente a T041 com o mesmo modelo e esforço:

1. registrar prompt, comandos, bytes de log, entrada, cache, saída e resultado dos testes;
2. comparar a mediana com a implementação anterior;
3. exigir redução material da entrada cumulativa e dos comandos de rediscovery, com meta inicial de pelo menos 50%;
4. exigir o mesmo resultado funcional e a mesma validação determinística;
5. impedir que a redução venha de critérios omitidos, testes removidos ou leitura de autoridade truncada.

A meta estatística pertence ao benchmark, não à suíte determinística: variação de modelo não deve tornar testes unitários instáveis.

## Migração e compatibilidade

- `rb-ralph-usage/v1` permanece legível e com a semântica atual.
- O novo relatório de eficiência deve ser adicional e opcional para providers sem stream estruturado.
- Configurações atuais de timeout continuam válidas.
- Limites duros novos ficam desabilitados por padrão até haver dados suficientes.
- Runs existentes não são reescritas; o dashboard deve continuar lendo summaries antigos.
- A seleção localizada de retry precisa de fallback conservador para relatórios legados sem task IDs.

## Fora de escopo

- compartilhar conversa entre tarefas;
- remover `--ephemeral`;
- tratar tokens em cache como gratuitos ou irrelevantes;
- estimar a janela real sem métrica fornecida pelo provider;
- comprimir ou resumir autoridade de forma que critérios desapareçam;
- modificar o projeto `tui_admin_samba` durante sua execução;
- alterar os artefatos produzidos pelo Harness para mascarar a ineficiência do Ralph.

## Critério de encerramento

O incidente pode ser encerrado quando o Ralph preservar sessões efêmeras, selecionar primeiro as seções e dependências exatas da tarefa, excluir control planes do catálogo, expor métricas semanticamente corretas, localizar retries por finding e demonstrar no benchmark redução de pelo menos 50% na amplificação sem regressão funcional ou perda de autoridade.

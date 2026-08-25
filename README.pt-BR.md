# RB Harness

[English](README.md) · [Português do Brasil](README.pt-BR.md)

O RB Harness transforma uma solicitação de produto em documentação executável,
neutra de modelo e compatível com o RB Ralph. Ele entrevista o desenvolvedor
somente sobre decisões materiais ausentes, inspeciona o projeto quando o fluxo
exige conhecimento do estado atual e publica artefatos versionados sem
implementar o código da aplicação.

A geração normal usa um único papel de escritor de documentação. Não existe
gerente LLM, auditor semântico nem remediação iterativa. A qualidade estrutural
pertence a validadores determinísticos, as decisões de produto pertencem à
entrevista, e a autoria é dividida em respostas pequenas, independentes e
retomáveis em vez de exigir um pacote monolítico do modelo.

## Instalação do executável

O RB Harness 0.5.8 exige Node.js 20 ou superior. No clone do repositório:

```bash
npm install
npm run build
npm install --global --prefix "$HOME/.local" ./packages/core
```

Se necessário, adicione o diretório de binários ao shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Confira a versão instalada:

```bash
rb-harness --version
rb-harness --ver
# 0.5.8
```

Executar apenas `rb-harness` abre o assistente interativo. O splash com a
capivara pode ser controlado com `--splash`, `--no-splash` ou
`RB_HARNESS_SPLASH=0|1`.

## Providers, modelos e credenciais

O Harness aceita CLIs já autenticados:

- `codex`;
- `claude`;
- `opencode`;
- um adapter próprio com `--provider custom --adapter <executável>`.

Também aceita providers de API direta registrados pelo runtime, incluindo
OpenAI, Anthropic, Gemini, DeepSeek, MiniMax e OpenRouter. Consulte o catálogo e
teste conexões sem iniciar uma geração:

```bash
rb-harness provider list
rb-harness provider test
rb-harness provider test --provider deepseek --model deepseek-chat
```

O cofre compartilhado de credenciais é configurado por assistente:

```bash
rb-harness --login
```

Segredos não são passados em argumentos de processo, prompts, artefatos ou
relatórios. O cofre reduz exposição acidental de texto puro, mas não protege
contra comprometimento completo da conta do sistema operacional.

Provider, modelo e esforço são escolhas explícitas por execução:

```bash
rb-harness plan \
  --project . \
  --file docs/feature.md \
  --provider codex \
  --model gpt-5.6-sol \
  --effort high
```

## Máquina de estados documental

Antes da primeira chamada ao modelo, o Harness monta um pacote de entrada
determinístico e limitado: a solicitação e seu hash, o workflow, um inventário
resumido do projeto-alvo, os artefatos RB existentes, as decisões já aceitas e
um contrato compacto de saída pertencente ao código. Ficam de fora controle de
versão, dependências, builds, cobertura, estado vivo do Harness, credenciais e
arquivos temporários. Nenhum caminho para o source, o `dist`, os testes ou a
instalação do próprio RB Harness chega ao modelo; qualquer conteúdo adicional
só vem das ferramentas documentais confinadas ao projeto-alvo.

O fluxo é: inventário → análise adaptativa de lacunas (1 lote e quantas rodadas
focadas a convergência exigir) → checkpoint fechado de decisões → plano
documental compacto → partes de no máximo 12 KiB → montagem → materialização →
validação determinística → no máximo uma correção estrutural localizada →
publicação atômica. Fora dessas permissões contadas, o grafo é acíclico e
nenhuma etapa pode se reiniciar
sozinha.

O plano contém caminhos, IDs compartilhados e um brief fechado para cada
parte. Somente essa primeira chamada pode descobrir evidências. Cada parte roda
com contexto novo, sem catálogo de ferramentas no runtime de API direta e em
um diretório temporário vazio para qualquer adapter. Assim, um escritor não
reexplora o projeto para cada arquivo e uma janela pequena de saída não precisa
carregar toda a documentação. Cada parte aceita é gravada imediatamente em um
checkpoint privado; uma falha ou falta de energia retoma apenas a parte ausente,
sem comprar novamente o trabalho concluído. A árvore `.rb` só é publicada após
montagem e validação completas.

Adapters antigos que já devolvem um pacote `rb-harness-documents/v1` completo
continuam aceitos na primeira chamada. Não existe repetição automática da mesma
requisição truncada: `length`, `max_tokens`, envelope incompleto ou parte acima
do limite falham com diagnóstico e preservam o checkpoint para `resume`.
Chamadas de parte devolvem conteúdo documental puro por padrão: caminho e ID já
pertencem ao plano validado, então exigir outro envelope JSON não acrescenta
segurança. Envelopes antigos corretos continuam aceitos por compatibilidade.

Se a resposta semântica da entrevista, do plano ou de uma parte legada não
cumprir o contrato, o Harness preserva a saída bruta e aciona um formatador
agnóstico de provider. Ele roda sem ferramentas e sem acesso ao projeto, recebe
o contrato exato e o defeito determinístico do parser e pode tentar no máximo
três vezes. Cada tentativa recebe novamente a saída bruta imutável e a tentativa
de formatação anterior. Somente a representação pode mudar: descoberta,
decisões e autoria não são refeitas para corrigir JSON, marcadores ou campos de
apresentação. Respostas brutas concluídas são recuperadas dos logs privados
após interrupções.

A correção estrutural recebe apenas a lista ordenada de erros mecânicos e os
trechos afetados, e precisa preservar byte a byte todo conteúdo não relacionado.
Ela não reabre a entrevista, não reexplora o repositório e não reemite a árvore.
Uma segunda falha é reportada ao operador com o diagnóstico exato; não há loop.

## Decomposição verificada do plano

Um plano `rb-execution/v1` também é validado quanto à decomposição, não apenas
quanto à gramática. O RB Ralph executa uma chamada efêmera e sem contexto por
task, então uma task que carrega uma feature inteira precisa ser rederivada do
zero dentro de uma única janela — exatamente onde um executor esquece um
requisito ou inventa outro.

Os tetos são lidos do que o próprio documento declara: uma task cobre no máximo
3 IDs de requisito, declara no máximo 6 critérios de aceitação e 8 caminhos de
escopo; uma fase tem no máximo 12 tasks, e uma fase de task única cobrindo mais
de 2 requisitos simplesmente não decompôs a feature. Um plano que viola qualquer
teto é erro estrutural reparável antes da publicação e blocker em
`rb-harness artifacts verify` — nunca uma surpresa descoberta por um executor
travado.

A versão 0.5.1 fecha a falha de formato observada em providers que terminavam a
análise dizendo que iriam escrever o envelope, mas encerravam antes dele: a
conclusão em prosa recebe uma única conversão sem ferramentas, JSON válido sem
marcadores é preservado e a descoberta completa não é repetida por causa de
formatação.

A versão 0.5.2 passa a solicitar conteúdo puro nas partes documentais, sem
forçar Markdown dentro de uma string JSON. Envelopes antigos corretos continuam
compatíveis; caracteres de controle literais no conteúdo são normalizados sem
alterar caminho nem ID da parte. No `resume`, uma parte paga e completa presente
no log é gravada no checkpoint antes de qualquer nova chamada ao provider.

A versão 0.5.3 mantém estrita a fronteira com o Ralph e evita os defeitos de
contrato observados no ensaio do Cron2. O escritor recebe a gramática exata das
dependências de fase e de task, o formato atual das asserções de probes HTTP e
a proibição explícita de critérios vagos como `quando aplicável`. Antes da
validação, o código faz somente normalizações sem perda: move asserções HTTP do
formato legado para os campos exatos de `rb-operational/v1` e remove da task a
referência redundante à dependência da fase que a contém. Um plano inválido
preserva seu ID declarado no manifesto, impedindo que um erro real gere também
um falso `artifact.id.mismatch`. O plano da única correção estrutural roda
fechado e sem ferramentas; todos os validadores e a exigência de um plano
`rb-execution/v1` pronto permanecem inalterados.

A versão 0.5.4 introduziu a recuperação do plano concluído pelo log. A versão
0.5.5 remove a exceção específica para o campo `prefix` e aplica uma única
fronteira de formatação à entrevista, ao plano e a envelopes legados de partes
malformados, seja por API direta, CLI ou adapter customizado: uma resposta
semântica e de zero a três tentativas fechadas de formatação. Campos de
autoridade desconhecidos continuam rejeitados pelo contrato estrito; o
formatador não pode atribuir significado a eles.

A versão 0.5.6 remove uma instrução aposentada e contraditória que ainda mandava
todos os workflows emitirem o pacote documental completo durante a chamada do
plano compacto. O plano agora é explicitamente apenas um índice, com resumo,
coordenação, propósitos de documentos e briefs de partes limitados; fatos
compartilhados aparecem uma vez no ledger de coordenação, sem repetição em cada
parte. No `init` greenfield, o planejamento usa a solicitação completa já
presente no pacote de autoridade e não compra outro turno de ferramenta para
reler a mesma origem.

A versão 0.5.7 mantém o plano documental limitado como um todo, mas remove
tetos arbitrários de bytes dos campos individuais de prosa. O modelo não precisa
mais contar bytes UTF-8 na descrição de uma parte, e um plano compacto e
semanticamente válido não passa por três tentativas pagas do formatador somente
porque um brief ultrapassou um limite consultivo. Caminhos, IDs, esquema,
quantidades de documentos/partes, tamanho total do plano, tamanho do conteúdo e
validadores finais compatíveis com o Ralph continuam estritos.

A versão 0.5.8 muda dois comportamentos observáveis por um consumidor:

- a entrevista converge em vez de expirar. Antes era um lote fixo mais um
  follow-up, então uma resposta que abrisse uma nova decisão material não
  ganhava rodada nenhuma e a execução terminava em `BLOCKED` com a decisão
  ainda aberta. Agora ela roda rodadas focadas até não restar nada material,
  carrega as perguntas excedentes de uma rodada para a seguinte em vez de
  adiá-las, nunca repergunta uma decisão já resolvida e trata atingir qualquer
  teto de segurança declarado — 12 rodadas, 40 perguntas — como falha de
  convergência, não como aceite;
- um plano `rb-execution/v1` gerado passa a ser validado quanto à decomposição,
  não apenas quanto à gramática. Como o RB Ralph executa uma chamada efêmera e
  sem contexto por task, tetos lidos das próprias declarações do documento
  rejeitam uma task que carrega uma feature inteira — erro estrutural reparável
  antes da publicação e blocker em `rb-harness artifacts verify`.

As decisões aceitas pela própria entrevista também cabem nos orçamentos agora:
o teto de quantidade de decisões acompanha o teto de perguntas por execução, e
os orçamentos do pacote de entrada e do prompt de entrevista cresceram junto.
Uma entrevista totalmente convergida nunca falha sobre as respostas que o
desenvolvedor já deu.

Duas falhas observadas contra providers reais são corrigidas junto:

- o contrato de saída prometia um `AGENTS.md` na raiz para o ai-context
  enquanto o parser rejeitava qualquer caminho fora de `.rb/`. Um modelo que
  obedecia ao contrato era rejeitado e depois enviado três vezes a um formatador
  que só muda representação e jamais poderia corrigir um caminho. O contrato
  agora declara o único local que o `rb-manifest/v1` consegue indexar,
  `.rb/context/AGENTS.md`; um caminho proibido é classificado como defeito de
  substância, não de forma; e um defeito assim ganha um único replanejamento
  contado carregando a rejeição exata, em vez de três tentativas que só podem
  falhar do mesmo jeito;
- a correção estrutural substitui por inteiro cada documento que planeja, mas o
  contrato pedia uma mudança "localizada". Uma correção que emitia apenas o
  trecho corrigido apagava título, marcadores de contrato e todas as fases do
  documento, e os validadores reportavam quatro sintomas de uma única causa. O
  contrato agora afirma que um documento replanejado é reescrito por inteiro, e
  uma correção que perde o título ou um marcador declarado pelo original é
  rejeitada pelo nome do defeito, não pelos erros de gramática que ele produz.

Em todos os papéis documentais o provider é somente leitura: o Codex roda com
`--sandbox read-only`, o Claude com `--permission-mode plan` e o OpenCode com
edição, shell, task e diretório externo negados.

No adapter OpenCode, `--effort none` é traduzido para a variante `minimal` que
a própria CLI documenta. Repassar literalmente `--variant none` permitia um
fallback silencioso para o padrão do modelo; em uma execução real isso consumiu
32 mil tokens de reasoning e produziu zero texto.

O provider nunca roda dentro do projeto. Ele roda em uma **projeção de
evidências** somente leitura e limitada: os arquivos do projeto-alvo admitidos
pela política de inventário, espelhados nos mesmos caminhos relativos e nada
mais. Não existe ali `.rb-harness`, `.git`, árvore de dependências ou build,
arquivo de credencial nem diretório do run. Ela é construída em uma raiz
temporária própria — nunca sob `.rb-harness/runs/<id>/`, o que deixaria o
`state.json` da execução um diretório acima do provider —, seus arquivos e
diretórios são selados como somente leitura depois de populados e ela é removida
ao fim da execução. O caminho absoluto do projeto real nunca é entregue ao
provider: o pacote de entrada nomeia o projeto pelo basename e
`RB_HARNESS_PROJECT_ROOT` aponta para a projeção. As ferramentas do runtime
direto aplicam a mesma política por caminho: nomear diretamente um diretório
proibido é recusado, não apenas ocultado da listagem.

**Isto não é sandbox de SO, e o Harness não o descreve como tal.** Apenas o
runtime de API direta confina *leituras*, porque suas ferramentas aplicam a
política de caminhos em processo. O `--sandbox read-only` do Codex e o
`--permission-mode plan` do Claude bloqueiam escrita e deixam o sistema de
arquivos legível; esses adapters são declarados como sem confinamento de leitura
e o log diz isso a cada execução. A projeção remove o plano de controle de todo
caminho relativo e esconde a localização do projeto; ela não impede uma CLI que
vá procurar por caminho absoluto.

## O que cada adapter realmente controla

O runtime de API direta é o único adapter que o Harness controla de ponta a
ponta: ele é dono do catálogo de ferramentas, conta cada chamada e reporta o
usage devolvido pelo provider. Uma CLI externa roda o próprio loop de agente, e o
Harness declara explicitamente o que consegue ou não medir:

| Adapter | Controle interno | Orçamento de turns/tools | Métricas de uso | Confinamento de leitura | Transporte do stdout |
|---|---|---|---|---|---|
| APIs diretas | aplicado localmente | aplicado | reportado quando o provider devolve `usage` | aplicado em processo | texto final (streaming interno) |
| `opencode` | consumido via `run --format json` | aplicado | tokens/cache/custo medidos quando o evento terminal os informa | nenhum | eventos JSONL |
| `codex` | `exec --json` anunciado, não consumido | não alegado | não medido | nenhum | texto final |
| `claude` | `--output-format stream-json` anunciado, não consumido | não alegado | não medido | nenhum | texto final |
| `custom` | nada declarado | não alegado | não medido | nenhum | texto final |

### APIs diretas usam streaming interno

Um provider de API direta roda pelo runtime embutido, que agora pede uma
resposta incremental e a consome conforme ela chega — SSE de chat completions no
dialeto compatível com OpenAI e o stream de eventos no Anthropic Messages. Texto,
reasoning, nomes de tool calls e argumentos fragmentados são remontados dentro do
runtime; os argumentos só são parseados quando a resposta termina.

Isso muda a observabilidade, não o resultado. **O stdout do subprocesso continua
carregando exatamente uma coisa: a resposta final completa do modelo, byte a
byte.** Nenhum fragmento do envelope documental é escrito no stdout. Enquanto a
chamada está em andamento, o runtime informa atividade remota real por um canal
separado no stderr, em marcadores sem conteúdo — um tipo como `content-delta`,
nunca um token, um trecho de reasoning, um argumento de tool ou um segredo.

É por isso que o `--first-output-timeout` volta a ter significado:

- **`--first-output-timeout`** (padrão 300 s) mede o tempo até o provider
  *realmente começar a responder* — o primeiro evento remoto. Um runtime sem
  streaming ficava mudo até o loop inteiro terminar, então esse limite matava
  gerações legítimas e já pagas.
- **`--timeout`** (padrão 3600 s) continua sendo o limite total da chamada.

Não existe heartbeat local de propósito. Um timer disparado pelo próprio Harness
provaria apenas que o Harness está vivo e transformaria silenciosamente o
first-output em um segundo wall timeout. O progresso só é renovado por um novo
evento remoto; um comentário keep-alive do SSE é consumido e não renova nada. A
saída no terminal continua compacta — *"provider respondeu após 3s; recebendo
stream..."* e depois *"provider ativo há 15s; 42 eventos remotos recebidos"* — e
nunca imprime tokens nem documentos parciais. O log da execução registra
`remote_events` e `first_remote_event_ms`, e nenhum conteúdo do stream.

O suporte a streaming é declarado por provider no registry, nunca inferido pelo
id do provider em cada ponto do código. Um provider que não sirva o protocolo de
streaming do seu dialeto falha com diagnóstico explícito; o runtime nunca repete
a mesma requisição sem streaming, porque isso poderia pagar duas vezes pela mesma
resposta. Em timeout, `SIGINT` ou `SIGTERM`, o fetch e o leitor do stream são
abortados, nenhuma tool nova é executada, nenhuma resposta parcial é publicada e
o usage que o provider não entregou permanece desconhecido em vez de virar zero.

### Reasoning é um modo explícito e declarado

Reasoning é cobrado como saída. Um modelo que raciocina e nunca responde gasta a
cota inteira do mesmo jeito, e foi exatamente o que aconteceu: uma geração real
consumiu 65.536 tokens de saída produzindo 2.280 deltas de reasoning, zero deltas
de conteúdo e nenhum documento. O stream estava saudável e o parser estava
correto — o Harness simplesmente forçava `thinking: { type: "enabled" }` em toda
requisição ao DeepSeek, então uma execução sem `--effort` herdava o padrão de
alta intensidade do próprio provider sem nunca ter pedido por ele.

Se um provider raciocina passou a ser uma capacidade declarada no registry, ao
lado das capacidades de streaming e de autenticação e independente de ambas. O
runtime lê essa declaração; não existe teste `provider === "..."` em nenhum ponto
do código, e acrescentar um provider não toca o fluxo de requisição. Hoje só o
DeepSeek a declara; todos os outros mantêm exatamente a requisição que já
enviavam.

Para um provider que declara o toggle:

| `--effort` | Enviado | Significado |
| --- | --- | --- |
| *(omitido)* | `thinking: { type: "disabled" }` | O padrão seguro: geração direta, sem reasoning. |
| `none` | `thinking: { type: "disabled" }` | O mesmo, dito explicitamente. Nenhum `reasoning_effort` é enviado — o desligamento pertence ao toggle, e uma intensidade "none" seria uma segunda afirmação contraditória da mesma decisão. |
| `low` | `thinking: { type: "enabled" }` + `reasoning_effort: low` | Reasoning ligado, na menor intensidade. |
| `medium`, `high`, `xhigh`, `max` | `thinking: { type: "enabled" }` + a intensidade | Uso deliberado e progressivamente mais caro. |
| qualquer outro | *nada* | Recusado antes de abrir qualquer conexão. |

```bash
# Geração direta, sem reasoning — o padrão do DeepSeek.
rb-harness init --project . --file docs/prd.md \
  --provider deepseek --credential ds_oficial \
  --model deepseek-v4-flash --effort none --output .rb

# Thinking habilitado na menor intensidade.
rb-harness init --project . --file docs/prd.md \
  --provider deepseek --credential ds_oficial \
  --model deepseek-v4-flash --effort low --output .rb
```

Um effort que o provider não aceita falha antes de a requisição ser montada. A
mensagem informa o provider, o valor recebido e os valores aceitos, e diz que
nenhuma requisição foi iniciada — nunca é corrigido em silêncio, promovido para
uma intensidade maior nem repetido a preço de mercado.

Quando uma resposta de fato termina com o limite de saída esgotado e sem resposta
final, o diagnóstico diz isso com precisão em vez de reportar uma parada
genérica:

```text
provider exhausted its output limit using reasoning without producing a final
response (finish_reason=length; reasoning events=2280; content events=0;
usage input=9501 output=65536 total=75037; no partial response was published)
```

Números de token só aparecem quando o provider os informou; caso contrário a
mensagem diz `usage not reported by the provider` em vez de imprimir zero.
Reasoning e conteúdo são contados separadamente no log da execução
(`reasoning_events`, `content_events`, `reasoning_bytes`, `content_bytes`) e no
registro de usage, de modo que uma chamada que gastou tudo em reasoning fica
legível como tal. Esses contadores guardam apenas tamanhos e quantidades: nenhum
texto de reasoning, fragmento de artefato, argumento de ferramenta, credencial ou
prompt é armazenado, e os marcadores no stderr continuam sem conteúdo. Uma
resposta que termina por limite, truncamento, cancelamento, erro HTTP ou sem
mensagem final não publica nada — sem stdout parcial, sem `.rb` parcial, sem
reasoning promovido a resposta e sem uma segunda chamada paga automática para
terminar.

Controle e transporte são colunas separadas porque são fatos separados. Um
provider de API direta roda pelo runtime embutido, que é dono do catálogo de
ferramentas, conta cada chamada, reporta o usage real do provider e confina
leituras — ele é de fato controlado. Mesmo assim, o que esse runtime escreve no
stdout é uma coisa só: a resposta final do modelo, envelope incluído. Apenas o
`opencode`, cujo stream de eventos JSONL o Harness realmente consome, tem a
resposta final reconstruída a partir de eventos; o stdout de qualquer outro
adapter é entregue ao parser de envelopes byte a byte. Cada log de execução
registra `stdout_transport=final-text` ou `stdout_transport=jsonl-events`, então
a distinção fica visível por execução.

Cada declaração foi lida do `--help` de uma versão instalada localmente, não
inventada. Um adapter cujo stream o Harness não consome é governado apenas por
limites conservadores — timeout total, timeout de primeira saída, volume de saída
e uma janela de progresso em que a saída precisa trazer algo **novo**, já que um
agente travado repete a si mesmo indefinidamente. Essa execução é rotulada como
não medida naquele eixo; jamais é descrita como respeitando o orçamento do
runtime direto. Uma linha que começa como evento estruturado e não faz parse é
falha de protocolo, reportada explicitamente em vez de ignorada — inclusive um
stream truncado no EOF, cujo evento parcial final é sinalizado no fechamento em
vez de descartado.

Para o OpenCode o Harness segue o schema real da build 1.18.21 instalada: os
eventos são `{ type, properties }` e uma part de tool é reemitida conforme o
estado avança `pending → running → completed`. Contar esses eventos reportaria
uma invocação três vezes, então as invocações são contadas pelo `callID` do
próprio provider, e uma part `step-start` conta como turn do modelo.

## Entrevista adaptativa

A entrevista termina quando converge, não quando expira. Há um lote inicial de
no máximo 5 perguntas materiais e, depois dele, quantas rodadas focadas de até 3
perguntas a convergência exigir: uma resposta que abre uma nova decisão material
ganha outra rodada, e a entrevista só encerra quando não resta ambiguidade
material. As perguntas são apresentadas uma a uma; `--questions batch` apenas
anuncia a rodada inteira antes de respondê-la.

Fatos descobertos no projeto não viram perguntas. Uma escolha FLEXIBLE vira
suposição explícita e não bloqueia. Uma decisão que o desenvolvedor já respondeu
nunca é perguntada de novo.

Dois tetos de segurança declarados mantêm a máquina de estados finita — no
máximo 12 rodadas e 40 perguntas por execução. Eles não são o ponto de parada
pretendido: atingir qualquer um deles é falha de convergência e produz `BLOCKED`
nomeando a decisão ainda em aberto, nunca um aceite silencioso.

Cada resposta é classificada como `ACCEPTED`, `PARTIAL`, `AMBIGUOUS`, `DEFERRED`
ou `CONTRADICTED`. Respostas parciais, contraditórias ou ambíguas produzem uma
pergunta focada com novo ID enquanto houver rodada disponível.

Apenas a **forma** é reparada automaticamente: ID de pergunta malformado, tipo
inferível, lista de opções vazia. Disposição ausente, desconhecida ou escrita
incorretamente é falha semântica, nunca um aceite — a resposta segue como não
resolvida, o provider recebe as tentativas limitadas do formatador e, se o
defeito persistir, a resposta gera follow-up focado ou bloqueia a execução.
`ACCEPTED` exige disposição explícita e uma decisão única normalizada; o texto
bruto só substitui essa decisão sob um `ACCEPTED` explícito. Perguntas acima do
orçamento da rodada também não somem: são carregadas para a rodada seguinte como
decisões abertas declaradas em `unresolved`, e a existência delas impede um
resultado `ready`. Só no teto de segurança, onde não há próxima rodada, elas
viram decisões adiadas e bloqueiam.

Se o provider chegar às conclusões substantivas mas omitir ou quebrar o
envelope da entrevista, o Harness preserva a saída bruta e abre no máximo três
tentativas de formatação fechadas, sem ferramentas nem acesso ao projeto. Um
objeto JSON válido também é aceito sem as linhas decorativas de marcação. Se a
terceira formatação ainda for inválida, a execução falha explicitamente; a
descoberta paga nunca é repetida para reparar somente a representação.

Por padrão as perguntas aparecem uma por vez:

```bash
rb-harness evolve --project . --file docs/change.md \
  --provider codex --model gpt-5.6-sol --effort high \
  --questions one-by-one
```

Para exibir o lote da rodada ou responder sem terminal:

```bash
rb-harness plan --project . --file docs/feature.md \
  --provider codex --questions batch

rb-harness plan --project . --file docs/feature.md \
  --provider codex --non-interactive --answers answers.json
```

`--questions one-by-one` controla apenas a apresentação local e nunca custa uma
chamada extra ao provider. Checkpoints e respostas validadas são persistidos sob
`.rb-harness/runs/`, permitindo retomar sem repetir etapas já concluídas.

## Workflows

### `init`

Inicializa a especificação de um projeto novo:

```bash
rb-harness init \
  --prompt "Criar uma plataforma de agendamento para clínicas" \
  --provider codex --model gpt-5.6-sol --effort high
```

### `ai-context`

Reconstrói o estado atual implementado de um projeto existente e produz
`AGENTS.md` e contexto AS IS baseado em evidências:

```bash
rb-harness ai-context --project . --provider codex
```

### `plan`

Planeja uma feature, correção, refatoração, migração ou dívida técnica isolada:

```bash
rb-harness plan --project . --file docs/feature.md --provider codex
```

### `evolve`

Planeja uma mudança em comportamento existente, provando AS IS, TO BE,
impactos, preservações, migração e regressões:

```bash
rb-harness evolve --project . --file docs/change.md --provider codex
```

### `review`

Audita o produto existente de ponta a ponta sem alterar código:

```bash
rb-harness review --project . --provider codex --output .rb
```

Os artefatos físicos são gravados em `.rb` por padrão. `--output .spec` permite
usar outra pasta sem alterar os paths lógicos `.rb/...` presentes nos contratos.

## Dashboard e telemetria

Use `--dashboard` para acompanhar a máquina de estados documental — inventário,
análise de lacunas, espera por resposta humana, descoberta de evidências,
geração do pacote, materialização, validação, correção estrutural e publicação:

```bash
rb-harness evolve --project . --file docs/change.md \
  --provider codex --model gpt-5.6-sol --effort high \
  --dashboard
```

O painel também mostra telemetria real: chamadas ao provider, leituras
confinadas de ferramentas, requisições e tokens de entrada, cache, criação de
cache e saída quando o provider informa usage. Um provider que não informa usage
aparece como não medido; nenhum custo é inventado e bytes repetidos nunca são
apresentados como progresso. O relatório final imprime a duração de cada etapa e
a quantidade de chamadas, e cada execução grava `telemetry.json` ao lado do seu
estado.

Os números de cache vêm só do que o provider mediu: um adapter que não informa
usage é registrado como não medido, nunca como execução de zero tokens ou custo
zero. O Harness garante um prefixo de prompt byte a byte idêntico entre as
rodadas de uma execução — contrato, recursos e pacote de entrada antes de
qualquer estado de rodada — mas não afirma reaproveitamento de cache entre
processos ou sessões sem métrica do provider.

Os limites de bytes declarados são verificados antes de qualquer processo de
provider nascer. A solicitação é autoridade e nunca é truncada: uma solicitação
acima do orçamento falha no preflight informando tamanho observado, limite e
caminho seguro, e o mesmo vale para o pacote de entrada, as decisões aceitas e
cada prompt.

`--timeout` limita o tempo total de cada chamada. `--first-output-timeout`
limita o tempo até o primeiro byte. Toda execução de provider termina liquidando
a árvore de processos — inclusive as que dão certo, já que um líder que sai com
código zero não diz nada sobre o que ele destacou. Polling sozinho não resolve:
um líder pode colocar um descendente em nova sessão com `setsid()` e sair em
poucos milissegundos; depois disso nada liga o descendente à execução e nenhum
sinal de grupo o alcança.

Onde a plataforma oferece **contenção estrutural**, o Harness a usa e consegue
provar que a árvore acabou. No Linux com um subtree cgroup v2 gravável, o filho
entra em um cgroup por execução antes de conseguir forkar; a associação é
herdada por `fork` e `setsid`, continua enumerável depois que o líder morre, e
`cgroup.kill` remove todos os membros atomicamente.

Onde não oferece, o Harness declara isso em vez de alegar garantia. A escada
idempotente continua rodando — parar a admissão, `SIGTERM` ao grupo, janela curta
de graça, `SIGKILL` nos sobreviventes —, mas o encerramento é reportado como não
verificado, e o log da execução registra `tree_containment_structural=false` e
`tree_quiescence_verified=false`. No Windows o mecanismo é `taskkill /T`, que
percorre a cadeia de pais: ele **não** é um Job Object e é declarado como melhor
esforço exatamente por isso. Um descendente lembrado só é sinalizado de novo
enquanto continuar no grupo de processos em que foi visto, evitando atingir um
PID reutilizado.

## Verificação de artefatos antes do Ralph

O comando abaixo é determinístico por contrato: não inicia provider, não gasta
tokens e não edita nem republica artefatos.

```bash
rb-harness artifacts verify \
  --project . \
  --artifacts-dir .rb \
  --against docs/solicitacao-original.md \
  --dashboard
```

Ele prova:

- schema e hashes do manifesto;
- contratos `rb-execution/v1`, `rb-operational/v1` e `rb-responsive-inventory/v1`;
- descoberta de planos prontos;
- paths de contexto para fases frias;
- integridade das referências de tasks;
- cobertura de requisitos declarados pela especificação;
- portabilidade dos caminhos declarados.

Uma árvore incompatível nunca pode ser anunciada como pronta para o Ralph.

Todo relatório segue `rb-harness-artifact-verification/v1`, usa modo `0600` e é
gravado em `.rb-harness/verifications/`. Ele inclui impressões SHA-256 da
árvore física completa, excluindo apenas o estado vivo `.rb/runs`, e da
autoridade formada pela solicitação original e decisões aceitas.

Os códigos de saída são:

- `0`: pronto para Ralph, possivelmente com avisos menores;
- `2`: falhas materiais reparáveis;
- `3`: decisão real do desenvolvedor ainda ausente;
- `1`: falha do próprio verificador.

## O que foi removido com o gerente semântico

O gerente LLM de documentação, o auditor semântico independente e o ciclo de
remediação guiado por auditoria foram removidos na versão 0.4.0. Eles repetiam
leitura e escrita sem garantir progresso monotônico: uma reemissão completa
podia produzir um novo conjunto de achados, o que é não convergência, não
qualidade.

As opções que existiam apenas para acioná-los falham com erro orientativo, em
vez de serem silenciosamente reinterpretadas:

- `--remediate` e `--from-report` — execute o workflow novamente; hoje existe uma
  única correção estrutural limitada dentro da própria geração;
- `--answers` e `--non-interactive` no `artifacts verify` — a verificação
  determinística não faz perguntas.

`--deterministic-only` continua aceito e agora descreve o único comportamento.
`--provider`, `--model`, `--effort`, `--credential`, `--adapter`, `--timeout` e
`--first-output-timeout` continuam aceitos no `artifacts verify` para que
scripts existentes sigam funcionando; eles são registrados como procedência e
não iniciam provider algum.

## Status, retomada e artefatos antigos

```bash
rb-harness status --project .
rb-harness resume --project .
rb-harness resume <run-id> --project .
```

Uma resposta do provider que chegou ao log da execução é evidência autoritativa:
o log registra exatamente os bytes que o provider escreveu. Um envelope válido
quando foi gravado continua recuperável no resume, mesmo que a execução que o
produziu tenha falhado depois.

Os checkpoints duráveis separam entrevista concluída, plano documental, cada
parte aceita, pacote montado, materialização, validação e publicação. Uma parte
completa já preservada nunca é solicitada de novo; uma execução interrompida
continua na primeira parte ausente. Uma execução que falhou apenas na validação
retoma a partir do pacote montado. Publicações interrompidas restauram a revisão
anterior, e um lock residual sem processo vivo é recuperado automaticamente com
mensagem explícita.

Quando uma nova árvore é publicada, a anterior é movida para
`.rb-harness/runs/<run-id>/previous-artifacts`. O Harness nunca apaga
silenciosamente a documentação anterior.

## CLI determinística

```bash
rb-harness contract validate .rb/features/<slug>/PHASES.md
rb-harness operations validate .rb/features/<slug>/OPERATIONS.json
rb-harness manifest sync .
rb-harness tree validate .
rb-harness tree resolve . --format tsv
rb-harness inspect .
rb-harness artifacts inspect --project . --output .rb --json
rb-harness artifacts verify --project . --artifacts-dir .rb --deterministic-only --json
```

Árvores físicas alternativas são suportadas:

```bash
rb-harness tree validate . --artifacts-dir .spec
rb-harness tree resolve . --artifacts-dir .spec --format tsv
```

## Contrato com o RB Ralph

O Harness publica:

- `rb-manifest/v1`, índice canônico de artefatos;
- `rb-execution/v1`, plano de fases e tasks consumido pelo Ralph;
- opcionalmente `rb-operational/v1`, aceitação operacional limpa.

O Ralph seleciona apenas planos `ready`, valida hashes e contratos e começa
cada unidade de execução com contexto novo. Os documentos continuam neutros:
também podem ser entregues diretamente a outro executor compatível.

## Compatibilidade com plugins antigos

O executável é a interface principal. Os diretórios em `plugins/rb-harness/`
permanecem para compatibilidade com instalações antigas de Codex e Claude, mas
delegam ao mesmo runtime empacotado e aos mesmos contratos.

## Desenvolvimento

```bash
npm install
npm run build
npm run typecheck
npm test
npm run check
```

`npm run check` também empacota o standalone, executa um workflow completo pelo
symlink instalado, roda os contratos publicados contra o resultado, verifica
compatibilidade Bash e valida os bundles de plugin.

Para medir um workflow real contra um provider real e gravar um relatório
versionado e sem credenciais:

```bash
node scripts/benchmark.mjs --project /caminho/do/projeto \
  --workflow init --file prompt.md \
  --provider opencode --model opencode-go/deepseek-v4-pro \
  --label cron2-rb-harness --observed-cost-usd 0.23
```

O script recusa reaproveitar execuções antigas, prova a prontidão para o Ralph
pelo contrato determinístico de artefatos, grava relatório mesmo quando falha e
sai com código diferente de zero em qualquer falha ou estouro de limite.

Custo é um dos critérios de aceitação, então uma execução cujo custo nunca foi
observado fica `incomplete` — nunca `passed`. Ela é finalizada depois, sobre o
mesmo relatório e sem reinvocar o provider:

```bash
node scripts/benchmark.mjs finalize \
  --report docs/benchmarks/<arquivo>.json --observed-cost-usd 0.23
```

Os códigos de saída são `0` aprovado, `1` reprovado e `2` incompleto.

A linha de base medida antes desta refatoração está em
`docs/benchmarks/baseline-2026-08-24.md`. **O benchmark real da 0.4.0 ainda não
foi executado**: ele consome recursos pagos e depende de autorização explícita do
operador. Até lá, nenhuma afirmação de superação da linha de base é feita.

## Limites de produto

- O Harness gera documentação; não implementa a aplicação.
- O `verify` é determinístico e somente leitura; nunca inicia um provider.
- Existe no máximo uma correção estrutural localizada por execução.
- Não existe gerente, auditor semântico nem correção automática ilimitada.
- O RB Ralph não é alterado por este produto; ele apenas consome o contrato.
- Credenciais não pertencem aos artefatos.
- Contratos e documentação são agnósticos a modelo, provider, stack e projeto.
- Exemplos usados em testes nunca viram regras especiais para um produto.

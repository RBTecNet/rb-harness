# RB Harness

[English](README.md) · [Português do Brasil](README.pt-BR.md)

O RB Harness transforma uma solicitação de produto em documentação executável,
neutra de modelo e compatível com o RB Ralph. Ele entrevista o desenvolvedor
somente sobre decisões materiais ausentes, inspeciona o projeto quando o fluxo
exige conhecimento do estado atual e publica artefatos versionados sem
implementar o código da aplicação.

A geração normal usa um único escritor de documentação. Não existe um gerente
LLM em loop depois do escritor. Qualidade estrutural é responsabilidade de
validadores determinísticos; uma segunda opinião semântica pode ser solicitada
separadamente com `rb-harness artifacts verify`.

## Instalação do executável

O RB Harness 0.3.14 exige Node.js 20 ou superior. No clone do repositório:

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
# 0.3.14
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

## Entrevista adaptativa

Antes de gerar, o controlador de entrevista lê a solicitação, os artefatos
existentes e, quando permitido pelo workflow, o código-fonte relevante. Ele
aceita respostas apenas quando consegue normalizá-las como decisão concreta.
Respostas parciais, contraditórias ou ambíguas produzem uma pergunta focada com
novo ID.

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

O teto de segurança da entrevista é finito. Checkpoints e respostas validadas
são persistidos sob `.rb-harness/runs/`, permitindo retomar sem repetir etapas
já concluídas.

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

## Dashboard

Use `--dashboard` para acompanhar entrevista, geração, bytes observados,
provider, modelo e estado da execução:

```bash
rb-harness evolve --project . --file docs/change.md \
  --provider codex --model gpt-5.6-sol --effort high \
  --dashboard
```

`--timeout` limita o tempo total de cada chamada. `--first-output-timeout`
limita o tempo até o primeiro byte. O Harness encerra a árvore inteira de
processos do provider em timeout ou estouro do limite de saída, evitando
processos órfãos de ferramentas e testes.

## Verificação de artefatos antes do Ralph

O comando abaixo não edita artefatos:

```bash
rb-harness artifacts verify \
  --project . \
  --artifacts-dir .rb \
  --against docs/solicitacao-original.md \
  --provider codex --model gpt-5.6-sol --effort high \
  --dashboard
```

Primeiro são executados gates determinísticos:

- schema e hashes do manifesto;
- contratos `rb-execution/v1` e `rb-operational/v1`;
- descoberta de planos prontos;
- paths de contexto para fases frias;
- integridade das referências de tasks.

Um blocker mecânico encerra antes do provider, economizando tokens. Se a árvore
for mecanicamente utilizável, ocorre uma auditoria semântica exaustiva e
somente leitura. Ela retorna todas as causas materiais em um lote e pode fazer
no máximo uma correção de formato JSON; achados não iniciam um loop de gerente.

Todo relatório segue `rb-harness-artifact-verification/v1`, usa modo `0600` e é
gravado em `.rb-harness/verifications/`. Ele inclui impressões SHA-256 da
árvore física completa, excluindo apenas o estado vivo `.rb/runs`, e da
autoridade formada pela solicitação original e decisões aceitas.

Os códigos de saída são:

- `0`: pronto para Ralph, possivelmente com avisos menores;
- `2`: falhas materiais reparáveis;
- `3`: decisão real do desenvolvedor ainda ausente;
- `1`: falha do próprio verificador ou provider.

Para um preflight sem tokens:

```bash
rb-harness artifacts verify --project . --artifacts-dir .rb \
  --deterministic-only --json
```

## Remediação limitada

Uma verificação reprovada pode alimentar uma única reemissão. A auditoria
inicial não é repetida:

```bash
# 1. Auditoria somente leitura; o relatório fica salvo.
rb-harness artifacts verify \
  --project . --artifacts-dir .rb \
  --against docs/solicitacao-original.md \
  --provider codex --model gpt-5.6-sol --effort high

# 2. Consome automaticamente o relatório compatível mais recente.
rb-harness artifacts verify \
  --project . --artifacts-dir .rb \
  --provider codex --model gpt-5.6-sol --effort high \
  --remediate --questions one-by-one --dashboard
```

Para escolher um relatório específico:

```bash
rb-harness artifacts verify \
  --project . --artifacts-dir .rb \
  --provider codex --remediate \
  --from-report .rb-harness/verifications/<id>/report.json
```

As impressões digitais do relatório devem ser idênticas à árvore e à autoridade
atuais. Se qualquer byte dos artefatos, a solicitação original ou uma decisão
aceita mudou após a auditoria, o relatório é rejeitado como stale e uma nova
execução sem `--remediate` é exigida. Quando a auditoria original usou
`--against`, a remediação herda o caminho da autoridade registrado no
relatório; repetir a opção é permitido, mas não é necessário.

O fluxo de remediação é deliberadamente limitado:

1. carrega o relatório já produzido;
2. transforma gaps técnicos em responsabilidade do escritor;
3. pergunta somente decisões de produto realmente ausentes;
4. cria uma cópia isolada do projeto e da documentação;
5. faz exatamente uma reemissão integral;
6. valida e publica atomicamente;
7. preserva a árvore anterior dentro do run da remediação;
8. executa exatamente uma verificação final;
9. encerra mesmo que ainda existam achados.

Não existe uma segunda geração automática. Isso impede ciclos eternos de
writer/manager e mantém custo e duração previsíveis. Se o relatório já estiver
verde, nenhum provider é iniciado e nenhum arquivo é alterado.

`--remediate` não pode ser combinado com `--deterministic-only` nem `--json`.
Em automação, use `--answers respostas.json --non-interactive` e consuma os
relatórios persistidos.

## Status, retomada e artefatos antigos

```bash
rb-harness status --project .
rb-harness resume --project .
rb-harness resume <run-id> --project .
```

O estado durável diferencia entrevista, geração, validação e publicação. Uma
geração completa que falhou apenas em validação pode ser retomada sem chamar o
escritor novamente. Publicações interrompidas restauram a revisão anterior.

Quando uma nova árvore é publicada, a anterior é movida para
`.rb-harness/runs/<run-id>/previous-artifacts`. O Harness nunca apaga
silenciosamente a documentação anterior durante geração ou remediação.

## CLI determinística

```bash
rb-harness manifest sync .
rb-harness tree validate .
rb-harness tree resolve . --format tsv
rb-harness inspect .
rb-harness artifacts inspect --project . --output .rb --json
rb-harness operations validate .rb/OPERATIONS.json
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

`npm run check` também empacota o standalone, executa pelo symlink instalado,
verifica compatibilidade Bash e valida os bundles de plugin.

## Limites de produto

- O Harness gera documentação; não implementa a aplicação.
- O `verify` padrão é somente leitura.
- Remediação exige autorização explícita por `--remediate`.
- Não existe correção automática ilimitada.
- Credenciais não pertencem aos artefatos.
- Contratos e documentação são agnósticos a modelo, provider, stack e projeto.
- Exemplos usados em testes nunca viram regras especiais para um produto.

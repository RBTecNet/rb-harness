# RB Harness — funcionalidades e exemplos de uso

Referência completa dos comandos do RB Harness `0.5.14`, com um exemplo de uso
para cada funcionalidade. Todo comando aqui foi extraído da própria CLI
instalada; nada é aspiracional.

O RB Harness transforma um prompt livre — digitado ou vindo de um arquivo — em
artefatos que respeitam os contratos que o RB Ralph consome. Ele **nunca escreve
código de aplicação**: escreve apenas documentação sob `.rb/` e valida
contratos.

---

## Índice

- [Antes de começar](#antes-de-começar)
- [1. Workflows de geração](#1-workflows-de-geração) — `init`, `ai-context`, `plan`, `evolve`, `review`
- [2. Modo assistido](#2-modo-assistido) — `wizard`
- [3. Credenciais e providers](#3-credenciais-e-providers) — `auth`, `provider`, `--login`
- [4. Validação de contratos](#4-validação-de-contratos) — `contract`, `operations`, `review validate-responsive`
- [5. Árvore de artefatos](#5-árvore-de-artefatos) — `project`, `manifest`, `tree`, `inspect`
- [6. Prontidão e acompanhamento](#6-prontidão-e-acompanhamento) — `artifacts`, `status`, `resume`
- [7. Automação headless](#7-automação-headless) — `headless`
- [8. Opções globais](#8-opções-globais)
- [9. Opções compartilhadas pelos workflows](#9-opções-compartilhadas-pelos-workflows)
- [10. Receitas completas](#10-receitas-completas)

---

## Antes de começar

O RB Harness exige Node.js 20 ou superior.

```bash
# a partir do clone do repositório
npm install
npm run build
npm run install:user      # instala o binário rb-harness em ~/.local
```

Verifique a instalação:

```bash
rb-harness --version
# 0.5.14
```

---

## 1. Workflows de geração

Os cinco workflows compartilham o mesmo fluxo: inventário → entrevista adaptativa
→ checkpoint fechado de decisões → autoria incremental → validação determinística
→ publicação atômica. Eles diferem no que produzem.

Todos aceitam a solicitação de três formas equivalentes: como argumento
posicional, via `--prompt`, ou via `--file`.

### 1.1 `init` — documentar e planejar um projeto novo

Produz `.rb/init/` com `PROJECT.md`, `REQUIREMENTS.md`, `DECISIONS.md`,
`PLAN.md`, um `PHASES.md` válido em `rb-execution/v1` e, quando o produto tem
um entrypoint automatizável, `OPERATIONS.json`.

```bash
# a partir de um PRD em arquivo
rb-harness init --file docs/prd.md \
  --provider codex --model gpt-5.4-mini --effort high \
  --project . --output .rb
```

```bash
# a partir de texto direto, com o painel ao vivo
rb-harness init "Uma CLI que converte CSV em Parquet, com validação de esquema" \
  --provider deepseek --model deepseek-v4-flash --credential ds_oficial \
  --dashboard
```

### 1.2 `ai-context` — engenharia reversa de um projeto existente

Descobre a arquitetura implementada e escreve `.rb/context/` — `AGENTS.md`
(índice), `ARCHITECTURE.md`, `DOMAIN.md`, `OPERATIONS.md`. Documenta **o que
existe**, nunca o que se pretende construir.

```bash
rb-harness ai-context --project /caminho/do/projeto \
  --provider claude --model opus --depth deep
```

`--depth` aceita `quick`, `balanced` (padrão) ou `deep`. O modo `deep` amplia a
investigação em segurança, contratos públicos, migrações e dados regulados.

### 1.3 `plan` — planejar uma mudança isolada

Para uma feature nova, correção, refactor, migração, mudança de performance ou
de contrato que **não** altera um fluxo já estabelecido. Escreve
`.rb/features/<slug>/` com `REQUEST.md`, `SPEC.md`, `PLAN.md`, `PHASES.md` e
contratos formais quando aplicável.

```bash
rb-harness plan --file mudanca.md \
  --provider codex --model gpt-5.4-mini --effort high
```

```bash
# não-interativo, com respostas pré-definidas
rb-harness plan "Adicionar exportação em PDF ao relatório mensal" \
  --answers respostas.json --non-interactive
```

O arquivo de respostas é um objeto JSON indexado pelo ID da pergunta:

```json
{ "escopo-exportacao": "Somente o relatório mensal, não o diário." }
```

### 1.4 `evolve` — mudar comportamento já estabelecido

Quando a mudança afeta uma jornada existente, uma transição de estado, um
formato armazenado, uma fronteira de permissão ou um consumidor. Escreve
`.rb/evolutions/<slug>/` com `AS_IS.md`, `TO_BE.md`, `IMPACT.md`,
`REGRESSION_MATRIX.md` e `PHASES.md`.

```bash
rb-harness evolve "Trocar a autenticação por sessão para JWT sem quebrar clientes atuais" \
  --project . --provider codex --model gpt-5.4-mini --effort high
```

Use `evolve` em vez de `plan` sempre que houver comportamento em produção a
preservar — mesmo que o pedido seja descrito como "feature nova".

### 1.5 `review` — auditar o produto inteiro

Audita a aplicação de ponta a ponta e registra achados com IDs estáveis em
`.rb/reviews/<review-id>/`. Opcionalmente planeja a remediação dos achados que
você selecionar explicitamente.

```bash
# auditoria completa
rb-harness review --project . \
  --provider claude --model opus --depth deep
```

```bash
# auditoria focada em áreas específicas
rb-harness review --project . --focus security tenancy data
```

```bash
# planejar remediação apenas de achados escolhidos
rb-harness review --project . --findings SEC-003 DATA-011
```

```bash
# planejar todos os achados confirmados
rb-harness review --project . --plan-all-confirmed
```

---

## 2. Modo assistido

### 2.1 `wizard` — montar o comando interativamente

Faz as perguntas necessárias (workflow, provider, modelo, esforço, projeto) e
executa. É o que roda quando você chama `rb-harness` sem argumentos.

```bash
rb-harness wizard
```

```bash
rb-harness          # equivalente: abre o wizard
```

---

## 3. Credenciais e providers

Providers de CLI (`codex`, `claude`, `opencode`) usam o login da própria
ferramenta. Providers de API direta (`openai`, `anthropic`, `gemini`,
`deepseek`, `minimax`, `openrouter`) usam o cofre de credenciais do RB.

### 3.1 `auth login` — configurar uma credencial

Segredos **nunca** são aceitos como argumento de linha de comando; são pedidos
interativamente.

```bash
rb-harness auth login --provider deepseek --protocol api-key --label ds_oficial
```

```bash
rb-harness auth login --provider openrouter --protocol oauth-pkce
```

```bash
rb-harness --login      # atalho global para o mesmo fluxo
```

### 3.2 `auth list` — ver credenciais salvas sem revelar segredos

```bash
rb-harness auth list
rb-harness auth list --json
```

### 3.3 `auth logout` — remover uma credencial

```bash
rb-harness auth logout ds_oficial
```

### 3.4 `provider list` — ver providers e o estado de cada um

```bash
rb-harness provider list
```

```
PROVIDER   TIPO          AUTENTICAÇÃO       ESTADO            CREDENCIAIS
codex      cli           provider-cli-login external-login    —
deepseek   direct-api    api-key            configured        ds_oficial
```

```bash
rb-harness provider list --json     # contrato rb-provider-list/v1
```

### 3.5 `provider test` — testar a conexão antes de gastar um workflow

Envia um PING/PONG mínimo. Sem `--provider`/`--model`, abre um assistente.

```bash
rb-harness provider test --provider deepseek --model deepseek-v4-flash \
  --credential ds_oficial --timeout 60
```

```bash
rb-harness provider test --json     # contrato rb-provider-test/v1
```

---

## 4. Validação de contratos

Comandos determinísticos: não iniciam provider, não gastam token e não editam
nada.

### 4.1 `contract validate` — validar um `PHASES.md`

```bash
rb-harness contract validate .rb/init/PHASES.md
rb-harness contract validate .rb/init/PHASES.md --json
```

### 4.2 `contract inspect` — estrutura completa do plano

```bash
rb-harness contract inspect .rb/init/PHASES.md --format json
rb-harness contract inspect .rb/init/PHASES.md --format tsv
```

### 4.3 `contract extract` — extrair uma fase ou uma task

É o mesmo extrato que o RB Ralph entrega ao executor.

```bash
rb-harness contract extract .rb/init/PHASES.md --phase P01
rb-harness contract extract .rb/init/PHASES.md --task T007
```

### 4.4 `contract tasks` — listar tasks

`--phase` é obrigatório.

```bash
rb-harness contract tasks .rb/init/PHASES.md --phase P01
rb-harness contract tasks .rb/init/PHASES.md --phase P02 --format json
```

### 4.5 `contract validations` — listar os comandos de validação declarados

Útil para conferir o que o Ralph vai executar antes de iniciá-lo.

`--phase` é obrigatório.

```bash
rb-harness contract validations .rb/init/PHASES.md --phase P01
rb-harness contract validations .rb/init/PHASES.md --phase P01 --format json
```

### 4.6 `operations validate` — validar um `OPERATIONS.json`

Verifica o contrato `rb-operational/v1`, incluindo o ciclo de vida dos
processos: uma asserção HTTP/TCP contra um endereço local precisa estar dentro
dos `checks` do step `process` que sobe o serviço, nunca como step irmão depois
dele.

```bash
rb-harness operations validate .rb/init/OPERATIONS.json
rb-harness operations validate .rb/init/OPERATIONS.json --json
```

### 4.7 `review validate-responsive` — validar um inventário responsivo

```bash
rb-harness review validate-responsive .rb/reviews/rev-001/RESPONSIVE_INVENTORY.json --json
```

---

## 5. Árvore de artefatos

### 5.1 `project init` — criar a árvore `.rb/`

```bash
rb-harness project init . --name "Meu Projeto" --id meu-projeto
```

### 5.2 `manifest sync` — recalcular o manifesto

Recalcula hashes, IDs, status e a projeção TSV a partir dos arquivos em disco.
Rode após editar um artefato à mão.

```bash
rb-harness manifest sync .
rb-harness manifest sync . --json
```

### 5.3 `tree validate` — validar a árvore inteira

```bash
rb-harness tree validate .
rb-harness tree validate . --artifacts-dir .spec --json
```

### 5.4 `tree resolve` — descobrir artefatos por tipo e status

```bash
# caminho do plano pronto (o que você passa ao Ralph)
rb-harness tree resolve . --kind execution-plan --status ready --format paths
```

```bash
rb-harness tree resolve . --kind specification --status ready --format tsv
```

### 5.5 `inspect` — coletar evidência limitada do repositório

Varre o projeto respeitando limites declarados e excluindo segredos.

```bash
rb-harness inspect . --output .rb/context/evidence.json
rb-harness inspect . --no-sync        # não atualiza o manifesto
```

---

## 6. Prontidão e acompanhamento

### 6.1 `artifacts verify` — provar que os artefatos servem ao Ralph

O gate mais importante antes de executar. Determinístico: nenhum provider é
iniciado, nenhum artefato é editado.

```bash
rb-harness artifacts verify --project .
```

```bash
# vinculando ao pedido original, para provar cobertura
rb-harness artifacts verify --project . --against docs/prd.md
```

Verifica: esquema do manifesto, hashes, contratos de execução e operacionais,
descoberta do plano pronto, caminhos de contexto para agente frio, integridade
das referências de task, cobertura de requisitos, portabilidade dos caminhos e
**decomposição das tasks**.

Saída: `Ralph READY` ou a lista de bloqueadores.

### 6.2 `artifacts inspect` — inspecionar a árvore compatível

```bash
rb-harness artifacts inspect --project . --json
```

### 6.3 `status` — panorama do projeto

Resume artefatos existentes, evidências do Ralph e execuções do Harness
retomáveis.

```bash
rb-harness status --project .
rb-harness status --project . --json
```

### 6.4 `resume` — retomar uma geração interrompida

Reaproveita os checkpoints já pagos: entrevista concluída, plano documental e
cada parte de documento já escrita não são recomprados.

```bash
rb-harness resume --project .                 # execução incompleta mais recente
rb-harness resume init-20260825213222-782a4b9e55-119163 --project .
```

---

## 7. Automação headless

Fronteiras versionadas para integrar o RB Harness em outro sistema, sem
terminal interativo.

### 7.1 `headless version` — identidade da fronteira

```bash
rb-harness headless version
```

### 7.2 `headless init` — geração terminal isolada

```bash
rb-harness headless init --output /tmp/saida-isolada
```

### 7.3 `headless interview` — entrevista durável

Máquina de estados que persiste apenas IDs e cursor públicos; a aplicação
hospedeira renderiza os eventos tipados.

```bash
rb-harness headless interview version
```

```bash
# validar uma mensagem antes de enviá-la
echo '{"contract":"rb-headless-interview/v1", ...}' | rb-harness headless interview validate
```

```bash
# processar uma mensagem interview_start ou answer
echo '{"type":"interview_start", ...}' \
  | rb-harness headless interview run --state /var/lib/rb/entrevistas
```

---

## 8. Opções globais

| Opção | Efeito |
| --- | --- |
| `-V`, `--version`, `--ver` | imprime a versão |
| `--login` | configura uma credencial de API direta |
| `--splash` | toca a splash da capivara e sai |
| `--no-splash` | pula a splash |
| `-h`, `--help` | ajuda do comando |

```bash
rb-harness --splash
rb-harness --no-splash status --project .
```

---

## 9. Opções compartilhadas pelos workflows

Valem para `init`, `ai-context`, `plan`, `evolve` e `review`.

| Opção | Padrão | Efeito |
| --- | --- | --- |
| `--prompt <texto>` | — | solicitação explícita |
| `--file <caminho>` | — | lê a solicitação completa de um arquivo |
| `--project <caminho>` | `.` | raiz do projeto |
| `--output <dir>` | `.rb` | diretório de artefatos, relativo ao projeto |
| `--provider <nome>` | `codex` | `codex`, `claude`, `opencode`, `custom`, `openai`, `anthropic`, `gemini`, `deepseek`, `minimax`, `openrouter` |
| `--model <id>` | — | ID exato do modelo |
| `--effort <nível>` | — | esforço de raciocínio; no DeepSeek: `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--credential <id>` | — | credencial salva, para provider de API direta |
| `--adapter <caminho>` | — | adapter headless próprio |
| `--answers <json>` | — | respostas indexadas por ID de pergunta |
| `--questions <modo>` | `one-by-one` | `one-by-one` ou `batch` (apresentação apenas) |
| `--non-interactive` | desligado | nunca espera resposta no terminal |
| `--timeout <s>` | `3600` | limite total do provider; `0` desliga |
| `--first-output-timeout <s>` | `300` | limite para a primeira saída; `0` desliga |
| `--dashboard` | desligado | painel ao vivo no terminal |

O argumento posicional aceita texto, `@arquivo` ou o caminho de um arquivo
existente — equivalente a `--prompt` e `--file`.

```bash
rb-harness plan @pedido.md --provider codex --model gpt-5.4-mini
```

---

## 10. Receitas completas

### Projeto novo, do PRD ao Ralph

```bash
# 1. testar a conexão antes de gastar um workflow
rb-harness provider test --provider codex --model gpt-5.4-mini

# 2. gerar a documentação e o plano
rb-harness init --file docs/prd.md \
  --provider codex --model gpt-5.4-mini --effort high --dashboard

# 3. provar que o pacote serve ao Ralph
rb-harness artifacts verify --project . --against docs/prd.md

# 4. conferir o que o Ralph vai executar em cada fase
rb-harness contract validations .rb/init/PHASES.md --phase P01

# 5. executar
rb-ralph --project . --plan "$(rb-harness tree resolve . --format paths)"
```

### Projeto existente, documentar e depois evoluir

```bash
# 1. reverter o código implementado em contexto AS IS
rb-harness ai-context --project . --provider claude --model opus --depth deep

# 2. planejar a mudança sobre esse contexto
rb-harness evolve --file mudanca.md --provider claude --model opus

# 3. verificar
rb-harness artifacts verify --project .
```

### Auditoria e remediação

```bash
# 1. auditar
rb-harness review --project . --depth deep --focus security data

# 2. ver os achados
rb-harness status --project .

# 3. planejar apenas o que você escolheu
rb-harness review --project . --findings SEC-003 SEC-007

# 4. verificar o plano de remediação
rb-harness artifacts verify --project .
```

### Recuperar uma geração interrompida

```bash
rb-harness status --project .        # lista execuções retomáveis
rb-harness resume --project .        # retoma a mais recente
```

---

## Notas de comportamento

**Entrevista adaptativa.** Um lote inicial de até 5 perguntas materiais e,
depois, quantas rodadas focadas de até 3 a convergência exigir. Ela termina
quando não resta ambiguidade material — não quando um número de rodadas expira.
Dois tetos de segurança mantêm a máquina finita (12 rodadas, 40 perguntas), e
atingir qualquer um deles é reportado como falha de convergência, nunca como
aceite silencioso. As perguntas saem no idioma da sua solicitação.

**`--questions` é apresentação.** `one-by-one` e `batch` mudam apenas como as
perguntas aparecem no terminal; nenhum dos dois custa uma chamada extra ao
provider.

**O provider é somente leitura.** Em todos os papéis documentais ele roda numa
projeção de evidências limitada, sem `.git`, sem credenciais e sem o estado de
controle do Harness.

**Publicação é atômica.** A árvore `.rb/` só é substituída depois que o pacote
completo passa em todos os validadores determinísticos. Uma geração que falha
nunca deixa artefatos parciais no lugar dos anteriores.

**Nada de código de aplicação.** O RB Harness escreve documentação sob `.rb/` e
nada mais. Implementar é papel do RB Ralph, a partir dos artefatos publicados.

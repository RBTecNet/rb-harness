# Correção do Harness: impedir planos Go não convergentes

- Data: 2026-08-26
- Estado: proposta de correção pronta para implementação
- Produto responsável: RB Harness
- Incidente de origem: `tui_admin_samba`, run `init-phases-266cf96f2a49`, fase P01
- Escopo desta entrega: geração, validação, reparo estrutural e verificação de artefatos do Harness

## Resultado esperado

O Harness não deve publicar um `rb-execution/v1` que exija simultaneamente uma dependência Go direta, execute `go mod tidy` e adie para uma fronteira futura o primeiro import que sustenta essa dependência.

Todo plano publicado deve possuir um estado final alcançável no qual os critérios de aceitação de uma tarefa ou fase continuem verdadeiros depois de todas as suas validações canônicas, sem exigir alteração fora do `Scope` autorizado.

## Evidência que fundamenta a correção

O plano gerado para `tui_admin_samba` declarou em T001:

- `Scope`: somente `go.mod` e `go.sum`;
- Bubble Tea e Lip Gloss como dependências diretas obrigatórias;
- `go mod tidy` e `go list ./...` como validações.

O primeiro limite planejado para implementar a TUI apareceu somente em T038/P08, com arquivos sob `internal/tui/`. Nas tentativas 2, 3 e 4, `go mod tidy` terminou com código zero, removeu as dependências não importadas e deixou AC-T001-02 falso. Os executores restauraram `go.mod` e `go.sum` depois do `tidy`, mas a validação canônica seguinte voltou a eliminar o estado declarado como concluído.

Na tentativa 5, T001 criou `internal/app/tui.go`, caminho fora de qualquer `Scope` declarado, e T005 acrescentou outro modelo em `internal/app/app.go`. Os imports tornaram o estado estável para `go mod tidy`, mas anteciparam a implementação da TUI e encerraram a fase por expansão indevida de escopo. A evidência de validação classificou `internal/app/tui.go` como caminho fora de todos os escopos, embora a fase tenha sido aceita posteriormente.

Esses fatos provam uma falha de coerência do plano, não uma falha de resolução de versões nem uma indisponibilidade permanente do toolchain. A ausência de Go explica apenas a primeira tentativa.

## Causa raiz no Harness

O contrato atual valida forma, identificadores, dependências, granularidade, escopos e propriedades conhecidas dos comandos de validação, mas não relaciona três estados que precisam coexistir:

1. o estado exigido pelo `Change` e pelos critérios de aceitação;
2. os caminhos que a tarefa pode alterar;
3. o estado produzido depois da sequência completa de validações.

No caso Go, `go mod tidy` é uma operação de poda. Uma dependência direta nova permanece no `go.mod` somente quando o grafo de pacotes ou ferramentas possui uso legítimo correspondente. Separar a declaração e o primeiro uso por fases torna a instalação antecipada não convergente.

A instrução documental também não exige que uma tarefa de dependência Go identifique os caminhos de módulo importados. Sem essa identidade estruturada, um verificador determinístico não consegue relacionar com segurança nomes de produto como “Bubble Tea” a imports como `github.com/charmbracelet/bubbletea`.

## Invariantes requeridos

### HGC-001 — Pós-validação simultânea

Todos os critérios de uma tarefa devem ser avaliáveis no estado posterior à última validação canônica. Não é válido executar uma validação destrutiva ou normalizadora e depois restaurar manualmente o estado exigido sem repetir a mesma validação.

### HGC-002 — Fechamento de escopo

Quando a correção previsível para um critério exige criar ou modificar um caminho, esse caminho deve pertencer ao `Scope` da tarefa responsável. Uma tarefa não pode depender de expansão silenciosa de escopo por outra chamada efêmera.

### HGC-003 — Dependência e primeiro uso convergem

Para uma dependência Go direta sujeita a `go mod tidy`, o plano deve provar uma destas condições:

- um import correspondente já existe no projeto no momento da geração; ou
- a tarefa que introduz o import precede a tarefa de resolução, e esta declara dependência explícita daquela; ou
- declaração, primeiro uso e validação pertencem à mesma tarefa e os arquivos Go correspondentes estão no seu `Scope`.

Um import planejado somente para fase posterior não satisfaz o invariante.

### HGC-004 — Identidade verificável

Uma tarefa que exige dependências Go diretas deve nomear os caminhos de módulo em backticks, por exemplo `github.com/charmbracelet/bubbletea`. Nomes comerciais ou descrições livres podem acompanhar o caminho, mas não substituí-lo como autoridade verificável.

### HGC-005 — Idempotência

Uma variante válida deve preservar `go.mod` e `go.sum` depois de duas execuções consecutivas de `go mod tidy`. Essa é uma prova de integração da regra, não uma autorização para o Harness executar toolchains arbitrários durante toda verificação documental.

## Desenho da correção

### 1. Corrigir a autoridade de autoria

Atualizar o digest code-owned usado pelos autores de `PHASES.md` com regras explícitas:

- não criar tarefas de “instalação antecipada” quando o gerenciador oficial remove dependências sem uso;
- colocar declaração e primeiro uso na mesma tarefa, ou ordenar primeiro uso antes da resolução por `Depends on`;
- avaliar critérios somente no estado posterior a todas as validações;
- nomear caminhos de módulo Go quando dependências diretas forem critérios observáveis;
- nunca satisfazer uma tarefa de metadados criando fonte fora do `Scope`.

A instrução deve usar o caso Go como exemplo de uma classe geral de validadores normalizadores, sem afirmar que o Harness consegue interpretar deterministicamente a semântica de todos os gerenciadores de dependência.

### 2. Adicionar um classificador determinístico de alta confiança

Adicionar uma análise de consistência do plano para reconhecer a combinação Go comprovada. O classificador deve operar somente quando houver sinais finitos suficientes:

- validação canônica `go mod tidy`;
- `go.mod` no `Scope` ou em resultado explicitamente exigido;
- critério de dependência direta com caminho de módulo Go identificável;
- ausência de import já existente e ausência de tarefa produtora ordenada que possua arquivo `.go` no `Scope` e cite o mesmo caminho de módulo.

Quando a combinação for comprovada, a publicação deve falhar com código estável, sugerido como `execution.go-tidy.nonconvergent-direct-requirement`. O diagnóstico deve informar:

- tarefa e critério conflitantes;
- caminho de módulo afetado;
- comando normalizador;
- primeiro uso encontrado em tarefa ou fase posterior, quando existir;
- correções aceitas: mover a declaração, antecipar um import legítimo ou ampliar explicitamente a tarefa responsável.

O classificador não deve adivinhar imports a partir de nomes comerciais, criar um catálogo crescente de bibliotecas nem bloquear um `go mod tidy` comum que apenas normaliza dependências já usadas.

### 3. Reutilizar a mesma regra em todas as portas

A análise deve possuir uma implementação code-owned compartilhada e ser consumida por:

- validação de staging durante `init`, `plan` e `evolve`;
- reparo estrutural antes da publicação;
- `contract validate` quando houver informação suficiente no documento;
- `artifacts verify`, com acesso ao projeto e ao bundle completo;
- fluxo headless antes de declarar uma árvore `ready`.

A verificação que precisa inspecionar imports existentes deve receber `projectRoot` pela camada de workspace/artefatos. A função pura do contrato pode validar apenas os sinais contidos em `PHASES.md`, como identidade dos módulos, ordenação e posse de escopo. Não se deve introduzir leitura implícita do filesystem dentro do parser puro de `rb-execution/v1`.

### 4. Integrar com o reparo estrutural

O finding deve autorizar reparo somente nos documentos afetados. O reparador pode:

- mover a declaração da dependência para a tarefa do primeiro uso;
- fundir declaração e primeiro uso quando continuarem pequenos e coesos;
- reordenar as tarefas e declarar `Depends on` quando o uso precisar preceder a resolução;
- corrigir os `Scope`, critérios, validações e evidências relacionados.

O reparador não pode inventar um arquivo de import sentinela, um blank import sem finalidade de produto ou uma fronteira arquitetural diferente apenas para conservar entradas no `go.mod`.

## Fronteiras de implementação no Harness

As fronteiras atuais a serem avaliadas durante a implementação são:

- `packages/core/src/harness-contract-digest.ts`: instruções normativas do autor;
- `packages/core/src/execution-contract.ts`: sinais e erros determinísticos contidos no plano;
- `packages/core/src/artifact-consistency.ts`: coerência que depende do bundle e do projeto existente;
- `packages/core/src/harness-workspace.ts`: gate de staging compartilhado;
- `packages/core/src/artifact-verifier.ts`: relatório público e bloqueio de prontidão;
- `packages/core/src/harness-generator.ts`: entrega do finding ao reparo estrutural;
- `packages/core/src/headless-runner.ts`: mesma garantia no fluxo headless;
- testes de contrato, verificador, geração/reparo, portabilidade entre stacks e pacote instalado.

Essa lista é um mapa de impacto, não uma obrigação de modificar todos os arquivos. A implementação deve manter uma única regra compartilhada e evitar regex duplicada entre staging, contrato e verificador.

## Critérios de aceitação

1. Um plano greenfield com `Scope: go.mod, go.sum`, dependências diretas identificadas, `go mod tidy` e primeiro import somente em fase posterior é rejeitado antes da publicação.
2. O erro identifica a tarefa, os módulos, o `tidy` e a ausência de produtor compatível no escopo/ordem atuais.
3. A correção localizada pode mover declaração e primeiro uso para a mesma tarefa ou ordenar uma tarefa de uso anterior, após o que o plano é aceito.
4. Um projeto existente cujo código já importa o módulo não sofre falso positivo ao executar `go mod tidy` numa tarefa limitada a `go.mod` e `go.sum`.
5. Um plano Go que usa `go mod tidy` sem exigir nova dependência direta continua válido.
6. A mesma árvore recebe o mesmo finding em staging, `artifacts verify` e fluxo headless.
7. O reparo estrutural não altera documentos alheios ao finding nem introduz imports artificiais.
8. A validação do pacote instalado preserva o comportamento, e `npm run check` termina com código zero.

## Testes de regressão

### Testes determinísticos, sem toolchain Go

- fixture inválida reproduzindo T001 e T038 com caminhos de módulo explícitos;
- fixture válida com declaração e import na mesma tarefa;
- fixture válida com import existente representado pelo inventário do projeto;
- fixture válida com tarefa de uso anterior e `Depends on` correto;
- fixture inválida com uso somente em fase posterior;
- fixture inválida com módulo citado, mas nenhum arquivo `.go` autorizado;
- caso negativo de `go mod tidy` sem novo requisito direto;
- prova de que nomes comerciais sem caminho de módulo geram diagnóstico de autoridade insuficiente, não uma inferência inventada;
- igualdade dos códigos e mensagens entre staging e `artifacts verify`;
- reparo estrutural limitado aos artefatos afetados.

Esses testes devem usar documentos e inventários estáticos. O gate normal do Harness não deve passar a exigir que Go esteja instalado para validar planos de qualquer stack.

### Teste de integração com Go disponível

Em uma matriz que disponibilize o toolchain Go:

1. materializar a variante válida em diretório temporário;
2. executar `go mod tidy`;
3. registrar os hashes de `go.mod` e `go.sum`;
4. executar `go mod tidy` novamente;
5. provar que os hashes permanecem idênticos;
6. garantir que nenhum binário ou artefato seja escrito na raiz da fixture.

Se o job não possuir Go, ele deve ser explicitamente omitido como matriz de integração, sem reduzir a cobertura determinística do classificador.

## Migração e compatibilidade

- Planos já publicados continuam imutáveis; não devem ser corrigidos in-place nem receber `manifest sync` como falso reparo.
- `artifacts verify` pode passar a rejeitar um plano legado que contenha a combinação comprovadamente não convergente. O diagnóstico deve recomendar nova geração/revisão.
- A exigência de caminho de módulo deve ser aplicada quando a tarefa criar ou exigir uma dependência Go direta. Planos que apenas mantêm um módulo existente não precisam ser reescritos.
- O novo finding é de prontidão do plano e deve ocorrer antes de qualquer chamada do Ralph.

## Fora de escopo

- modificar o projeto `tui_admin_samba` enquanto sua execução está ativa;
- corrigir reexecução de tarefas, enforcement de caminhos ou builds temporários no RB Ralph;
- fazer o Harness executar `go mod tidy` durante toda geração documental;
- interpretar comandos shell arbitrários ou semântica ilimitada de linguagens;
- criar imports artificiais apenas para enganar o gerenciador de módulos;
- reestruturar a arquitetura da TUI do projeto afetado.

## Critério de encerramento

A correção do Harness pode ser encerrada quando a fixture equivalente ao plano observado for bloqueada antes da publicação, as variantes legítimas permanecerem aceitas, staging e verificador produzirem o mesmo diagnóstico, o reparo gerar um plano convergente dentro do escopo e a prova de integração permanecer idêntica após duas execuções consecutivas de `go mod tidy`.

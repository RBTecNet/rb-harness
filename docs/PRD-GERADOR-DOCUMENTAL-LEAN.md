# PRD — RB Harness: gerador documental enxuto, econômico e compatível com RB Ralph

Status: pronto para implementação em um contexto novo  
Data: 2026-08-24  
Produto afetado: RB Harness  
Produto explicitamente fora da implementação: RB Ralph

## 1. Instrução para o próximo contexto

Implemente este PRD no repositório canônico:

`/home/bruno/Documentos/Projetos/IA/rb-harness/.release-work/rb-harness`

Use o código-fonte do DeepSeek Harness apenas como referência técnica de
eficiência:

`/home/bruno/Documentos/Projetos/IA/deepseek-harness`

Antes de editar, confirme o estado do Git, leia este documento completamente e
trace o fluxo atual nos arquivos indicados na seção 15. Não implemente nem
execute o RB Ralph. Não copie o loop geral de execução, a interface web, o
sistema de plugins, os subagentes ou os workflows de implementação do DeepSeek
Harness. O interesse está exclusivamente nos mecanismos que tornam a geração
de documentação rápida, econômica, cacheável, observável e convergente.

## 2. Resumo executivo

O RB Harness possui recursos suficientes, mas seu custo e tempo de geração não
são aceitáveis. No ensaio `cron2`, o mesmo prompt e o mesmo modelo
`opencode-go/deepseek-v4-pro` que produziram documentação útil pelo DeepSeek
Harness em aproximadamente 10 minutos e US$ 0,20 permaneceram mais de 31
minutos no RB Harness, passaram de US$ 1,84 e não publicaram os artefatos antes
do cancelamento.

O objetivo deste trabalho é substituir a orquestração burocrática por um núcleo
especializado em documentação:

1. inventário determinístico e limitado;
2. entrevista curta, gerada em lote e apresentada localmente uma pergunta por
   vez;
3. uma geração documental autoritativa;
4. materialização e validação determinísticas;
5. no máximo uma correção estrutural objetiva, sem auditor ou gerente LLM;
6. publicação atômica apenas de artefatos compatíveis com os contratos do RB
   Ralph.

O Harness continua sendo uma ferramenta de especificação. Ele não implementa o
projeto, não executa fases e não incorpora o loop de desenvolvimento do
DeepSeek Harness.

A refatoração é interna. A CLI pública existente deve permanecer intacta: os
mesmos comandos, flags, aliases, wizard, dashboard, login, catálogo/teste de
providers, seleção de modelo/effort, instalação standalone e códigos de saída
compatíveis continuam disponíveis. O splash centralizado e a capivara são parte
da identidade do produto e não podem ser removidos, substituídos ou degradados.

## 3. Problema observado

### 3.1 Sintomas

- O modelo recebe contexto e liberdade suficientes para investigar o próprio
  RB Harness, contratos compilados e testes, em vez de escrever os artefatos do
  projeto solicitado.
- As chamadas acumulam centenas de milhares de bytes de saída sem um indicador
  confiável de progresso documental.
- A entrevista pode reabrir decisões e possui teto de 128 rodadas, muito acima
  do que uma especificação produtiva deve necessitar.
- A validação semântica independente encontra novos conjuntos de problemas
  depois de uma reemissão completa, caracterizando não convergência.
- O cancelamento com `Ctrl+C` encerrou o processo principal, mas deixou o
  OpenCode trabalhando como processo órfão e consumindo recursos.
- O custo real do provider não é explicado pelo progresso mostrado no
  dashboard.
- O caminho feliz depende excessivamente da disciplina espontânea do modelo.

### 3.2 Evidências preservadas

- Execução cancelada do `cron2`:
  `/home/bruno/Documentos/Projetos/testes/cron2/.rb-harness/runs/init-20260824145217-597e83d5fe-69ba72/`
- Estado e logs do ensaio do Memory:
  `/home/bruno/Documentos/Projetos/IA/rb-harness/.release-work/rb-ia-memory/.rb-harness/`
- Relatório semântico que demonstrou novos achados após remediação:
  `/home/bruno/Documentos/Projetos/IA/rb-harness/.release-work/rb-ia-memory/.rb-harness/verifications/20260824145848-fc891ccc-a534/report.json`
- Comparação informada pelo operador para o mesmo prompt/modelo:
  DeepSeek Harness em cerca de 10 minutos e US$ 0,20; RB Harness cancelado após
  mais de 31 minutos e aproximadamente US$ 1,84.

Esses números são a linha de base do produto, não uma garantia permanente de
preço do provider.

## 4. Causa-raiz a ser tratada

O problema não é simplesmente “modelo ruim” nem “poucas chamadas”. O DeepSeek
Harness pode fazer muitas requisições e ainda assim ser mais barato porque
mantém um prefixo estável, aproveita cache, limita e estrutura ferramentas,
preserva histórico de forma append-only e faz cada etapa avançar o trabalho.

No RB Harness atual existem quatro multiplicadores combinados:

1. **Contexto pesado e disperso**: regras, contratos e formatos chegam como
   prosa extensa, levando o modelo a redescobrir detalhes já conhecidos pelo
   programa.
2. **Agente genérico onde bastaria um gerador especializado**: CLIs externas
   recebem ferramentas e autonomia para explorar muito além do necessário.
3. **Qualidade delegada novamente a outro modelo**: auditoria e remediação
   semânticas repetem leitura e escrita, mas não garantem monotonicidade.
4. **Controle operacional incompleto**: cancelamento, orçamento de passos,
   telemetria e definição de progresso não cobrem toda a árvore do provider.

## 5. Decisão de produto

O RB Harness terá um **núcleo de geração documental**, e não um loop geral de
agente.

O núcleo poderá usar chamadas com ferramentas para obter evidências em projetos
existentes, mas essas chamadas pertencem a uma máquina de estados documental,
possuem finalidade fechada e orçamento finito. Elas não podem implementar
código, executar o projeto, criar subagentes, iniciar workflows autônomos ou
explorar a instalação do próprio Harness.

O gerente LLM deixa de existir no Harness. A qualidade normal será dividida em:

- garantias estruturais e contratuais feitas por código;
- decisões de produto obtidas pela entrevista;
- uma única autoria semântica feita pelo gerador documental.

## 6. Objetivos

- Reduzir drasticamente tempo, tokens e custo de geração.
- Fazer o modelo trabalhar sobre a solicitação e o projeto-alvo, nunca sobre a
  implementação instalada do Harness.
- Gerar o menor conjunto suficiente de documentos.
- Preservar a entrevista interativa e a apresentação uma pergunta por vez.
- Manter providers CLI e APIs diretas já suportados.
- Produzir documentação agnóstica a modelo, arquitetura e stack.
- Publicar somente uma árvore estruturalmente válida e compatível com RB Ralph.
- Encerrar toda a árvore do provider em cancelamento, timeout ou falha.
- Tornar custo, chamadas, cache, ferramentas e progresso observáveis.

## 7. Não objetivos

- Alterar, otimizar, instalar ou executar o RB Ralph.
- Copiar o loop de implementação do DeepSeek Harness.
- Gerar código de aplicação.
- Copiar a arquitetura Cordis, a interface web ou o sistema de plugins do
  DeepSeek Harness.
- Adicionar gerente, crítico, banca, votação entre modelos ou múltiplos agentes.
- Criar novos tipos de workflow neste ciclo.
- Aumentar a quantidade de documentos como medida de qualidade.
- Manter remediação semântica iterativa para compatibilidade histórica.

## 8. Escopo funcional

### RF-001 — Inventário determinístico e limitado

Antes da primeira chamada ao modelo, o Harness deve construir um pacote de
entrada determinístico contendo somente:

- solicitação original e sua origem/hash;
- workflow selecionado;
- inventário relevante do projeto-alvo;
- artefatos RB existentes relevantes;
- decisões já aceitas;
- contrato compacto do conjunto de saídas exigido.

O inventário deve excluir pelo menos `.git`, dependências, builds, cobertura,
estado vivo do Harness, credenciais e artefatos temporários. O modelo não deve
receber caminhos para o source, `dist`, testes ou instalação global do próprio
RB Harness.

Para projetos grandes, o pacote deve usar limites explícitos e resumos
determinísticos. Conteúdo adicional só pode ser obtido por ferramentas de
leitura confinadas ao projeto-alvo.

### RF-002 — Contrato compacto e nativo

O modelo não deve precisar abrir o pacote do RB Harness para descobrir como
escrever um artefato. O orquestrador deve fornecer uma representação compacta,
versionada e suficiente dos formatos esperados.

Schemas, hashes, IDs derivados, manifesto e outras informações mecânicas devem
ser produzidos ou completados por código sempre que não exigirem julgamento
semântico. Não se deve gastar tokens pedindo ao modelo que calcule ou replique
informação determinística.

### RF-003 — Entrevista curta e local

A análise de lacunas deve gerar um lote pequeno de perguntas materiais. O modo
`one-by-one` controla somente a apresentação local; não deve reinvocar o modelo
para cada pergunta.

Regras:

- no máximo 5 perguntas na primeira rodada;
- no máximo 1 rodada de follow-up, com até 3 perguntas;
- fatos descobertos no projeto não viram perguntas;
- escolhas FLEXIBLE recebem uma suposição explícita e não bloqueiam;
- persistindo ambiguidade RIGID após o follow-up, o resultado é `BLOCKED` com a
  decisão faltante — não uma nova rodada;
- IDs e formatos de perguntas são normalizados pelo programa, evitando falha
  total por detalhe superficial da resposta do provider.

### RF-004 — Geração autoritativa única

Depois da entrevista, uma única sessão de autoria recebe o checkpoint fechado e
produz o pacote documental completo. Não existe gerente posterior.

O resultado preferencial é um envelope estruturado com pares `path/content`.
O orquestrador materializa os arquivos, cria metadados mecânicos e publica. Se
um provider CLI só puder escrever no workspace, ele deve permanecer confinado à
pasta de artefatos e ao mesmo orçamento documental.

O gerador deve criar apenas os documentos condicionais necessários. Ele não
deve preencher templates opcionais vazios nem repetir a mesma regra em vários
arquivos sem uma fonte canônica.

### RF-005 — Recuperação estrutural única e monotônica

Após a autoria, validadores determinísticos executam uma vez. Se houver somente
erros estruturais reparáveis, é permitida no máximo uma correção objetiva.

A correção recebe:

- o pacote já gerado;
- a lista completa e ordenada de erros mecânicos;
- somente os trechos afetados;
- a obrigação de preservar conteúdo semanticamente não relacionado.

Ela não pode reabrir entrevista, reexplorar o repositório ou reemitir toda a
documentação quando uma alteração localizada é suficiente. Uma segunda falha é
reportada ao operador; não há loop.

### RF-006 — Verificação sem gerente LLM

`rb-harness artifacts verify` deve ser determinístico por padrão e como caminho
oficial. Deve verificar hashes, manifesto, contratos, referências, cobertura de
requisitos, escopos e demais invariantes codificáveis.

O fluxo normal não deve iniciar auditoria semântica independente nem
remediação por um segundo papel. As opções legadas que dependem desse modelo
devem ser removidas ou descontinuadas com erro orientativo, sem manter um
caminho oculto capaz de recriar o custo antigo.

### RF-007 — Compatibilidade obrigatória com RB Ralph

O DeepSeek Harness é apenas referência de eficiência; seus formatos de saída
não são adotados como contrato do produto.

Quando o resultado estiver marcado como pronto para execução, ele deve conter:

- `PHASES.md` válido conforme `rb-execution/v1`;
- `OPERATIONS.json` válido conforme `rb-operational/v1` quando o workflow exigir
  aceitação operacional;
- manifesto `rb-manifest/v1` sincronizado e sem IDs duplicados;
- paths e referências portáveis a partir da pasta de artefatos;
- fases autocontidas para contexto frio;
- tasks com escopo concreto, dependências explícitas e comandos mínimos de
  validação;
- rastreabilidade entre solicitação, requisitos, plano, fases e tasks;
- nenhuma dependência em histórico de chat, instalação do Harness ou arquivos
  externos não declarados.

Os validadores do contrato são gates de publicação. Uma árvore incompatível
nunca pode ser anunciada como Ralph-ready.

Esta entrega não altera o RB Ralph. Ele aparece neste PRD somente como consumidor
do contrato de saída.

### RF-008 — Cancelamento de árvore confiável

Todo provider CLI deve iniciar em grupo de processo isolado. `SIGINT`, `SIGTERM`,
timeout, limite de saída, falha do Harness e encerramento do host devem iniciar
uma escada idempotente:

1. interromper admissão de novas ações;
2. enviar `SIGTERM` à árvore;
3. aguardar uma janela curta e limitada;
4. enviar `SIGKILL` aos sobreviventes;
5. confirmar que o grupo não possui processos vivos antes de liberar o lock.

No Windows, usar encerramento equivalente da árvore. O timer de escalada não
pode ser cancelado apenas porque o filho direto encerrou. O encerramento deve
ser testado com um neto que ignore `SIGTERM`.

### RF-009 — Progresso e telemetria úteis

O dashboard e o log devem distinguir:

- inventário;
- análise de lacunas;
- espera por resposta humana;
- descoberta de evidências;
- geração do pacote;
- materialização;
- validação;
- correção estrutural;
- publicação.

Para APIs diretas, registrar por execução: número de requisições, tokens de
entrada, entrada em cache, criação de cache, saída e total. Para CLI providers,
registrar o que o adapter disponibilizar e marcar o restante como não medido,
sem inventar custo.

Bytes repetidos sem avanço de estado não devem ser apresentados como progresso.
O relatório final deve informar duração por etapa e quantidade de chamadas ao
provider.

### RF-010 — Prefixo estável e aproveitamento de cache

Em APIs diretas, system prompt, contrato compacto e schemas de ferramentas
devem ser serializados de forma determinística e permanecer byte a byte
estáveis durante a sessão. Novas evidências e resultados entram de forma
append-only.

O catálogo de ferramentas não deve mudar entre passos. Restrições de modo são
regras de execução, não mutações oportunistas no schema enviado. A ordenação de
arquivos, propriedades e mensagens deve ser determinística.

### RF-011 — Ferramentas documentais mínimas

O gerador pode ter apenas as capacidades necessárias à documentação:

- listar arquivos relevantes;
- pesquisar texto;
- ler intervalos limitados;
- entregar o pacote de documentos ou escrever somente na pasta de staging.

Não deve ter shell genérico, execução de testes, subagentes, jobs, workflow,
Git destrutivo ou escrita de código de aplicação. Leituras independentes podem
ser executadas em paralelo pelo runtime, preservando a ordem determinística dos
resultados.

### RF-012 — Retomada sem repetição paga

Checkpoints devem separar entrevista concluída, resposta do provider recebida,
pacote materializado, validação e publicação. Ao retomar após falta de energia,
uma resposta completa já preservada não pode ser solicitada novamente.

Locks devem registrar identidade suficiente para diferenciar processo ativo de
resíduo. Resíduo sem processo vivo deve ser recuperado automaticamente e com
mensagem explícita.

## 9. Arquitetura-alvo

```text
solicitação
    |
    v
inventário determinístico e limitado
    |
    v
análise de lacunas (1 lote, no máximo 1 follow-up)
    |
    v
checkpoint fechado de decisões
    |
    v
gerador documental especializado
    |
    v
envelope path/content em staging
    |
    +--> metadados mecânicos + manifest sync
    |
    v
validação determinística completa
    |
    +--> verde ------------------------------> publicação atômica
    |
    +--> erro estrutural reparável
             |
             v
       uma correção localizada
             |
             v
       validação final ----> publicar ou falhar com relatório
```

Não há ramo de gerente, auditor semântico ou execução de aplicação.

## 10. O que aproveitar do DeepSeek Harness

### Adotar como princípio ou implementação equivalente

- Serialização determinística para maximizar cache de prefixo.
- Histórico append-only durante uma sessão de geração.
- Catálogo de ferramentas estável e pequeno.
- Execução paralela somente de leituras independentes.
- Limites de saída por ferramenta e descarte/resumo de resultados antigos.
- Detecção de chamadas repetidas sem progresso.
- Processo POSIX detached, sinalização por grupo, `SIGTERM` seguido de
  `SIGKILL`, observação da árvore e fallback síncrono no encerramento do host.
- Telemetria de tokens incluindo cache quando o provider informar usage.
- Persistência suficiente para retomar sem pagar novamente por trabalho
  concluído.

### Não adotar

- Cordis e sua topologia geral de plugins.
- Interface web do DeepSeek Harness.
- Loop aberto de agente de programação.
- Subagentes, workers de workflow, `parallel()`/`pipeline()` de implementação.
- Shell, sandbox e ferramentas gerais de desenvolvimento.
- Compaction como desculpa para permitir uma sessão documental ilimitada.
- Formato de documentação do DeepSeek no lugar dos contratos RB.

## 11. Orçamento operacional

O produto deve possuir limites internos explícitos, testáveis e conservadores.
Valores iniciais sugeridos:

- entrevista: 1 rodada inicial + no máximo 1 follow-up;
- correção estrutural: no máximo 1;
- saída acumulada de ferramentas: limitada e resumida;
- leitura de arquivo: intervalos limitados;
- acesso: somente projeto-alvo e staging;
- nenhuma etapa pode se auto-reiniciar silenciosamente;
- timeout continua configurável pela CLI, mas não substitui limites de estado.

O implementador deve definir os números restantes por benchmark, documentá-los
como constantes e cobri-los por testes. Aumentar um teto para fazer um fixture
passar não é solução sem evidência de progresso útil.

## 12. Critérios de aceitação

### CA-001 — Benchmark `cron2`

Com o mesmo prompt e `opencode-go/deepseek-v4-pro`, em ambiente e preço
comparáveis:

- publicar artefatos válidos em até 15 minutos como meta e 20 minutos como
  limite de aceitação;
- custo alvo de até US$ 0,30 e limite de aceitação de US$ 0,40;
- nunca exceder duas vezes a linha de base medida no DeepSeek Harness sem
  diagnóstico explícito;
- produzir plano Ralph-ready sem correção manual;
- não ler o source ou a instalação do RB Harness durante a geração.

Se o provider não expuser custo programaticamente, tokens, cache, chamadas e o
valor observado pelo operador devem compor o relatório do benchmark.

### CA-002 — Contratos RB

Todos os fixtures prontos devem passar, pelo código instalado da mesma versão:

```bash
rb-harness contract validate <PHASES.md>
rb-harness operations validate <OPERATIONS.json>
rb-harness manifest sync <project>
rb-harness tree validate <project>
rb-harness artifacts verify --project <project> --artifacts-dir <dir> --deterministic-only
```

`operations validate` é executado somente quando `OPERATIONS.json` for
aplicável. O `artifacts verify` oficial deve equivaler ao caminho determinístico
sem iniciar provider.

### CA-003 — Interrupção

Um teste de integração deve iniciar um provider fixture com filho e neto; o neto
ignora `SIGTERM`. Após `Ctrl+C` simulado, nenhum PID ou grupo permanece vivo e o
lock pode ser recuperado em seguida.

### CA-004 — Não convergência impossível

Nenhum workflow pode alternar indefinidamente entre gerar, auditar e remediar.
O grafo de estados é acíclico, exceto pelo único follow-up da entrevista e pela
única correção estrutural, ambos contados e limitados.

### CA-005 — Compatibilidade dos providers

Fixtures devem cobrir pelo menos:

- um provider CLI;
- uma API OpenAI-compatible direta, incluindo usage/cache;
- Anthropic Messages direta;
- cancelamento e timeout;
- resposta sem envelope, envelope truncado e erro HTTP.

### CA-006 — Retomada

Interrupções depois da entrevista, depois da resposta completa do gerador e
durante a publicação devem retomar do último checkpoint seguro sem nova chamada
para etapas concluídas.

### CA-007 — Regressão de UX

Continuam funcionando:

- executável standalone;
- splash/capivara centralizada;
- wizard;
- `--login`, `provider list` e `provider test`;
- provider, model e effort por execução;
- perguntas `one-by-one` e `batch`;
- `--output` customizado;
- dashboard;
- preservação da revisão anterior;
- documentação em inglês e português.

Também deve existir um teste de snapshot ou equivalente para o splash em
terminal com largura representativa, garantindo que a capivara continue
presente e centralizada. O caminho não interativo pode respeitar `--no-splash`
como hoje; isso não autoriza remover o recurso da CLI.

### CA-008 — Compatibilidade da CLI

A suíte deve comparar a ajuda e o parsing da versão anterior para todos os
comandos e flags públicos. Mudanças internas de arquitetura não podem exigir
que o usuário reaprenda os comandos ou altere scripts existentes. Uma opção só
pode ser retirada quando estiver ligada exclusivamente ao gerente semântico
removido; nesse caso, deve haver depreciação ou erro orientativo explícito, sem
silenciar ou reinterpretar o comando.

## 13. Plano de entrega recomendado

### Fase 1 — Medição e fixtures

- Congelar fixtures dos casos `cron2` e Memory sem segredos.
- Instrumentar contagem de chamadas, ferramentas, bytes, tokens e duração.
- Criar teste que reproduza o processo órfão.
- Registrar a linha de base atual antes da refatoração.

### Fase 2 — Processo e cancelamento

- Substituir o encerramento atual por ownership real da árvore.
- Cobrir `SIGINT`, `SIGTERM`, timeout, overflow, erro e host exit.
- Garantir limpeza/recuperação de lock somente após quiescência.

### Fase 3 — Pacote de entrada e contrato compacto

- Criar inventário determinístico limitado.
- Impedir acesso ao source/instalação do Harness.
- Separar metadados mecânicos de conteúdo semântico.
- Estabilizar serialização do prompt e ferramentas.

### Fase 4 — Entrevista finita

- Gerar perguntas em lote.
- Apresentar localmente uma por vez.
- Limitar a uma rodada inicial e um follow-up.
- Normalizar variações superficiais de protocolo sem reiniciar provider.

### Fase 5 — Gerador documental e publicação

- Introduzir envelope de documentos `path/content` ou equivalente tipado.
- Materializar arquivos por código.
- Sincronizar manifesto e validar contratos.
- Permitir somente uma correção estrutural localizada.
- Remover o gerente/auditor semântico do caminho do produto.

### Fase 6 — Benchmark e simplificação final

- Rodar o mesmo prompt/modelo nos dois harnesses.
- Comparar duração, chamadas, tokens, cache, custo e prontidão.
- Remover código morto de auditoria/remediação e documentação obsoleta.
- Atualizar `README.md`, `README.pt-BR.md`, versão, changelog se houver e pacote
  standalone.

As fases devem ser implementadas e verificadas no RB Harness. Não iniciar uma
execução do RB Ralph como continuação automática.

## 14. Estratégia de testes

- Unitários para ordenação/serialização estável e montagem do pacote de entrada.
- Unitários para orçamento de estados e proibição de transições extras.
- Unitários para normalização tolerante do envelope de entrevista.
- Unitários para materialização segura de `path/content`.
- Contratos para todos os formatos RB publicados.
- Integração com provider fake registrando cada request e garantindo prefixo
  estável.
- Integração de cancelamento com árvore resistente a `SIGTERM`.
- Integração de retomada sem reinvocação do provider.
- Snapshot dos prompts compactos com limite explícito de bytes.
- Benchmark manual reproduzível para `cron2`, com relatório versionado sem
  credenciais.

O comando completo do repositório deve permanecer verde:

```bash
npm run check
```

## 15. Pontos de partida no código

### RB Harness

- `packages/core/src/standalone-runner.ts`: máquina de estados, entrevista,
  geração, retomada e publicação.
- `packages/core/src/harness-interview.ts`: protocolo e prompts da entrevista.
- `packages/core/src/harness-provider.ts`: spawn, logs, timeout e cancelamento.
- `packages/core/src/api-agent.ts`: APIs diretas, histórico, tools e usage.
- `packages/core/src/api-agent-tools.ts`: superfície de ferramentas.
- `packages/core/src/harness-workspace.ts`: staging, validação e publicação.
- `packages/core/src/artifact-verifier.ts`: verificação e remediação atuais.
- `packages/core/src/harness-audit.ts`: gerente/auditor semântico a retirar do
  caminho oficial.
- `resources/references/`: regras compartilhadas atualmente injetadas.
- `resources/workflows/*/`: instruções e formatos por workflow.

### DeepSeek Harness — somente referência

- `packages/llm/llm-deepseek/src/serialize.ts`: serialização e cache.
- `packages/llm/llm-deepseek/src/adapter.ts`: request/usage do provider.
- `packages/core/agent-loop/README.md`: histórico append-only e chamadas de
  ferramentas; não copiar o loop geral.
- `packages/subprocess/subprocess-local/src/spawn.ts`: lifecycle da árvore de
  processos.
- `packages/subprocess/subprocess-local/src/index.ts`: disposição e host exit.
- `packages/guard/repeat-tool-reminder/README.md`: detecção de repetição sem
  progresso.
- `packages/compaction/compaction-tool-result-pruner/README.md`: contenção de
  resultados antigos.
- `packages/bundle/headless/src/startup.ts`: entrada headless pequena; não copiar
  os workflows de execução.

## 16. Riscos e mitigação

- **Documentação mais rápida porém rasa**: manter rastreabilidade e contratos
  como gates, além de fixtures de qualidade.
- **Limites rígidos bloquearem projeto realmente complexo**: falhar com
  checkpoint retomável e diagnóstico; não ampliar automaticamente.
- **Diferenças entre provider CLI e API direta**: compartilhar a máquina de
  estados e o contrato de saída, isolando apenas o adapter.
- **Quebra de compatibilidade com Ralph**: validar com os contratos publicados
  pela mesma versão antes de qualquer publicação.
- **Remoção do auditor reduzir confiança subjetiva**: substituir opiniões por
  invariantes determinísticos e benchmark de execução documental.
- **Copy-paste excessivo do DeepSeek**: revisão deve rejeitar dependências de
  Cordis, UI, subagentes ou execução de projeto.

## 17. Definição de pronto

Este PRD estará concluído quando:

1. o fluxo normal não contiver gerente ou auditor LLM;
2. a entrevista for finita e feita em lote pelo provider;
3. a autoria ocorrer uma vez, com no máximo uma correção estrutural localizada;
4. o modelo não precisar inspecionar a instalação do Harness;
5. cancelamento não deixar descendentes vivos;
6. o dashboard mostrar progresso documental e telemetria real;
7. o benchmark `cron2` satisfizer os limites de tempo/custo ou produzir uma
   explicação mensurada e acionável para qualquer desvio;
8. a documentação publicada passar nos contratos consumidos pelo RB Ralph;
9. `npm run check` estiver verde;
10. READMEs em inglês e português refletirem o novo funcionamento;
11. a CLI pública e a capivara permanecerem intactas;
12. nenhuma alteração tiver sido feita no RB Ralph.

## 18. Guardrail final

Se uma solução exigir reintroduzir gerente, auditor semântico iterativo,
subagente, loop geral de implementação ou execução do projeto para conseguir
gerar os documentos, ela contradiz este PRD. Pare, registre a evidência e
redesenhe o gerador documental em vez de aumentar a autonomia ou o orçamento.

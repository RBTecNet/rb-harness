# PRD — Correções de prontidão do RB Harness 0.4.0

## 1. Status e objetivo

**Status:** obrigatório antes de commit, publicação ou instalação da versão 0.4.0.

Este documento especifica as correções necessárias sobre a implementação atual do gerador documental lean. O objetivo não é criar outro produto, adicionar novas camadas de auditoria nem reintroduzir o gerente no Harness. O objetivo é tornar a implementação atual segura, limitada, mensurável e capaz de produzir artefatos RB Ralph-ready com custo e tempo previsíveis.

A implementação deve acontecer **sobre o working tree atual**, preservando todas as mudanças já realizadas. Não fazer reset, checkout destrutivo, descarte ou reimplementação integral.

## 2. Contexto e evidência

A arquitetura atual já avançou nos pontos centrais:

- o Harness possui apenas o gerador de especificação;
- o gerente permanece exclusivo do RB Ralph;
- a geração usa pacote de entrada compacto e bundle tipado;
- a entrevista está limitada a duas rodadas;
- existe no máximo um reparo estrutural;
- a CLI, o wizard, o dashboard, o splash e a capivara foram preservados;
- a suíte atual passa com 147 testes.

Entretanto, a revisão encontrou lacunas que impedem considerar a versão pronta:

1. descendentes do provider podem sobreviver quando o processo líder termina normalmente;
2. o benchmark principal ainda não foi executado nem produz evidência confiável de Ralph-readiness;
3. providers por CLI continuam opacos e podem consumir tempo/tokens sem um orçamento observável;
4. respostas semanticamente inválidas da entrevista podem ser aceitas ou descartadas silenciosamente;
5. o provider pode ler estado interno do próprio Harness e entrar em autorreferência;
6. limites de bytes declarados não são integralmente aplicados em runtime;
7. as afirmações sobre prefixos estáveis e cache são mais fortes que as garantias reais.

Referência histórica do mesmo prompt/modelo:

- DeepSeek Harness: aproximadamente 10 minutos e US$ 0,20, com documentação útil;
- RB Harness 0.3.14: mais de 31 minutos, cancelado, aproximadamente US$ 1,84 e sem artefatos utilizáveis.

O benchmark real usa recursos pagos e **não pode ser disparado automaticamente**. A implementação deve preparar e testar deterministicamente o mecanismo; a execução real depende de autorização explícita do operador.

## 3. Restrições inegociáveis

- Não modificar, instalar ou executar o RB Ralph.
- Não reintroduzir gerente, auditor semântico, debate entre agentes ou ciclos genéricos de revisão no Harness.
- Não aumentar o máximo de duas rodadas adaptativas de entrevista.
- Não aumentar o máximo de um reparo estrutural.
- Não executar provider real pago, benchmark pago ou chamada externa onerosa sem autorização explícita.
- Não quebrar compatibilidade com os providers Codex, Claude e OpenCode existentes.
- Não remover nem degradar CLI, wizard, dashboard, logs de progresso, splash, logotipo ou capivara.
- Não alterar a superfície pública da CLI sem necessidade comprovada. Mudanças incompatíveis exigem justificativa explícita.
- Não esconder falhas com fallback permissivo, truncamento silencioso ou estado READY falso.
- Não usar parsing de prosa humana para fingir telemetria estruturada.
- Não registrar prompts completos, respostas, respostas da entrevista, segredos ou credenciais em telemetria/benchmark.
- Não fazer commit ou push como parte desta tarefa, salvo autorização posterior explícita.

## 4. Requisitos funcionais

### CR-001 — Encerrar toda a árvore do provider em qualquer término

#### Problema

O fluxo atual só aguarda quiescência no `finally` quando o teardown já foi iniciado. Se o processo líder terminar com código zero e um descendente continuar vivo, o handle pode ser descartado e o descendente ficar órfão.

#### Requisito

1. Toda execução de provider deve terminar com quiescência comprovada da árvore de processos, inclusive quando o líder encerra normalmente.
2. Se existirem descendentes vivos depois do encerramento do líder, o Harness deve iniciar encerramento escalonado, aguardar a morte deles e somente então:
   - retornar o resultado do provider;
   - liberar lock;
   - zerar handles rastreados.
3. A identidade dos descendentes relevantes deve ser mantida durante a execução, e não descoberta apenas depois que o líder morreu.
4. A estratégia deve reduzir risco de atingir PID reutilizado e manter comportamento correto em Linux, macOS e Windows.
5. Os comportamentos existentes de timeout, SIGINT/SIGTERM e encerramento do host devem continuar funcionando.

#### Provas obrigatórias

- teste de integração em que o líder termina com sucesso depois de iniciar descendente ou neto destacado;
- variante em que o descendente ignora SIGTERM e exige escalonamento;
- `runProvider` não retorna enquanto existir sobrevivente pertencente à execução;
- após o retorno, nenhum processo permanece vivo, nenhum handle permanece rastreado e o mesmo lock pode ser adquirido novamente;
- testes existentes de timeout e interrupção continuam verdes.

Não corrigir este item apenas enfraquecendo a promessa da documentação.

### CR-002 — Tornar o benchmark confiável sem executá-lo automaticamente

#### Problema

Ainda não existe relatório da versão 0.4.0. O script pode selecionar um run antigo, não prova independentemente Ralph-readiness e pode terminar com sucesso mesmo quando a geração falha.

#### Requisito

1. Antes da execução, registrar os IDs de runs existentes. Depois dela, aceitar somente um run novo pertencente à invocação atual.
2. Se nenhum run novo for criado, registrar a falha sem reaproveitar resultado anterior.
3. O script deve sair com código diferente de zero quando:
   - a geração falhar;
   - o run não concluir;
   - a validação determinística falhar;
   - os limites máximos do benchmark forem excedidos.
4. O relatório deve ser produzido mesmo na falha, contendo motivo, duração, métricas disponíveis e evidência de validação.
5. A prontidão para o Ralph deve ser verificada por comando/contrato determinístico de artefatos, e não inferida apenas de `state.status === complete`.
6. Custos observados devem ser números finitos e não negativos. Métrica ausente deve ser declarada como indisponível, nunca convertida em zero aparente.
7. O relatório não deve conter credenciais, conteúdo integral de prompts, respostas ou dados sensíveis.
8. Testes do benchmark devem usar CLI/provider falsos e não fazer chamadas externas.

#### Critério do benchmark real

Depois de todas as correções e somente mediante autorização do operador, disponibilizar o comando exato para repetir o cenário `cron2` com o mesmo prompt e modelo. Não executá-lo nesta tarefa.

- meta: até 15 minutos e até US$ 0,30;
- limite de aceitação: até 20 minutos e até US$ 0,40;
- saída: conjunto de artefatos Ralph-ready, validado, sem correção manual.

O relatório real deve ser salvo em `docs/benchmarks/` e identificar versão, commit, provider, modelo, duração, custo informado e resultado da validação, sem segredos.

### CR-003 — Controlar providers CLI sem falsa equivalência com o runtime direto

#### Problema

O orçamento de tools atualmente limita o runtime de API embutido, mas não limita necessariamente os loops internos de Codex, Claude ou OpenCode. O caminho OpenCode é justamente o caminho do benchmark principal.

#### Requisito

1. Inspecionar localmente a ajuda e o protocolo realmente suportado por cada CLI. Não inventar flags.
2. Declarar capacidades por adapter, por exemplo:
   - eventos estruturados disponíveis ou não;
   - contagem confiável de turns/tools disponível ou não;
   - cancelamento cooperativo disponível ou não;
   - métricas de uso/custo disponíveis ou não.
3. Quando houver stream estruturado confiável, contar eventos significativos e aplicar orçamento documental de turns/tools.
4. Quando não houver telemetria confiável:
   - declarar a execução como não mensurada/não controlada nesse eixo;
   - aplicar limites conservadores de tempo total, primeira saída, inatividade, volume de saída e ausência de progresso;
   - nunca alegar que o provider respeitou o mesmo orçamento do runtime direto.
5. Detectar progresso semântico por eventos/estágios quando o protocolo permitir. Crescimento repetitivo de bytes não deve, sozinho, renovar indefinidamente a janela de progresso.
6. Para OpenCode, implementar o modo limitado mais confiável que a versão instalada realmente suporte, preservando o modelo `opencode-go/deepseek-v4-pro`.
7. Erros de protocolo, evento malformado ou ausência de capacidade obrigatória devem falhar de forma explícita e acionável.

#### Provas obrigatórias

Com fixtures locais, sem rede:

- stream estruturado normal produz envelope final;
- excesso de tools/turns encerra a execução;
- eventos repetidos sem progresso acionam o limite adequado;
- evento malformado falha de modo explícito;
- provider opaco é rotulado corretamente e obedece aos limites conservadores;
- Codex, Claude e OpenCode continuam selecionáveis pela CLI existente.

### CR-004 — Não aceitar ambiguidades nem esconder perguntas excedentes

#### Problema

Disposição ausente ou desconhecida pode virar `ACCEPTED`, e perguntas acima do orçamento podem ser simplesmente truncadas. Isso transforma incerteza em decisão confirmada.

#### Requisito

1. Normalização automática pode reparar apenas forma superficial:
   - ID inválido de pergunta;
   - tipo inferível de pergunta;
   - opções vazias que não alterem a semântica.
2. Disposição ausente, desconhecida ou escrita incorretamente é falha semântica. Nunca deve virar `ACCEPTED`.
3. `ACCEPTED` exige disposição explícita e uma decisão única normalizada.
4. O texto bruto só pode servir de fallback de decisão quando a disposição explícita for `ACCEPTED` e não houver contradição.
5. Quando ainda houver orçamento, resposta ambígua/parcial deve gerar follow-up focado ou uma única correção de protocolo já prevista pelo fluxo limitado.
6. Na rodada final, lacuna material não resolvida deve produzir `BLOCKED`, com razão objetiva.
7. Perguntas acima do limite não podem desaparecer:
   - o provider pode receber uma correção única para priorizar as perguntas materiais e registrar o restante em `unresolved`; ou
   - o Harness deve converter deterministicamente o excedente em pendências adiadas.
8. Existência de overflow material impede estado READY falso.

#### Provas obrigatórias

- disposição ausente;
- disposição desconhecida ou com erro de digitação;
- `ACCEPTED` explícito válido;
- mais perguntas que o limite;
- tentativa de READY contendo overflow escondido;
- pendência material na segunda rodada resulta em BLOCKED;
- o número máximo de rodadas continua igual a dois.

### CR-005 — Isolar o provider do estado interno do Harness

#### Problema

O pacote de entrada exclui `.rb-harness`, mas as ferramentas documentais podem listar, buscar ou ler esse diretório por caminho direto. Providers CLI também não possuem uma fronteira de leitura equivalente ao pacote de evidências.

#### Requisito

1. Centralizar uma política de caminhos permitidos/proibidos usada por listagem, leitura, busca e resolução de links.
2. As ferramentas diretas devem omitir ou rejeitar, inclusive por acesso direto:
   - `.rb-harness/**`;
   - `.git/**`;
   - `.rb/runs/**`;
   - credenciais, arquivos de segredo e caminhos externos ao projeto;
   - escapes por symlink ou travessia de diretório.
3. Providers CLI devem trabalhar sobre uma projeção de evidências somente leitura e limitada ao projeto, sem acesso ao estado vivo do Harness, diretório do run, instalação global ou recursos internos do pacote.
4. A projeção não pode voltar a copiar indiscriminadamente o projeto inteiro nem permitir escrita direta no projeto. Os artefatos continuam sendo entregues pelo bundle em stdout e aplicados transacionalmente pelo Harness.
5. Diretórios grandes, gerados ou irrelevantes continuam excluídos conforme o orçamento de inventário.
6. Se um provider precisar de evidência ausente, deve solicitá-la pelo protocolo permitido; não deve explorar o ambiente do Harness.

#### Provas obrigatórias

- `list_files .` não revela estado interno;
- leitura direta de `.rb-harness/...` é negada;
- busca textual não atravessa áreas proibidas;
- travessia `..` e escape por symlink são negados;
- fixture de provider CLI tenta ler estado de controle e não consegue;
- evidências legítimas do projeto continuam acessíveis.

### CR-006 — Aplicar todos os limites de bytes em runtime

#### Problema

Há limites declarados para pacote e prompts, mas eles não são garantidos em todos os caminhos. A redução do inventário pode ainda deixar o pacote acima do teto, e requests grandes não podem ser truncados silenciosamente.

#### Requisito

1. Todo limite declarado deve ser verificado antes de iniciar o provider.
2. `serializeInputPackage` deve retornar conteúdo dentro do teto ou lançar erro explícito com tamanho observado, limite e orientação segura.
3. `buildInterviewPrompt`, `buildGenerationPrompt` e `buildRepairPrompt` devem validar seus respectivos limites finais em bytes.
4. A solicitação do usuário é fonte de autoridade e não pode ser truncada silenciosamente.
5. Se a solicitação exceder o orçamento e não houver representação semanticamente equivalente, falhar cedo com mensagem acionável.
6. Decisões, evidências existentes e resumos também devem obedecer a limites definidos e previsíveis.
7. Nenhum processo de provider deve nascer se o preflight de tamanho falhar.

#### Provas obrigatórias

- conteúdo exatamente no limite;
- conteúdo um byte acima do limite;
- request muito grande;
- highlights/decisões/artefatos existentes muito grandes;
- confirmação de que o provider falso não foi iniciado em falha de preflight;
- mensagens não expõem conteúdo sensível.

### CR-007 — Tornar cache e prefixos estáveis verdadeiros e mensuráveis

#### Problema

Comentários e documentação afirmam estabilidade de prefixo/cache que não é garantida quando digest/rodada aparecem cedo no prompt ou quando geração e reparo usam subprocessos/sessões independentes.

#### Requisito

1. Onde o protocolo permitir, ordenar o prompt com prefixo invariável real: contrato, recursos e instruções estáveis antes dos dados voláteis de rodada/checkpoint.
2. Dados voláteis devem ficar depois do prefixo estável.
3. Não alegar reaproveitamento de cache entre processos, sessões ou prompts diferentes sem métrica fornecida pelo provider.
4. Telemetria deve registrar apenas cache observado/confiável; indisponibilidade deve permanecer indisponível.
5. Comentários, README e arquitetura devem refletir a garantia efetiva, sem promessa especulativa.

#### Provas obrigatórias

- snapshots ou testes de serialização demonstram o prefixo comum real entre rodadas equivalentes;
- alteração de resposta/rodada não muda a parte declarada invariável;
- métricas ausentes não são convertidas em cache hit;
- geração e reparo não alegam compartilhamento de cache quando o adapter não o comprova.

## 5. Fluxo esperado após as correções

1. CLI recebe projeto, workflow, request, provider, modelo e effort.
2. Preflight valida caminhos, recursos, limites e capacidades do adapter antes de iniciar o provider.
3. Harness monta pacote compacto sem estado interno, segredos ou diretórios gerados.
4. Entrevista ocorre somente se houver lacuna material, em no máximo duas rodadas.
5. Ambiguidade não vira aceite; lacuna material final vira BLOCKED.
6. Provider gera um bundle completo e tipado, sujeito aos limites do adapter.
7. Harness valida o bundle deterministicamente.
8. Se houver somente defeito estrutural reparável, ocorre no máximo um reparo.
9. Escrita em staging, validação e promoção continuam transacionais.
10. Toda a árvore do provider é encerrada antes de liberar lock ou concluir o run.
11. Telemetria informa apenas dados observáveis e diferencia provider controlado de provider opaco.

## 6. Validação e comandos obrigatórios

Executar, no mínimo:

```bash
npm run check
git diff --check
RB_HARNESS_SPLASH_MS=1 node packages/core/dist/cli.js --splash
node packages/core/dist/cli.js --help
node packages/core/dist/cli.js --ver
```

Também devem existir testes focados para CR-001 a CR-007. Todos os testes de provider e processo usam fixtures locais; nenhuma suíte deve depender de internet, autenticação ou cobrança.

O teste de splash é de preservação visual básica: a capivara e o wordmark devem continuar presentes e centralizados. Não redesenhar o splash.

## 7. Documentação obrigatória

Atualizar de forma coerente:

- `README.md`;
- `README.pt-BR.md`;
- documentação de arquitetura e continuidade afetada;
- documentação do benchmark;
- ajuda da CLI somente se o comportamento público realmente mudar.

A documentação deve distinguir claramente:

- limite aplicado pelo runtime direto;
- limite observado/aplicado por cada CLI externa;
- métrica disponível, indisponível ou não confiável;
- verificação determinística local;
- benchmark real pendente de autorização.

Não declarar que a versão venceu o baseline antes da execução real autorizada.

## 8. Definition of Done

A tarefa está concluída somente quando:

1. CR-001 a CR-007 estão implementados e cobertos por testes determinísticos;
2. `npm run check` passa integralmente;
3. `git diff --check` passa;
4. nenhum provider real pago foi chamado;
5. nenhuma mudança foi feita no RB Ralph;
6. CLI, wizard, dashboard, splash e capivara continuam funcionais;
7. o estado interno do Harness não aparece no pacote nem nas ferramentas do provider;
8. nenhuma ambiguidade semântica vira decisão aceita;
9. os limites declarados são aplicados antes e durante a execução;
10. processos descendentes não sobrevivem ao run;
11. o script de benchmark é testado com fixtures, falha corretamente e não reaproveita runs antigos;
12. é entregue ao operador o comando do benchmark real, mas ele não é executado;
13. o relatório final lista arquivos modificados, testes executados, evidências, limitações restantes e qualquer decisão ainda necessária;
14. não há commit nem push sem nova autorização explícita.

## 9. Instrução de execução para o agente

Leia este PRD integralmente e inspecione o working tree atual antes de editar. Trate as alterações existentes como trabalho válido a preservar. Primeiro reproduza cada falha com teste local; depois implemente a menor correção estrutural que satisfaça o requisito. Não use o projeto `cron2` como caso especial: todas as regras devem ser agnósticas a modelo, arquitetura e projeto.

Não reinicie a implementação do gerador, não restaure o gerente e não execute o Ralph. Não faça benchmark pago. Se uma capacidade de CLI externa não puder ser comprovada pela versão instalada e por saída estruturada, registre a limitação honestamente e aplique o fallback conservador especificado, em vez de simular controle inexistente.

Ao final, rode todas as validações da seção 6 e entregue um relatório objetivo. Pare antes de commit, push, instalação ou benchmark real.

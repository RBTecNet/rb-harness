# Achados do Review do RB Harness — 2026-08-26

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: findings-rb-harness-2026-08-26 -->

## RV-SEC-001 — Arquivos comuns de credencial são projetados e legíveis pelo provider

- **Área:** security
- **Severidade:** HIGH
- **Confiança:** CONFIRMED
- **Baseline:** new
- **Jornada afetada:** inventário/projeção de evidência → provider CLI ou API direta → leitura de código → geração documental
- **Evidência:** `packages/core/src/path-policy.ts:36-37` reconhece apenas uma lista estreita de nomes/extensões; `.npmrc`, `.netrc`, `.pypirc` e arquivos equivalentes não são negados. `packages/core/src/harness-evidence.ts:73-105` copia todo arquivo que `isVisibleProjectPath` admite. `packages/core/src/api-agent-tools.ts:358-367` entrega o conteúdo de qualquer arquivo admitido pela mesma política. `packages/core/src/harness-workspace.ts:178-198` verifica somente valores de variáveis de ambiente com nomes sensíveis, não segredos lidos de arquivos do projeto.
- **Reprodução/inspeção:** em diretório temporário, foi criado `.npmrc` contendo `RB_REVIEW_FILE_SENTINEL_12345`; uma chamada `read_file` com papel `harness-interview`/`protected` retornou a sentinela (`secretFileReadable: true`). A inspeção `rg -n 'SECRET_FILE|SENSITIVE_FILE|read_file|isVisibleProjectPath' packages/core/src/{path-policy.ts,api-agent-tools.ts,harness-evidence.ts}` mostra a mesma lacuna nos dois caminhos de provider.
- **Esperado:** arquivos de configuração conhecidos por carregar tokens/chaves não entram na projeção, não aparecem em list/search e não podem ser lidos por nome direto.
- **Atual:** esses arquivos são tratados como evidência regular e podem ser enviados ao provider remoto ou reaparecer em artefatos.
- **Impacto:** exposição de tokens de registry/package/cloud e quebra da promessa “secret-safe”; o vazamento pode ocorrer antes de qualquer validação de artefato.
- **Fronteira de tenant/segurança:** cruza a fronteira local → provider externo. Não há tenancy interna, mas a credencial pode pertencer a outra organização/registry diferente do projeto analisado.
- **Validação proposta:** fixtures hostis para `.npmrc`, `.netrc`, `.pypirc`, `.docker/config.json`, configs de cloud e nomes configuráveis; provar negação consistente em inventário, projeção, list, search e read, além de sentinela ausente do prompt, provider output, logs e artefatos.
- **Direção de remediação:** centralizar uma política de segredo extensível e conservadora usada por inventário, projeção e ferramentas; separar arquivos “não listar” de arquivos “nunca ler por nome”.
- **Dependências:** preservar arquivos `.example` explicitamente seguros e evitar bloquear manifests públicos necessários.

## RV-OPS-001 — Caminhos de subprocesso fora da contenção compartilhada não cumprem timeout/quiescência

- **Área:** operations
- **Severidade:** HIGH
- **Confiança:** CONFIRMED
- **Baseline:** new
- **Jornada afetada:** headless interview → adapter; Ralph provider direto → `run_command`
- **Evidência:** `packages/core/src/headless-interview-runner.ts:337-373` usa `spawn` diretamente, envia apenas `SIGTERM` e rejeita sem escalar para `SIGKILL` nem confirmar árvore quieta. `packages/core/src/api-agent-tools.ts:266-294` repete o padrão e resolve apenas no evento `close`. Em contraste, `packages/core/src/process-tree.ts` implementa a contenção estrutural e a escada de teardown já usada por `harness-provider.ts`.
- **Reprodução/inspeção:** (1) um comando Node que ignora `SIGTERM` e termina após 2,5 s, invocado com `timeout_seconds: 1`, retornou normalmente após 2.534 ms (`[exit=0]`); (2) um adapter headless que ignora `SIGTERM`, grava `late-write.txt` aos 2 s e sai aos 2,5 s produziu `adapter_timeout`, mas o CLI levou 2.632 ms e a gravação pós-deadline ocorreu. Tudo foi executado em diretórios temporários.
- **Esperado:** ao atingir o deadline, nenhuma atividade do subprocesso continua; a árvore é encerrada com escalonamento e a quiescência é comprovada antes de devolver controle/liberar lock.
- **Atual:** `SIGTERM` é apenas solicitado. Um processo resistente ultrapassa o timeout, pode continuar escrevendo e pode manter o processo chamador vivo indefinidamente.
- **Impacto:** automações headless podem travar, locks podem ser liberados enquanto atividade hostil continua, e comandos podem alterar o workspace depois do deadline declarado.
- **Fronteira de tenant/segurança:** adapter/processo filho é uma fronteira não confiável. Em hosts multi-job, um processo sobrevivente pode consumir recursos ou interferir em trabalho posterior do mesmo usuário.
- **Validação proposta:** reutilizar a fixture resistente já existente em testes de `process-tree`; exigir `SIGTERM` → espera limitada → `SIGKILL`, árvore vazia e ausência de gravações após retorno para headless interview e `run_command` em Linux/macOS/Windows conforme suporte declarado.
- **Direção de remediação:** substituir helpers `spawn` ad hoc pelo mecanismo único `spawnProcessTree`, com resultado de settlement obrigatório.
- **Dependências:** respeitar o contrato headless-init, que delega timeout ao host, sem ampliar silenciosamente sua semântica.

## RV-DATA-001 — Gravações concorrentes do cofre retornam sucesso enquanto descartam credenciais

- **Área:** data
- **Severidade:** MEDIUM
- **Confiança:** CONFIRMED
- **Baseline:** new
- **Jornada afetada:** login/auth → `saveCredential` → cofre compartilhado Harness/Ralph
- **Evidência:** `packages/core/src/credential-store.ts:130-162` executa read-modify-write sem lock ou compare-and-swap; `saveDocument` substitui o documento completo. A inicialização de `vaultKey` em `packages/core/src/credential-store.ts:89-102` também permite criadores concorrentes.
- **Reprodução/inspeção:** 12 chamadas concorrentes de `saveCredential` com rótulos e sentinelas distintas, usando um `RB_CREDENTIAL_HOME` temporário, tiveram status fulfilled; `listCredentials('openai')` reteve apenas 1 registro. Resultado observado: `saveCallsFulfilled: 12`, `recordsRetained: 1`.
- **Esperado:** todas as gravações bem-sucedidas permanecem ou uma operação concorrente falha explicitamente e pode ser repetida.
- **Atual:** operações reportam sucesso e onze registros desaparecem por last-writer-wins.
- **Impacto:** perda silenciosa de credenciais/metadados e possibilidade de inconsistência entre ciphertext e chave durante primeira inicialização concorrente.
- **Fronteira de tenant/segurança:** o cofre é por usuário do SO e compartilhado entre executáveis RB; processos legítimos do mesmo usuário competem pelo mesmo arquivo.
- **Validação proposta:** teste multiprocessos com barreira antes da gravação, criação concorrente inicial da chave, atualizações de providers/rótulos diferentes e recuperação após processo interrompido; nenhuma gravação acknowledged pode desaparecer.
- **Direção de remediação:** lock por cofre ou transação com versão/CAS; criação exclusiva e idempotente da chave; fsync/rename conforme durabilidade suportada.
- **Dependências:** compatibilidade do contrato `rb-provider-credentials/v1` e permissões `0700`/`0600`.

## RV-TEST-001 — O gate oficial não impõe cobertura e deixa autenticação sem execução de linhas

- **Área:** tests
- **Severidade:** LOW
- **Confiança:** CONFIRMED
- **Baseline:** new
- **Jornada afetada:** mudança → gate `npm run check` → pacote/release
- **Evidência:** `package.json` define `check` sem `test:coverage`; `packages/core/package.json` executa `vitest run --coverage` sem configuração de thresholds. O relatório atual mostrou 72,46% statements/64,75% branches/76,52% functions/78% lines; `auth-cli.ts` ficou em 0% e `cli-program.ts` em 18,27% de linhas.
- **Reprodução/inspeção:** executar `npm run check` e `npm run test:coverage`; ambos retornam zero mesmo sem threshold e com o fluxo OAuth/login interativo não coberto.
- **Esperado:** regressões nas fronteiras de autenticação/CLI reduzem cobertura crítica ou falham testes comportamentais dedicados antes do release.
- **Atual:** a cobertura é apenas informativa e o fluxo que contém callback OAuth, entrada secreta, seleção de protocolo e integração `gcloud` não é exercitado por linhas.
- **Impacto:** defeitos de segurança/portabilidade podem atravessar o gate apesar de uma suíte numerosa.
- **Fronteira de tenant/segurança:** autenticação e cofre processam credenciais do usuário; o risco é de regressão não detectada, não de vazamento já observado nesse achado.
- **Validação proposta:** testes hostis do callback/timeout/erro, entrada oculta e comandos externos; thresholds globais graduais mais mínimos por módulos críticos ou gates comportamentais equivalentes.
- **Direção de remediação:** incluir cobertura no CI/release e priorizar testes negativos em `auth-cli.ts`, `cli-program.ts`, `credential-store.ts` e helpers de subprocesso.
- **Dependências:** evitar threshold cego que incentive testes tautológicos; preservar os atuais testes de integração e pacote real.

# Review do RB Harness — 2026-08-26

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: review-rb-harness-2026-08-26 -->

## Escopo e alvo

- **Review ID:** `rb-harness-2026-08-26`
- **Revisão:** `94411d1a64e64db5542bf63eba1c6f0509aa0e21`
- **Branch observada:** `release/0.5.8`
- **Versão declarada:** `0.5.16`
- **Profundidade:** `balanced`
- **Focos:** produto, segurança, dados, operações, supply chain, contratos e testes
- **Estado da árvore no início:** havia o arquivo não rastreado `ajuste_harness.md`; ele pertence ao desenvolvedor, não foi lido e não foi usado como prova. A árvore `.rb/` foi criada pelo próprio review.
- **Forma do produto:** CLI/biblioteca/plugin Node.js; não há frontend web, tela nativa ou outra superfície visual first-party. A evidência responsiva é, portanto, não aplicável.

## Resultado executivo

O harness apresenta uma base de engenharia forte: o gate oficial completo passou, o pacote real foi empacotado e exercitado por seu `bin`, 375 testes passaram, os contratos e adapters estão coerentes, e `npm audit` não encontrou vulnerabilidades conhecidas nas 96 dependências contabilizadas.

Isso não elimina quatro lacunas confirmadas nas fronteiras negativas:

| Severidade | CONFIRMED | LIKELY | UNKNOWN | FALSE_POSITIVE_RISK |
|---|---:|---:|---:|---:|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 2 | 0 | 0 | 0 |
| MEDIUM | 1 | 0 | 0 | 0 |
| LOW | 1 | 0 | 0 | 0 |

Os dois achados altos afetam promessas centrais do produto: a fronteira “secret-safe” não cobre arquivos comuns de autenticação, e caminhos que criam subprocessos fora de `spawnProcessTree` não cumprem o timeout nem a quiescência anunciados. O cofre compartilhado também perde atualizações concorrentes sem reportar falha. A suíte é ampla, mas o gate de release não impõe cobertura e deixa o fluxo interativo de autenticação sem execução de linhas.

## Mapa de cobertura

| Superfície/jornada | Evidência estática | Evidência de runtime | Disposição |
|---|---|---|---|
| Comandos públicos, wizard e compatibilidade de CLI | `cli-program.ts`, fixture de superfície, documentação | `npm run check` e pacote instalado | Coberta |
| Workflow standalone: inventário → entrevista → geração → validação → publicação | runner, generator, workspace, contracts, manifest | testes de integração incluídos no gate | Coberta |
| Providers CLI e APIs diretas | registry, provider runtime, streaming, ferramentas locais | servidores/fixtures locais; nenhuma API paga | Coberta parcialmente; conectividade real não exercitada |
| Confinamento de evidência e leitura documental | `path-policy.ts`, `harness-evidence.ts`, `api-agent-tools.ts` | reprodução com `.npmrc` e sentinela artificial | Defeito confirmado |
| Headless interview e timeout de adapter | contrato e `headless-interview-runner.ts` | adapter local hostil com timeout de 1 s | Defeito confirmado |
| Execução Ralph via provider direto | catálogo e executor de ferramentas | reprodução local de timeout e ambiente usando sentinelas | Timeout confirmado; herança de ambiente tratada como risco explícito de `yolo`, não como achado independente |
| Cofre compartilhado | `credential-store.ts`, auth/provider CLI | 12 gravações concorrentes artificiais | Defeito confirmado |
| Contratos execution/operations/manifest/responsive/headless | validadores e fixtures positivas/negativas | 375 testes; check de plugin e Bash | Coberta |
| Supply chain e pacote distribuído | manifests/lockfile/scripts de pacote | `npm audit --json`, `check:package` | Coberta no snapshot atual |
| UI, design system, acessibilidade e responsividade | inventário de 232 caminhos rastreados e 52 fontes TypeScript | não aplicável | Fora do produto observado |

## Metodologia

1. O comando `inspect` do skill coletou inventário limitado e secret-safe em `.rb/context/evidence.json`.
2. Foram lidos código, testes, contratos, manifests, documentação e scripts de release; diretórios de dependência/build, segredos, Git internals, documentos de intenção e achados antigos não foram usados como prova.
3. As jornadas críticas foram rastreadas entre CLI, provider, ferramentas locais, filesystem, contratos, cofre, subprocessos e publicação.
4. As hipóteses de falha foram testadas apenas com diretórios temporários, providers locais e sentinelas artificiais.
5. Os achados foram deduplicados por causa raiz e classificados somente depois de reprodução ou semântica estática direta.

## Comandos revisados

| Comando | Resultado |
|---|---|
| `node <plugin-root>/scripts/rb-harness.cjs --no-splash inspect .` | passou; evidência escrita |
| `npm run check` | passou: build, typecheck, pacote, 27 arquivos de teste/375 testes, Bash e plugin |
| `npm run test:coverage` | passou; 72,46% statements, 64,75% branches, 76,52% functions, 78% lines |
| `npm audit --json` | passou; 0 vulnerabilidades em 96 dependências contabilizadas |
| `git ls-tree -r --name-only HEAD` e buscas `rg` dirigidas a processos, caminhos, segredos e testes | usadas para inventário e rastreamento estático |
| bundles temporários via `esbuild` + scripts Node com sentinelas | reproduziram `RV-SEC-001`, `RV-OPS-001` e `RV-DATA-001` |
| `manifest sync` e `tree validate` pelo harness do skill e pelo CLI 0.5.16 em review | árvore de artefatos válida; 6 artefatos indexados |

## Limitações

- Não foram usados credenciais reais, providers pagos, browser OAuth real, Windows/macOS, falhas reais de energia ou integração com RB Ralph externo.
- O review não executou mutação testing, fuzzing prolongado nem teste de concorrência multiprocessos em produção; a perda concorrente foi reproduzida no mesmo processo contra o mesmo armazenamento em disco.
- Não há baseline anterior. Todos os achados têm disposição `new`.
- O `npm audit` representa apenas o snapshot e a base de advisories disponíveis em 2026-08-26.
- O review não leu `ajuste_harness.md`, documentos RB de intenção nem achados gerados anteriormente.

## Prontidão para remediação

O audit está congelado e os quatro IDs estão prontos para seleção explícita. Nenhum plano de remediação foi solicitado, portanto não foram emitidos `SELECTION.md`, `PLAN.md`, `PHASES.md` ou `OPERATIONS.json`.

# Impacto — integridade sistêmica dos artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: impact-artifact-generation-integrity -->

## Mapa de readers, writers e reactors

| Superfície | Papel atual | Mudança |
|---|---|---|
| `harness-generator.ts` e plano incremental | writer de documentos isolados | passa a respeitar um grafo de dependências e fornecer projeções finalizadas aos dependentes |
| `execution-contract.ts` | reader/validator de `PHASES.md` | rejeita autoridade de escrita sobre `.rb/**` com código estável |
| validação de staging | reactor antes da publicação | agrega coerência cruzada ao lado de contrato, hash e decomposição |
| `artifact-verifier.ts` | reader externo e gate de prontidão | reporta authority/cross-artifact blockers sem provider |
| `standalone-runner.ts`/workspace | writer/publisher | só fecha `complete` depois de validar o destino e restaura a revisão anterior em falha |
| templates/digest/workflows | autoridade passada ao modelo | removem a ambiguidade “fase normal cria OPERATIONS” e definem leitura versus escrita |
| `api-agent-tools.ts` | enforcement do executor direto | preserva a negação existente; ganha testes de equivalência com o contrato |
| RB Ralph | consumidor indireto externo | deve aplicar fingerprint imutável em execução sequencial, paralela e legacy |
| pacote/plugin gerado | distribuição | recebe recursos e contrato sincronizados pelo build/check existente |

## Dados e contratos

- `rb-execution/v1`: não muda a gramática, mas sua validação semântica fica mais estrita. Planos que já violavam a intenção read-only deixam de validar.
- Plano incremental interno: necessita dependências documentais versionadas ou projeção code-owned equivalente. Checkpoints da versão anterior não devem ser reinterpretados silenciosamente; ver `MIGRATION.md`.
- `rb-operational/v1`: a forma pública permanece compatível. A coerência do seu uso dentro de um bundle passa a ser comprovada no nível da árvore.
- `rb-manifest/v1`: hashes e indexação permanecem inalterados. `artifact.stale` continua blocker.
- Relatório `rb-harness-artifact-verification/v1`: acrescenta nomes de checks/findings, preservando campos e exit codes existentes.

## Impacto operacional

- Gerações contraditórias podem consumir a única correção estrutural antes de publicar; isso é custo esperado e limitado.
- Trees legacy anteriormente aceitas podem falhar mais cedo. O operador recebe regeneração como ação, não resync.
- Uma falha pós-rename deixa evidência em `.rb-harness/runs` e restaura o snapshot anterior quando disponível.
- Release coordenada com RB Ralph é necessária para defesa em profundidade contra providers externos que ignoram prompts.

## Segurança, tenancy e concorrência

- Não há tenant ou dado de usuário novo.
- A fronteira de segurança melhora: especificações e contratos deixam de ser alteráveis por executores de código.
- Corridas entre publicação e validação final devem ser cobertas por teste com mutação controlada; a validação deve operar no caminho publicado e o rollback deve ser atômico dentro do mesmo filesystem.
- `.rb/runs/**` permanece mutável somente pelo orquestrador de execução e excluído do manifesto portátil.

## Fonte e frescor

- Revisão observada: `94411d1a64e64db5542bf63eba1c6f0509aa0e21`.
- Testes focados executados em 2026-08-26: 3 arquivos, 49 testes, todos verdes, apesar de o plano reproduzido ser aceito.
- Evidência externa fornecida: geração `init-20260826043003-b7de0b1f30-b628cc` e execução `atravessar-a-rua-6a4191efd7d0`.
- O repositório RB Ralph foi consultado somente para impacto: a proteção de patch existe no caminho isolado paralelo, enquanto o caminho sequencial protege `.rb/runs` mas não todo o diretório de artefatos.

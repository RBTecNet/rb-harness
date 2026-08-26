# TO BE — protocolo de integridade dos artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: to-be-artifact-generation-integrity -->

## Modelo de autoridade

| Estado | Escritor autorizado | Garantia |
|---|---|---|
| Autoria/staging | Harness generation e a única correção estrutural | documentos podem mudar; nenhum byte foi publicado |
| Validado | orquestrador, apenas para manifesto/projeção derivados | contratos individuais e vínculos cruzados estão verdes |
| Publicado | nenhum executor | `.rb/**`, exceto `.rb/runs/**` do próprio orquestrador de execução, é entrada imutável |
| Nova revisão | novo run do Harness | toda alteração legítima recebe novos hashes e nova verificação |

## Requisitos RIGID

### RF-001 — Escopo de implementação não possui artefatos

`rb-execution/v1` deve rejeitar um task `Scope` que contenha `.rb`, `.rb/` ou qualquer descendente `.rb/**`, inclusive diretórios e globs. O código de erro deve ser estável e identificar task e token. A regra vale para init, plan, evolve, planos importados e verificação de árvores existentes.

### RF-002 — Leitura e validação continuam permitidas

O mesmo plano pode citar `.rb/**` no `Context`, em um comando read-only como `rb-harness operations validate .rb/.../OPERATIONS.json` e em `Expected evidence`. O gate não deve procurar `.rb` indiscriminadamente no documento; ele deve classificar os tokens do campo `Scope`.

### RF-003 — Operações são finalizadas antes da publicação

Quando `OPERATIONS.json` for emitido, sua criação e correção pertencem ao workflow de geração. Nenhuma task de implementação pode criá-lo, editá-lo ou depender de uma task que o crie. Uma fase pode validar o contrato existente, mas essa validação não concede escrita.

### RF-004 — Dependências documentais são explícitas

O plano incremental deve representar e validar dependências entre documentos. `OPERATIONS.json` deve ser autorado depois de `PHASES.md` e receber uma projeção determinística e limitada das saídas, escopos e entrypoints finais do plano. Um documento não pode depender de um caminho ausente ou de um documento ainda não finalizado.

### RF-005 — Coerência cruzada bloqueia publicação

A validação de staging e `artifacts verify` devem usar o mesmo check de coerência. Pelo menos estas contradições geram blocker antes de Ralph: task escritora de `.rb/**`; referência operacional tipada a caminho futuro sem autoridade no plano nem proveniência explícita; dependência documental inexistente/cíclica; `OPERATIONS.json` declarado para ser criado depois da publicação. O finding deve nomear os dois artefatos conflitantes e a correção exigida.

### RF-006 — Publicação fecha com prova do destino

Depois da renomeação atômica, o Harness deve executar validação read-only no diretório publicado antes de marcar o run como `complete`. Se falhar, deve marcar `generation-failed`, restaurar a revisão anterior quando houver uma, preservar o diagnóstico e nunca executar `manifest sync` no conteúdo divergente.

### RF-007 — Verificação permanece determinística

Todos os checks novos devem operar sem provider e aparecer na lista pública de `artifacts verify`. A mesma árvore deve produzir os mesmos códigos, severidades e relações de evidência.

### RF-008 — Compatibilidade provider-neutral

O contrato de integração deve declarar que todo consumidor de `rb-execution/v1` trata o diretório publicado como somente leitura. A ferramenta direta continua negando a escrita. O RB Ralph deve, em sua própria entrega coordenada, comparar o fingerprint dos artefatos antes e depois de cada task/phase em todos os modos, rejeitando a tentativa imediatamente; a proteção não pode existir somente no caminho paralelo/worktree.

### RF-009 — Migração não abençoa mutação

Para uma árvore legacy com task escritora de `.rb/**` ou hash stale, o diagnóstico deve recomendar regenerar o workflow e rever o delta. `manifest sync` não é reparo aceito, pois converteria a mutação não autorizada em nova autoridade sem reautoria.

### RF-010 — Regressão independe do projeto exemplo

O gate de release deve cobrir uma matriz genérica de init, plan e evolve; produtos CLI/arquivo estático/serviço ou biblioteca; provider fixture; caminhos existentes, futuros e produzidos durante um cenário. Nenhum teste pode depender de nomes, textos ou regras do jogo `Atravessar_a_rua`.

## Escolhas FLEXIBLE

- O formato interno da projeção entre `PHASES.md` e `OPERATIONS.json` pode ser um campo versionado no plano incremental ou uma estrutura code-owned, desde que seja determinístico, limitado por orçamento e validado topologicamente.
- O check cruzado pode viver num módulo novo ou num módulo de contrato existente, desde que staging, CLI e pacote instalado consumam exatamente a mesma implementação.
- O rollback pode reutilizar a revisão preservada pela publicação ou uma primitiva equivalente, sem apagar evidência do run falho.

## Critérios de aceitação

- Um plano com task escritora de `.rb/init/OPERATIONS.json` falha `contract validate` e `artifacts verify` antes de qualquer provider de execução.
- Um plano que apenas lê/valida `.rb/init/OPERATIONS.json` continua válido.
- Um bundle onde `OPERATIONS.json` aponta para `src/game.js` e `PHASES.md` só autoriza `game.js` não é publicável; o diagnóstico não menciona domínio de jogo.
- Uma correção localizada que alinha os documentos é revalidada por inteiro e pode ser publicada.
- Uma mutação simulada entre staging e fechamento da publicação restaura a revisão anterior e não deixa run `complete`.
- O pacote empacotado gera e verifica fixtures de mais de um workflow sem scope `.rb/**`.

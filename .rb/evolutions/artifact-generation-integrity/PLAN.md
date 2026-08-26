# Plano técnico — integridade sistêmica dos artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: plan-artifact-generation-integrity -->

## Estratégia

A correção usa defesa em camadas, com uma fonte mecânica compartilhada:

1. impedir que o contrato de execução conceda escrita sobre o plano de controle;
2. validar relações entre documentos, não apenas formatos isolados;
3. autorar dependentes a partir de projeções já finalizadas;
4. provar os bytes no destino antes de declarar publicação completa;
5. alinhar templates, pacote e consumidores externos ao mesmo modelo.

## Decisões arquiteturais

- Criar uma primitiva pura de autoridade/coerência reutilizável por staging e artifact verifier; não duplicar regex ou critérios entre os dois comandos.
- Interpretar `.rb/**` como namespace lógico de artefatos mesmo quando `--output` aponta para outro diretório físico.
- Representar dependências documentais de forma versionada e topologicamente validável. O autor recebe somente uma projeção delimitada, não todos os documentos nem o projeto aberto.
- Manter uma correção estrutural. Os novos erros entram na lista localizada de artefatos afetados e a correção inteira volta por todos os validators.
- Fazer a validação pós-publicação read-only. Qualquer tentativa de corrigir o destino por `syncManifest` é proibida nesse caminho.
- Tratar a proteção no RB Ralph como requisito de compatibilidade coordenado: o Harness elimina autoridade inválida na origem; o consumidor ainda precisa defender contra desobediência do provider.

## Sequência de implementação

### 1. Fechar autoridade de Scope

Adicionar classificador de tokens de scope e erro estável. Cobrir casos positivos/negativos e garantir que Context/Validation não sejam confundidos com escrita.

### 2. Adicionar coerência do bundle

Extrair referências operacionais tipadas e relacioná-las a caminhos existentes, saídas planejadas ou proveniência declarada. Usar a mesma função na validação de staging e no relatório. O relatório deve citar ambos os artefatos.

### 3. Ordenar a autoria incremental

Versionar o checkpoint/plano documental, validar arestas/ciclos e construir projeções. `PHASES.md` precede `OPERATIONS.json`; o source manifest é finalizado depois do conjunto que enumera. Testes devem provar orçamento e retomada incompatível.

### 4. Fechar a publicação

Após rename, validar a árvore publicada. Em falha, restaurar a revisão anterior e persistir estágio/diagnóstico exatos. Testar primeira publicação e substituição.

### 5. Alinhar linguagem e integração

Atualizar digest code-owned, referências, instruções init/plan/evolve, contratos e READMEs. Remover a frase que dá a fase normal a criação do contrato. Documentar migração e mínimo compatível de Ralph.

### 6. Provar generalidade no pacote

Executar fixtures de workflows e formas de produto diferentes, incluindo resposta defeituosa reparável e pacote instalado. Fechar com `npm run check`.

## Riscos e mitigação

- Falso positivo em caminhos operacionais gerados durante o cenário: usar proveniência explícita e fixtures de build output, não heurística crescente de extensões.
- Aumento de prompt: projeções possuem teto próprio e testes de bytes; nunca inserir documentos completos por conveniência.
- Checkpoint incompatível: falhar de forma diagnosticada e recomeçar a autoria, sem misturar autoridades.
- Rollback incompleto: testar com e sem revisão anterior e conservar `.rb/runs` fora da árvore portátil.
- Compatibilidade parcial com Ralph antigo: declarar explicitamente no pacote e bloquear promessa end-to-end até a entrega coordenada.

## Validação final

- testes focados dos contratos, geração incremental, recovery, workspace e verifier;
- `npm run check:package` contra pacote realmente instalado;
- `npm run check` como gate integral;
- `rb-harness contract validate`, `manifest sync`, `tree validate` e `artifacts verify` sobre os artefatos desta evolução.

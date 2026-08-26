# Solicitação de evolução — integridade sistêmica dos artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: change-request-artifact-generation-integrity -->

## Origem

O desenvolvedor relatou que correções da geração vêm sendo orientadas por falhas pontuais de cada projeto e não eliminam a classe de defeitos. Como reprodução, forneceu o projeto `Atravessar_a_rua`: a geração terminou e a verificação chegou a aprovar um plano, mas o Ralph reescreveu `.rb/init/OPERATIONS.json`; a verificação posterior encontrou hash diferente do manifesto e declarou `Ralph NOT READY`.

## Objetivo

Fazer da integridade uma propriedade do protocolo, independente de domínio, stack, provider e forma de produto: artefatos relacionados devem concordar antes da publicação e nenhum executor pode receber autoridade para alterar o conjunto publicado.

## Atores e gatilhos

- Autor documental do Harness: produz partes incrementais e uma eventual correção estrutural.
- Orquestrador do Harness: monta, valida, publica e indexa `.rb`.
- Validador/operador: executa `contract validate`, `tree validate` e `artifacts verify`.
- Executor direto ou RB Ralph: lê o plano publicado e altera somente arquivos de implementação autorizados.
- Auditor operacional: executa o `OPERATIONS.json` publicado depois das fases.

O fluxo é acionado por `init`, `plan` ou `evolve`, seguido por verificação e execução.

## Escopo

- Autoridade de escrita declarada por `Scope` em `rb-execution/v1`.
- Coerência entre `PHASES.md`, `OPERATIONS.json` e os demais documentos de decisão.
- Ordem e contexto da autoria incremental.
- Validação antes e imediatamente depois da publicação.
- Diagnóstico e migração de planos legados que atribuem `.rb/**` a tarefas.
- Contrato de integração com consumidores como RB Ralph.

## Fora de escopo

- Corrigir o código do jogo de exemplo.
- Aceitar a mutação com `manifest sync` ou recalcular hashes automaticamente.
- Tornar o verificador probabilístico ou iniciar um provider durante `artifacts verify`.
- Inferir semântica arbitrária de scripts embutidos em argumentos de linha de comando.
- Implementar, neste repositório, a defesa adicional do executável RB Ralph mantido em outro produto.

## Decisões e premissas

- CONFIRMED pelo pedido: a correção deve atacar a classe de falhas, não o domínio do projeto reproduzido.
- OBSERVED: `.rb` já é somente leitura nas ferramentas diretas do papel `ralph-agent`, portanto a intenção arquitetural existente é preservada.
- ASSUMPTION de baixo risco: um artefato publicado é autoridade imutável durante uma execução. Uma alteração legítima exige nova geração/publicação, novo manifesto e nova verificação antes de iniciar outra execução.
- ASSUMPTION de baixo risco: referências a `.rb/**` continuam permitidas em `Context`, comandos de validação e evidência; somente a posse de escrita em `Scope` é proibida.
- ASSUMPTION de baixo risco: uma incompatibilidade detectada depois da publicação deve restaurar a revisão anterior, quando existir, e nunca declarar a execução pronta.

## Prontidão

`READY_WITH_ASSUMPTIONS`. O comportamento atual, a causa raiz e as fronteiras afetadas foram provados por código, testes e evidência da execução fornecida. Não há decisão de produto material pendente para planejar a correção no Harness. A proteção provider-neutral dentro do RB Ralph permanece uma entrega coordenada externa e está explicitada em `MIGRATION.md`.

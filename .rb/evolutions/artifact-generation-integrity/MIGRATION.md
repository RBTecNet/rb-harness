# Migração — autoridade imutável de artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: migration-artifact-generation-integrity -->

## Compatibilidade de planos existentes

1. Uma árvore válida cujo `PHASES.md` não possui `.rb/**` em `Scope` continua compatível.
2. Uma árvore com task escritora de `.rb/**` passa a falhar `contract validate`/`artifacts verify`. O operador deve regenerar o workflow que produziu o plano.
3. Uma árvore com `artifact.stale` não deve receber `manifest sync` como reparo. Primeiro se identifica a mutação; depois se restaura/regenera a autoridade e se verifica novamente.
4. Código de aplicação já implementado não é apagado durante a regeneração documental. O novo contexto deve observar o estado atual e produzir o delta remanescente.

## Checkpoints de geração

- Checkpoint sem versão de dependências documentais não pode ser retomado como se satisfizesse o novo protocolo.
- O Harness deve emitir diagnóstico estável, preservar logs e reiniciar somente a etapa documental necessária.
- Checkpoints já materializados nunca são publicados sem passar novamente pelos checks individuais e cruzados atuais.

## Ordem de rollout

1. Publicar validador de scope e coerência, templates e recuperação pós-publicação no Harness.
2. Gerar pacote/plugin e executar a matriz instalada.
3. Atualizar RB Ralph para fingerprint de todo o diretório de artefatos antes/depois de cada unidade sequencial, paralela e legacy; manter `.rb/runs/**` fora desse fingerprint.
4. Adicionar no CI do consumidor uma fixture cujo executor tenta alterar `OPERATIONS.json` e esperar `CONTROL_PLANE_VIOLATION` antes de validação/manager/RBT.
5. Somente então declarar a combinação de versões end-to-end compatível.

## Rollback

- Rollback do Harness restaura a versão anterior do pacote e a última revisão documental válida; não reutiliza checkpoints do protocolo novo no binário antigo.
- Rollback de publicação dentro de um run restaura `previous-artifacts` e conserva o diagnóstico no run state.
- Se Harness novo for usado com Ralph antigo, `artifacts verify` ainda impede planos que autorizem `.rb`, mas não há defesa completa contra provider que desobedeça o plano. Essa combinação deve ser marcada como compatibilidade reduzida, não como pronta end-to-end.

## Observabilidade e recuperação

- Findings devem distinguir `task.scope.control-plane`, `artifact.cross-reference` e `artifact.stale`.
- O run state deve indicar se a falha ocorreu em staging, depois do rename ou no consumidor.
- A mensagem de recuperação deve apontar o workflow/artefatos conflitantes e jamais sugerir resync como solução automática.

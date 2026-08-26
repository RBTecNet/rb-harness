# Migração: evidência de aceitação visual

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-migration

## Compatibilidade de documentos existentes

Planos `rb-execution/v1` já publicados não são reescritos automaticamente. Ao
serem revalidados, tasks com semântica visual podem falhar com códigos
`task.validation.visual-*`, `task.evidence.visual-*` ou
`task.acceptance.visual-negative-control`.

## Caminho de correção

1. Se existe automação de navegador/renderizador grounded, declarar seu comando
   one-shot e evidência durável completa.
2. Se ela não existe, substituir a prova visual `manual:` por `human:` e manter
   a task pausável.
3. Adicionar controle negativo e, para interações, estados antes/depois.
4. Revalidar contrato, manifesto e árvore com o CLI da mesma versão.

## Coexistência e rollback

Não há migração de dados. Harness novo rejeita plano visual antigo inseguro;
Ralph antigo pode não aplicar o protocolo reforçado e deve ser atualizado no
repositório próprio. Rollback exige reverter validator, digest, contratos e
recursos como uma unidade para não publicar uma garantia falsa.

## Observabilidade

Os novos diagnostic codes identificam precisamente capacidade ausente,
contrato de evidência incompleto, controle negativo ausente e par de estados
ausente. Eles são erros reparáveis de geração antes da execução.

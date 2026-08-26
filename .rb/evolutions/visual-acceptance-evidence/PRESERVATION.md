# Preservação: evidência de aceitação visual

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

**Artifact ID:** evolution-visual-acceptance-preservation

| Disposição | Comportamento |
|---|---|
| CHANGE | `manual:` deixa de ser válido para critérios renderizados. |
| CHANGE | evidência visual passa a exigir screenshot, viewport, geometria e controle negativo. |
| CHANGE | interação visual passa a exigir antes/depois. |
| PRESERVE | `manual:` continua válido para inspeção não visual realmente observável pelo gerente. |
| PRESERVE | `human:` continua pausando antes do provider. |
| PRESERVE | comandos de validação continuam provider- e stack-neutral. |
| PRESERVE | produtos CLI que apenas imprimem stdout não viram UI por falso positivo. |
| PRESERVE | OPERATIONS.json continua omitido quando não há cenário honesto grounded. |
| DEPRECATE | presença de seletor/fake DOM como substituto de visibilidade renderizada. |
| UNKNOWN | capacidade da versão concreta do Ralph de persistir screenshots; pertence ao repositório Ralph. |

Comportamentos não listados permanecem inalterados por padrão.

# Matriz de regressão — integridade dos artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: regression-artifact-generation-integrity -->

| ID | Cenário | Entrada/evidência | Resultado observável | Owner |
|---|---|---|---|---|
| RG-001 | plano possui `Scope: .rb/init/OPERATIONS.json` | fixture de execution contract | `task.scope.control-plane`, contrato inválido | T001 |
| RG-002 | scope usa `.rb`, `.rb/`, descendente ou glob | tabela de tokens | todas as variantes falham com o mesmo critério e task correta | T001 |
| RG-003 | `.rb/init/OPERATIONS.json` aparece somente em Context e `operations validate` | fixture read-only | plano permanece válido | T001 |
| RG-004 | artifact directory físico é customizado | árvore em `.spec`, paths lógicos `.rb/**` | writer de artefato falha; leitura continua válida | T001/T002 |
| RG-005 | operations tipado usa caminho futuro incompatível com scopes finais | bundle genérico `planned/app.js` versus `app.js` | staging e verifier reportam o mesmo blocker cruzado | T002 |
| RG-006 | operations usa caminho existente preservado | fixture com arquivo anterior à geração | contrato permanece publicável | T002 |
| RG-007 | file step verifica saída de passo anterior com proveniência declarada | fixture operacional | não há falso positivo de caminho futuro | T002 |
| RG-008 | grafo documental declara dependência inexistente | document plan fixture | plano documental falha antes de autoria das partes | T003 |
| RG-009 | grafo documental é cíclico | document plan fixture | código determinístico rejeita o ciclo | T003 |
| RG-010 | OPERATIONS é autorado depois de PHASES | provider fixture registra prompts | prompt operacional contém a projeção final limitada e não contém chat/projeto aberto | T003 |
| RG-011 | bundle nasce com scope `.rb` e referência divergente | structural-repair fixture | uma correção localizada pode alterar só documentos afetados e a árvore inteira fica verde | T003 |
| RG-012 | correção perde título, IDs ou conteúdo não relacionado | fixture existente de truncamento | publicação continua bloqueada | T003 |
| RG-013 | destino publicado é idêntico ao staging validado | integração workspace | run fecha `complete` | T004 |
| RG-014 | hook de teste altera um artefato após rename | integração workspace | validação falha, revisão anterior volta, run não fica complete | T004 |
| RG-015 | primeira publicação falha no fechamento sem revisão anterior | integração workspace | artefatos inválidos não são anunciados como completos e evidência permanece | T004 |
| RG-016 | hash stale já existente | verifier fixture | blocker permanece e requiredChange manda regenerar/investigar, não resync | T002/T006 |
| RG-017 | init de produto arquivo estático | provider fixture neutra | artefatos publicados não contêm task `.rb`; verify passa | T007 |
| RG-018 | plan de CLI/biblioteca | pacote instalado e fake provider | contract/tree/artifacts verify passam | T007 |
| RG-019 | evolve de serviço | provider fixture neutra | dependências documentais e operations coerentes passam | T007 |
| RG-020 | provider externo tenta alterar artifact no Ralph | fixture no repositório consumidor | tentativa termina como `CONTROL_PLANE_VIOLATION` antes de manager/RBT | entrega externa RF-008 |
| RG-021 | gate completo do repositório | `npm run check` | build, types, package, tests, Bash e sync do plugin passam | T007 |

As fixtures RG-017 a RG-019 devem usar nomes e requisitos artificiais distintos; nenhuma pode copiar `galinha`, `game.js`, veículos ou o layout do projeto de reprodução.

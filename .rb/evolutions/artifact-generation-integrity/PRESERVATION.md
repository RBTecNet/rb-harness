# Preservação — integridade sistêmica dos artefatos

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: preservation-artifact-generation-integrity -->

| Disposição | Comportamento | Promessa de compatibilidade | Prova/owner |
|---|---|---|---|
| CHANGE | `Scope` aceita `.rb/**` | passa a falhar com código determinístico antes da execução | RF-001 · T001 |
| CHANGE | documentos dependentes são autorados apenas pelo ledger comum | dependências finalizadas e projeções limitadas entram na autoridade de cada writer | RF-004 · T003 |
| CHANGE | contratos isolados podem validar apesar de contradizerem outro artefato | staging e verifier usam o mesmo gate cruzado | RF-005 · T002 |
| CHANGE | run vira `complete` imediatamente após rename | fechamento exige validação read-only do destino | RF-006 · T004 |
| CHANGE | texto diz que fase normal possui a criação de `OPERATIONS.json` | geração é o único writer; fase pode somente lê-lo e validá-lo | RF-003 · T005 |
| CHANGE | integração externa pode depender de prompt para proteger `.rb` | contrato exige fingerprint provider-neutral em todos os modos | RF-008 · T006 |
| PRESERVE | `artifacts verify` é determinístico e não inicia provider | nenhum check novo pode chamar provider | RF-007 · T002/T007 |
| PRESERVE | `artifact.stale` é blocker | hash divergente nunca é sincronizado automaticamente | RF-009 · T004/T006 |
| PRESERVE | `.rb` pode aparecer em Context e validações read-only | documentos cold-context e `operations validate` continuam válidos | RF-002 · T001 |
| PRESERVE | uma única correção estrutural localizada | novos erros são repairable antes da publicação; não se adicionam retries ilimitados | RF-005 · T003/T004 |
| PRESERVE | publicação por staging/rename e revisão anterior preservada | nova validação fecha o mesmo protocolo e usa a revisão para rollback | RF-006 · T004 |
| PRESERVE | custom `--output` mantém caminhos lógicos `.rb/**` no manifesto | a regra opera na autoridade lógica, não num diretório físico hardcoded | RF-001 · T001/T002 |
| PRESERVE | contratos públicos de manifest e operations v1 | nenhuma alteração incompatível de schema é necessária | RF-005 · T002 |
| DEPRECATE | task “Criar/editar OPERATIONS.json” em PHASES | planos devem ser regenerados; não há auto-rewrite pós-publicação | RF-003/RF-009 · T005/T006 |
| DEPRECATE | checkpoint incremental sem identidade de dependências | retomada deve falhar com diagnóstico de versão e reiniciar a autoria documental | RF-004 · T003 |
| UNKNOWN | versão instalada do RB Ralph usada na reprodução | não muda a causa no Harness; a compatibilidade mínima será declarada e testada no repositório consumidor | RF-008 · T006 |

Nenhuma disposição autoriza alteração de `ajuste_harness.md` ou do código do projeto exemplo.

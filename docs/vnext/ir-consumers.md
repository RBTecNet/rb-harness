# vNext Phase 1 IR consumer register

Every production `InitProjectModel` surface is witnessed by a `satisfies Record<keyof …>` registration in `vnext/ir.ts`. Adding a field to any model interface or discriminated-union variant fails typecheck until a present Phase 1 consumer is declared. The executable register test also requires this table to match the typed registrations exactly and requires every code registration to have a non-empty consumer.

`core.provenance.harnessVersion` was removed: it had no present deterministic consumer.

| path | author | current consumer(s) | invariant(s) |
| --- | --- | --- | --- |
| core | typed IR | deterministic closure and renderers | typed witness |
| core.determinations | typed IR | authority validation and BRIEF | typed witness |
| core.determinations[].key | semantic input | determination grammar and uniqueness | I-16 |
| core.determinations[].materiality | semantic input | default authority policy | I-17 |
| core.determinations[].rationale | semantic input | BRIEF reasoning | I-18 |
| core.determinations[].rigidity | semantic input | default authority policy and BRIEF | I-17 |
| core.determinations[].source | Core-verified | authority validation | I-17 |
| core.determinations[].source.evidence | verified request | meaningful request-phrase verification | I-17 |
| core.determinations[].source.kind | Core-verified | provenance rule dispatch | I-17 |
| core.determinations[].source.questionKey | verified answer | supplied-answer resolution | I-17 |
| core.determinations[].statement | semantic input | BRIEF determinations | I-18 |
| core.identity | Core | artifact and document identity | typed witness |
| core.identity.id | Core | artifact IDs | I-01 |
| core.identity.name | semantic input | PHASES and BRIEF title | I-18 |
| core.identity.objective | semantic input | BRIEF objective | I-18 |
| core.protectedPaths | Core/verified input | scope authority and BRIEF | typed witness |
| core.protectedPaths[].path | Core/verified input | path safety, ownership intersection, BRIEF | I-06, I-07 |
| core.protectedPaths[].reason | Core/verified input | BRIEF authority explanation | I-18 |
| core.protectedPaths[].source | Core-verified | protected-path authority | I-17 |
| core.protectedPaths[].source.evidence | verified request | meaningful request-phrase verification | I-17 |
| core.protectedPaths[].source.kind | Core-verified | provenance rule dispatch | I-17 |
| core.protectedPaths[].source.questionKey | verified answer | supplied-answer resolution | I-17 |
| core.provenance | Core | closure and manifest provenance | typed witness |
| core.provenance.answers | supplied answers | user-answer verification | I-17 |
| core.provenance.generatedAt | injected run clock | manifest generatedAt | I-17 |
| core.provenance.originalRequest | request | request-evidence verification | I-17 |
| core.provenance.requestSha256 | Core | binds provenance to request bytes | I-17 |
| core.provenance.runId | Core | deterministic staging/publication root | I-17 |
| phases | resolved by Core | validation and ExecutionDocument derivation | I-14 |
| phases[].dependsOn | resolved by Core | graph validation and PHASES dependencies | I-02, I-04 |
| phases[].goal | semantic input | PHASES goal | I-18 |
| phases[].id | Core | PHASES identity and dependencies | I-01 |
| phases[].key | semantic input | symbolic dependency resolution | I-02 |
| phases[].number | Core | PHASES ordering | I-01 |
| phases[].tasks | resolved by Core | validation and ExecutionDocument derivation | I-14 |
| phases[].tasks[].acceptance | semantic input/Core IDs | semantic validation and PHASES | I-09, I-10, I-13 |
| phases[].tasks[].acceptance[].id | Core | PHASES acceptance identity | I-01 |
| phases[].tasks[].acceptance[].statement | semantic input | acceptance and visual validation | I-10, I-13 |
| phases[].tasks[].covers | resolved by Core | coverage closure and PHASES | I-03 |
| phases[].tasks[].dependsOn | resolved by Core | graph validation and PHASES | I-05 |
| phases[].tasks[].expectedEvidence | semantic input | PHASES evidence | I-09 |
| phases[].tasks[].id | Core | task and acceptance identity | I-01 |
| phases[].tasks[].intent | semantic input | control-plane validation and PHASES Change | I-08, I-09 |
| phases[].tasks[].key | semantic input | symbolic task resolution | I-02 |
| phases[].tasks[].ownedPaths | semantic input | line/path safety, authority, PHASES Scope | I-06, I-07, I-08 |
| phases[].tasks[].parallelSafe | Core | conservative scheduling | I-19 |
| phases[].tasks[].title | semantic input | PHASES heading | I-18 |
| phases[].tasks[].validation | semantic input/Core resolution | validation closure and PHASES | I-09, I-11, I-12 |
| phases[].tasks[].validation[].commandKey | resolved by Core | quality-command lookup | I-11 |
| phases[].tasks[].validation[].evidence | semantic input | human evidence rendering | I-09 |
| phases[].tasks[].validation[].inspection | semantic input | manual ambiguity validation and rendering | I-09, I-12 |
| phases[].tasks[].validation[].kind | semantic input | validation rule/render dispatch | I-09 |
| phases[].title | semantic input | PHASES heading | I-18 |
| qualityCommands | semantic input | validation resolution and PHASES commands | I-11, I-12 |
| qualityCommands[].command | semantic input | command safety and PHASES rendering | I-12 |
| qualityCommands[].key | semantic input | validation intent lookup | I-11 |
| qualityCommands[].kind | semantic input | BRIEF quality context | I-12 |
| requirements | semantic input | coverage validation and BRIEF | I-03, I-20 |
| requirements[].id | Core | coverage, PHASES, BRIEF | I-01 |
| requirements[].key | semantic input | resolution and coverage lookup | I-02 |
| requirements[].statement | semantic input | BRIEF requirement meaning | I-18 |
| version | Core | canonical contract compatibility | I-01 |
| workflow | Core | init closure dispatch | I-01 |

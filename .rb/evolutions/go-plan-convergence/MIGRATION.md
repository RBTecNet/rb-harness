# Migração — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: migration-go-plan-convergence -->

Planos publicados não são reescritos. `artifacts verify` pode reclassificar um plano legado comprovadamente não convergente como não pronto; o operador deve regenerar/revisar o bundle antes de chamar Ralph.

O rollout é atômico no pacote: digest, classificador e todas as portas são construídos da mesma fonte. O rollback consiste em restaurar a versão anterior do Harness; nenhum dado ou manifesto de projeto recebe backfill. Observabilidade usa os códigos estáveis `execution.go-tidy.nonconvergent-direct-requirement` e `execution.go-direct-requirement.module-identity-missing`.

Não existe coexistência de schemas nem flag de feature: a mudança amplia validação de prontidão sem alterar `rb-execution/v1`.

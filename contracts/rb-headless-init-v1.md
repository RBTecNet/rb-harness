# RB Headless Init Contract v1

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

`rb-headless-init/v1` é a fronteira provider-neutral para pedir ao RB Harness um pacote declarativo completo de projeto novo. O contrato não permite AS IS, mudança incremental, source snapshot nem execução.

## Invocação Memory → Harness

O worker inicia o executável/version pin configurado com:

```text
rb-harness headless init --output <absolute-isolated-output-root>
```

- cwd é o workspace isolado do job.
- stdin contém exatamente um JSON request UTF-8 conforme schema, terminado por EOF.
- stdout contém exatamente um JSON result conforme schema, sem prosa.
- stderr é diagnóstico e nunca contém secret nem o request integral.
- O Memory impõe timeout/process tree; o Harness impõe schema, escopo, output root e validação.

Exit codes:

| Code | Meaning | Retry |
|---:|---|---|
| 0 | result `ready` e output validado | não |
| 2 | request/output/contract inválido | não; revision invalid |
| 3 | Harness/adapter/config incompatível | não até reconfiguração |
| 70 | adapter/provider/transport falhou | sim se tentativa disponível |
| 75 | provider indisponível/rate limit | sim se tentativa disponível, sem alegar sucesso |
| demais | falha não classificada | sim uma vez; depois failed |

## Request

O request usa `kind=request`, `workflow=init` e `projectKind=new`. `requestId`, IDs de projeto/spec/set/revision e hashes são opacos ou IDs estáveis; nenhum tenant ID, credential, cookie, token, path físico, chat history ou provider-specific parameter é permitido.

As especificações são snapshots integrais já fixados pelo Memory. Cada recurso é exatamente uma variante: `reference` exige `reference` e proíbe campos de attachment; `attachment` exige `path`, `mediaType` e `bytes` e proíbe `reference`. Há no máximo 20 attachments por especificação, 100 por request e 100 MiB de attachments agregados; cada attachment tem no máximo 10 MiB. Paths são relativos NFC, compostos por no máximo 16 segmentos não vazios, sem slash final, backslash, drive, `.`, `..` ou NUL, têm no máximo 240 caracteres e não colidem após NFC e lowercase Unicode. O Harness verifica os hashes antes de produzir o prompt.

`additionalInstructions` pode restringir ou esclarecer o projeto, mas o Harness rejeita texto que solicite clone/snapshot/evidência de código, `ai-context`, `plan`, `evolve`, implementação ou Ralph. `interviewAnswers` inclui somente respostas já aceitas, cada uma com pergunta, resposta normalizada e disposition `accepted`.

## Harness → adapter

O Harness é o único proprietário das instruções e prompts de `rb-init`. Ele transforma o request em prompt; o Memory nunca armazena uma cópia do prompt do workflow.

O adapter executável:

- recebe o prompt via stdin e EOF;
- tem cwd no workspace isolado;
- recebe somente variáveis base seguras, `RB_HEADLESS_OUTPUT_ROOT`, `RB_HEADLESS_REQUEST_ID`, `RB_HEADLESS_HARNESS_VERSION`, labels provider/model e nomes/valores explicitamente allowlisted pelo operador;
- escreve somente no output root;
- não retorna contrato de autoridade; exit 0 apenas informa que terminou, e o Harness ainda valida tudo;
- pode usar exit 75 para indisponibilidade/rate limit, mas nunca incluir credential em output.

Unknown environment variables are dropped. Exact secret values are never copied into prompt, request, result or artifacts. Redaction is defense in depth.

## Output e validação

O output permitido é uma árvore `.rb/` de `rb-init` e, opcionalmente, arquivos Harness-owned explicitamente allowlisted. A V1 publicada pelo Memory exige:

1. `.rb/rb-manifest.json` `rb-manifest/v1` com project ID igual ao request;
2. pelo menos um execution plan `ready`, `rb-execution/v1`;
3. nenhum execution artifact draft/blocked/invalid;
4. `contract validate` em cada PHASES;
5. `operations validate` em cada OPERATIONS presente;
6. `manifest sync` e manifest/tree hash consistency;
7. `tree validate` verde;
8. todos os files regulares e dentro da matriz CR-005.

O Harness retorna `kind=result`, status `ready|invalid|failed`, versão/hash do Harness, labels de adapter/provider/model, files e validations. `ready` exige pelo menos um file e exatamente uma validação de cada nome `request`, `paths`, `contract`, `operations`, `manifest`, `tree` e `secrets`; todas têm `passed=true` e `exitCode=0`. `invalid` e `failed` publicam diagnóstico, mas nenhum file. Há no máximo 2.000 files, 5 MiB por file e 100 MiB agregados; os mesmos limites e regras de path normalizado se aplicam ao inventário. O Memory recalcula hashes antes da publicação; divergência invalida.

## Idempotência

O mesmo request canônico produz o mesmo `requestHash`; não se promete output byte-identical de IA. Idempotência de job significa não criar outra revisão para a mesma key/request hash. Cada tentativa pode recriar o workspace da mesma revisão, e somente a primeira publicação válida vence por compare-and-set de state/lease.

## Security matrix

- Mixed `request`/`result` fields: schema rejects.
- Unknown fields: schema rejects.
- Trailing JSON or multiple documents: parser consumes entire stdin and rejects.
- Invalid hash/path/enum/count: rejects before adapter.
- Adapter output with symlink/hardlink/device/path escape/duplicate normalization: invalid.
- Provider/transport/nested error with secret sentinel: public/persisted result omits sentinel.
- Adapter exit 0 with missing/invalid artifacts: result invalid, never ready.

## Compatibility

Consumers reject unknown major contracts. Additive optional fields require a later documented compatible revision; semantic expansion to `plan`/`evolve` requires a different contract, not a new enum value silently accepted by v1.

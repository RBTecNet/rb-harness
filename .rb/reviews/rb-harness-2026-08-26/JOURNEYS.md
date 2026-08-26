# Jornadas Revisadas — RB Harness 2026-08-26

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: journeys-rb-harness-2026-08-26 -->

## J01 — Workflow standalone até publicação

- **Ator:** desenvolvedor no terminal.
- **Passos:** CLI normaliza request/options → inventário/projeção → entrevista adaptativa → geração incremental → materialização em staging → contratos/manifest/decomposição → rename atômico para o diretório de artefatos.
- **Trust boundaries:** usuário → adapter/provider; provider output → parser estrito; staging → árvore publicada.
- **Transições de dados:** request e hashes entram em estado privado; somente documentos tipados entram em `.rb`; revisão anterior é preservada sob o run privado.
- **Feedback:** dashboard/logs, diagnóstico estruturado, exit status e resumo de duração/usage.
- **Falhas cobertas:** output truncado, envelope inválido com formatter fechado, provider sem progresso, validação estrutural, publicação interrompida, artefatos bloqueados.

## J02 — Descoberta documental confinada

- **Ator:** provider CLI ou API direta no papel de entrevistador/gerador.
- **Passos:** política classifica paths → CLI recebe projeção read-only ou API recebe list/search/read → evidência entra no contexto remoto → documentação é gerada.
- **Trust boundaries:** filesystem local → projeção/ferramenta → provider externo.
- **Transições de dados:** conteúdo first-party permitido é copiado/lido; control plane, Git, builds e alguns nomes de segredo são excluídos.
- **Feedback:** erros de path são devolvidos à chamada da ferramenta; truncamentos são declarados.
- **Falhas cobertas:** traversal, symlink para fora, `.git`, `.rb-harness`, `.rb/runs`, `.env`, chaves por extensões conhecidas.
- **Falha descoberta:** `RV-SEC-001` — arquivos comuns como `.npmrc` atravessam a fronteira.

## J03 — Headless interview durável

- **Ator:** serviço integrador/Memory.
- **Passos:** valida request → adquire lock de sessão → chama adapter → classifica resposta → persiste cursor/questão → devolve evento idempotente.
- **Trust boundaries:** mensagem JSON → runtime; runtime → adapter não confiável; adapter → parser; sessão privada → resposta pública.
- **Transições de dados:** request fechado e respostas aceitas; allowlist de ambiente; hashes/cursor protegem replay e continuidade.
- **Feedback:** códigos 0/2/3/70/75 e `diagnosticCode` estável.
- **Falhas cobertas:** cursor stale, mutação do workspace, protocolo inválido, sentinela secreta, lock concorrente.
- **Falha descoberta:** `RV-OPS-001` — timeout não garante término/quiescência do adapter.

## J04 — Login e cofre compartilhado

- **Ator:** usuário interativo do Harness ou Ralph.
- **Passos:** escolhe provider/protocolo → fornece segredo oculto ou conclui OAuth/ADC → segredo é cifrado AES-256-GCM → documento e chave são gravados com permissões privadas → runtime resolve a credencial por ID/rótulo/default.
- **Trust boundaries:** terminal/browser/gcloud → processo local; plaintext em memória → cofre por usuário; cofre → header do provider.
- **Transições de dados:** ciphertext e metadados em `provider-credentials.json`; chave separada; listagem remove ciphertext.
- **Feedback:** ID salvo, listagem segura e erros de seleção/decriptação.
- **Falhas cobertas:** secret em argv, permissões, algoritmo/tag GCM, seleção ambígua.
- **Falha descoberta:** `RV-DATA-001` — gravações concorrentes acknowledged são perdidas.

## J05 — Execução direta do Ralph

- **Ator:** modelo executor em modo `yolo` explicitamente autorizado.
- **Passos:** API agent expõe read/write/replace/run → valida paths e permissões → executa argv sem shell → devolve stdout/stderr limitado.
- **Trust boundaries:** provider remoto → ferramentas locais → processo filho → workspace/evidence.
- **Transições de dados:** alterações first-party e evidência; subprocesso herda o ambiente do runtime.
- **Feedback:** output truncado e marcador de exit/signal.
- **Falhas cobertas:** protected recusa execução, traversal/symlink, escrita em Git/artefatos, timeout solicitado.
- **Falha descoberta:** parte de `RV-OPS-001` — o timeout solicitado não encerra processo resistente. A herança integral de ambiente foi observada, mas não promovida a achado independente porque `yolo` já autoriza execução arbitrária e o host Ralph pode sanitizar seu ambiente; permanece uma fronteira operacional que deve ser documentada/testada.

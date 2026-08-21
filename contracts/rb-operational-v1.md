# RB Operational Contract v1

`rb-operational/v1` descreve como provar, do ponto de vista de um consumidor, que o produto entregue pode ser preparado, iniciado e usado. Ele é aditivo: não altera `rb-execution/v1`, não substitui critérios de fase e não obriga execução pelo RB Ralph.

O arquivo recomendado é `OPERATIONS.json`, ao lado de `PHASES.md`. O RB Ralph também descobre `.rb/OPERATIONS.json`. Um executor direto pode seguir o mesmo documento sem usar o runner.

## Princípios

- O contrato é agnóstico de linguagem, framework, interface e sistema operacional.
- Comandos usam `argv`, sem depender de quoting ou de um shell específico.
- Cada cenário pode declarar `platforms`: `linux`, `darwin` e/ou `win32`.
- A verificação ocorre numa cópia temporária, excluindo estado de execução, controle de versão e arquivos locais de segredo.
- O ambiente é mínimo. Somente variáveis listadas em `environment.inherit` são herdadas além das variáveis básicas do sistema.
- `${RB_VERIFY_ROOT}` aponta para a cópia e `${RB_VERIFY_PORT}` oferece uma porta local temporária.
- O contrato deve exercitar fronteiras reais. Testes que apenas repetem mocks internos não constituem aceitação operacional.

## Tipos de passo

- `command`: executa qualquer programa e verifica exit code e trechos de stdout/stderr. Serve para build, teste, CLI, instalador, empacotamento e automação de UI.
- `process`: inicia um processo, aguarda uma sonda de prontidão, executa sondas adicionais e encerra o processo.
- `http`: verifica uma resposta HTTP real.
- `tcp`: verifica que uma fronteira TCP está acessível.
- `file`: verifica a existência ou o conteúdo de um artefato produzido.

Sondas `stdout`, `http`, `tcp` e `file` também podem ser usadas para prontidão de um `process`.

## Exemplo multiplataforma

```json
{
  "contract": "rb-operational/v1",
  "cleanRoom": {
    "exclude": ["node_modules", "dist", "bin", "obj"]
  },
  "environment": {
    "inherit": [],
    "set": { "APP_ENV": "verification" }
  },
  "scenarios": [
    {
      "id": "desktop-package",
      "title": "Build and exercise the desktop application",
      "platforms": ["linux", "darwin", "win32"],
      "steps": [
        {
          "id": "build",
          "kind": "command",
          "command": { "argv": ["dotnet", "build", "--configuration", "Release"] }
        },
        {
          "id": "ui-smoke",
          "kind": "command",
          "command": { "argv": ["dotnet", "test", "tests/Desktop.UiTests"] }
        },
        {
          "id": "artifact",
          "kind": "file",
          "path": "src/App/bin/Release/net8.0/App.dll"
        }
      ]
    }
  ]
}
```

Uma aplicação web pode usar `process` + `http`; um daemon pode usar `process` + `tcp`; uma CLI pode usar `command` + expectativas de saída; uma biblioteca pode compilar um consumidor mínimo; uma aplicação desktop pode executar testes de UI reais e verificar seus pacotes. Nenhuma dessas formas é privilegiada pelo contrato.

Cada host executa apenas os cenários aplicáveis ao seu `platforms`. Cobertura
nativa de vários sistemas exige runners correspondentes, CI multiplataforma,
emulador ou outra evidência real declarada; uma execução Linux não finge ter
aberto uma janela Windows ou macOS.

Validação manual ou visual que não possa ser automatizada continua documentada em `SPEC.md`/`PLAN.md`. Ela não deve ser fingida como prova automática: o gerente precisa apontar a pendência ou usar evidência/automação adequada à plataforma.

# Operational Acceptance Template

Use `OPERATIONS.json` to describe executable consumer-level proof using the
`rb-operational/v1` contract. The canonical source checkout also publishes
`contracts/rb-operational-v1.md` and its JSON Schema; the bundled
`rb-harness operations validate` command is authoritative in an installed
plugin. The document is provider- and runner-neutral: a person, a direct LLM,
CI, or RB Ralph can execute it.

## Discovery rules

1. Identify the product form from evidence or confirmed intent. Possibilities
   include desktop, mobile, CLI, service, API, web, library, plugin, package,
   firmware, data job, and mixed products. Never default to web.
2. Identify every platform the project actually claims. Do not equate stack
   portability with product-platform support.
3. Describe one smallest representative consumer workflow that crosses the
   real product boundary. Unit tests or mocked internal calls alone are not an
   operational workflow.
4. Use commands as `argv` arrays. Never invent a command, executable, path,
   port, route, window, package, or output. Ground it in current evidence or a
   confirmed TO BE decision.
5. Exclude dependency trees, build products, caches, local state, and secrets
   in `cleanRoom.exclude`. Keep only `.env.example`-style templates.
6. Inherit only named non-secret variables that the scenario genuinely needs.
   Never write a secret value into the contract.
7. Enumerate materially distinct documented configuration modes. At minimum,
   cover enabled and disabled optional capabilities when they change startup,
   the public response, or a user workflow. Cross-check the README, sample
   configuration, runtime loader, package/launcher entrypoint, and operational
   scenario as one public interface; a setup instruction is not proven merely
   because direct environment injection works.
8. Use the exact documented public argv and environment behavior. The verifier
   compares the declared workspace, argv, and environment to the contract;
   current-worktree services, ad hoc replacement commands, or pre-existing
   artifacts never substitute for the scenario.

## Scenario mapping

- Desktop/mobile: build/package, start through the supported launcher, then
  use real UI automation, accessibility inspection, screenshots with explicit
  criteria, process behavior, or another honest observable mechanism.
- CLI: install/build the executable, invoke its public command, and assert exit
  code plus stable output or produced files.
- Library/SDK: build/package it, create or use a minimal external consumer, and
  execute a public behavior.
- Service/API/web: start the documented process, wait through its actual
  protocol, probe a user-visible workflow, and terminate it.
- Plugin/package: install into a representative disposable host and prove it
  loads and exposes the documented capability.
- Job/worker/firmware/data product: exercise the supported trigger and verify
  its durable observable output or emulator/hardware contract.

Use `platforms` when commands or artifacts are platform-specific. Separate
scenarios may express platform alternatives. Absence of a scenario for a
claimed platform is an explicit gap, not implicit success.

## Minimal shape

```json
{
  "contract": "rb-operational/v1",
  "cleanRoom": { "exclude": ["<dependencies>", "<build-output>"] },
  "environment": { "inherit": [], "set": {} },
  "scenarios": [
    {
      "id": "primary-consumer-flow",
      "title": "<observable product outcome>",
      "platforms": ["linux"],
      "steps": [
        {
          "id": "prepare",
          "kind": "command",
          "command": { "argv": ["<program>", "<argument>"] }
        },
        {
          "id": "exercise",
          "kind": "command",
          "command": { "argv": ["<public-entrypoint>"] },
          "expect": { "exitCode": 0, "stdoutIncludes": ["<stable-observation>"] }
        }
      ]
    }
  ]
}
```

Supported step kinds are `command`, `process`, `http`, `tcp`, and `file`.
Supported process readiness/check probes are `stdout`, `http`, `tcp`, and
`file`. `${RB_VERIFY_ROOT}` and `${RB_VERIFY_PORT}` are runtime variables.

Do not encode a visual/manual claim as an automated pass. Keep genuinely
manual acceptance criteria in SPEC/PLAN and call out the automation gap. An
invalid or fictitious `OPERATIONS.json` is worse than omitting it and reporting
the gap.

When a scenario crosses an untrusted or secret-bearing boundary, prefer a local
fake/stub provider and a unique non-production sentinel. Force representative
provider/transport failures and assert that the sentinel is absent from public
responses and captured evidence. A readiness probe is not success if the
process later times out, is force-terminated, exits incorrectly, or fails its
declared cleanup; record those outcomes as failures.

Normal implementation phases own contract creation and deterministic
`operations validate`. Actual clean-room execution is owned by the post-phase
operational audit (`RBF`). Do not add "the OPERATIONS scenario passes" to a
normal phase acceptance criterion or manual validation: that creates a gate
which cannot run until the phase it gates is accepted.

Validate every emitted document with the bundled CLI before syncing the tree:

```bash
node <plugin-root>/scripts/rb-harness.cjs operations validate <path>/OPERATIONS.json
```

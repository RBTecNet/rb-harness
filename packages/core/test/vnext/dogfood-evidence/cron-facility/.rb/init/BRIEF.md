# Project Brief: cron-explicado

## Objective

Local web app that explains user crontab lines and generates valid cron lines from Brazilian Portuguese natural-language requests, without executing or installing anything.

## Confirmed determinations

- The application runs entirely locally with no external network calls. — Request asks for a local educational web application.
- The app never executes shell commands, never installs crontab entries, and never writes to the system; it only displays text. — Explicitly required.
- Generation input and all explanations are in Brazilian Portuguese. — Request specifies Brazilian Portuguese requests.
- Parsing targets the Linux user crontab dialect: five time fields plus command, plus @reboot/@daily-style special strings; no user column. — Request targets user crontab lines for Linux users.
- Vite + React + TypeScript single-page app, fully client-side — No backend is needed since nothing is executed; a static SPA enforces the no-execution constraint and runs locally with one command.
- A documented set of common patterns (every N minutes/hours, daily at a time, specific weekdays, monthly day, reboot), with a friendly 'nao entendi' message otherwise — Keeps the deterministic parser reliable and testable while covering most educational cases.
- The browser's local timezone, shown explicitly in the UI — Matches how the user's own cron daemon behaves and needs no configuration.

## Assumptions and defaults

- Explanation and generation use a deterministic rule-based parser, not an LLM or remote service. — Keeps the app offline, testable, and dependency-free.

## Requirements

- R-001 — Given a pasted user crontab line, the app shows a Brazilian Portuguese explanation of each of the five time fields and the command.
- R-002 — Invalid crontab lines produce a clear Brazilian Portuguese error identifying the offending field instead of an explanation.
- R-003 — Given a Brazilian Portuguese schedule request, the app outputs a valid cron expression plus its explanation.
- R-004 — Parser supports numbers, ranges, lists, steps, wildcards, month/weekday names, and @reboot/@daily/@hourly/@weekly/@monthly/@yearly.
- R-005 — For a valid expression the app lists the next few execution times computed locally.
- R-006 — The UI contains no action that runs, installs, or modifies any crontab or file on the machine.
- R-007 — Generated cron lines can be copied from the UI for the user to paste manually.

## Protected paths

- `.rb` — RB artifact control plane
- `.rb-harness` — RB Harness orchestration state
- `.git` — Version-control internals

## Quality context

- build
- lint
- test
- typecheck

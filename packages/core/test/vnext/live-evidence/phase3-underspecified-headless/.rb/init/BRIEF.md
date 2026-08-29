# Project Brief: simple-inventory

## Objective

Deliver a simple inventory system that tracks items and their stock quantities with basic create, read, update, delete, and stock-adjustment operations.

## Confirmed determinations

- Scope is a minimal inventory MVP: item records (name, SKU, quantity) plus stock adjustments, with no multi-warehouse, purchasing, or reporting features. — The request explicitly asks for a simple system, so scope stays minimal.
- An HTTP REST API (JSON) with no user interface. — A REST API is the smallest testable surface and can be driven by scripts or a UI added later.
- SQLite via a local file database. — Provides durable, transactional storage with zero external service setup, matching a simple system.
- No authentication; single trusted local user. — Keeps the MVP simple; auth can be layered on later without changing the data model.

## Assumptions and defaults

- Implement in TypeScript on Node.js. — No stack was specified; TypeScript/Node is a common default with good tooling for a small service.
- Quantities are non-negative integers and SKUs are unique; violations are rejected with a validation error. — Basic integrity rules are required for any inventory to be meaningful.
- Cover item CRUD and stock adjustment logic with automated unit tests. — Tests give a runnable, exiting validation signal for the MVP.

## Requirements

- R-001 — Users can create an inventory item with a name, unique SKU, and initial quantity.
- R-002 — Users can list and retrieve inventory items, including current quantity.
- R-003 — Users can update an item's descriptive fields.
- R-004 — Users can delete an inventory item.
- R-005 — Users can increase or decrease an item's stock by a delta, rejecting adjustments that would make quantity negative.
- R-006 — Inventory data persists across process restarts.
- R-007 — Invalid input and unknown item references return clear, structured errors.

## Protected paths

- `.rb` — RB artifact control plane
- `.rb-harness` — RB Harness orchestration state
- `.git` — Version-control internals

## Quality context

- build
- lint
- test
- typecheck

# RB Execution Plan: simple-inventory

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: simple-inventory-execution -->

## Phase 1: Project foundation and persistence

**Phase ID:** P01
**Goal:** Establish the TypeScript/Node project skeleton with SQLite-backed storage.
**Depends on:** none
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T001 — Scaffold TypeScript Node project
  - **Scope:** `.gitignore`, `eslint.config.js`, `package.json`, `tsconfig.json`
  - **Change:** Create package.json, tsconfig, lint config, and test runner wiring with build/test/lint/typecheck scripts.
  - **Covers:** R-006
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: Running the build script compiles TypeScript sources without errors.
    - AC-T001-02: Running the lint script exits successfully on the scaffolded sources.
    - AC-T001-03: Running the typecheck script reports no type errors.
  - **Validation:**
    - `npm run build`
    - `npm run lint`
    - `npx tsc --noEmit`
  - **Expected evidence:** Build, lint, and typecheck command output showing successful exit.

- [ ] T002 — Implement SQLite persistence layer
  - **Scope:** `src/db.ts`, `src/repository.ts`, `test/repository.test.ts`
  - **Change:** Add a SQLite-backed store that creates the items table on startup and exposes CRUD and quantity operations.
  - **Covers:** R-006
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: Items table with id, name, unique SKU, and quantity is created if absent on startup.
    - AC-T002-02: Records written through the repository are readable after reopening the database file.
    - AC-T002-03: Repository unit tests pass.
  - **Validation:**
    - `npm test`
    - `npx tsc --noEmit`
  - **Expected evidence:** Test output showing repository persistence tests passing.

## Phase 2: Inventory domain logic

**Phase ID:** P02
**Goal:** Implement item CRUD, stock adjustment, and validation rules.
**Depends on:** P01
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T003 — Implement item create, list, update, delete
  - **Scope:** `src/service/items.ts`, `test/items.test.ts`
  - **Change:** Add a service exposing createItem, listItems, getItem, updateItem, and deleteItem over the repository.
  - **Covers:** R-001, R-002, R-003, R-004
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T003-01: Creating an item with name, unique SKU, and non-negative integer quantity returns the stored item.
    - AC-T003-02: Listing returns all stored items including current quantity.
    - AC-T003-03: Updating descriptive fields of an existing item persists the change.
    - AC-T003-04: Deleting an existing item removes it from subsequent listings.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** Test output showing item CRUD unit tests passing.

- [ ] T004 — Implement stock adjustment with validation
  - **Scope:** `src/errors.ts`, `src/service/stock.ts`, `test/stock.test.ts`
  - **Change:** Add adjustStock applying an integer delta and rejecting adjustments that would drive quantity negative or target unknown items.
  - **Covers:** R-005, R-007
  - **Depends on:** T003
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T004-01: A positive delta increases the stored quantity by that amount.
    - AC-T004-02: A negative delta that would make quantity negative is rejected and quantity is unchanged.
    - AC-T004-03: Adjusting an unknown item raises a not-found error.
    - AC-T004-04: Duplicate SKU and non-integer or negative quantity inputs raise validation errors.
  - **Validation:**
    - `npm test`
    - `npx tsc --noEmit`
  - **Expected evidence:** Test output showing stock adjustment and validation error tests passing.

## Phase 3: HTTP REST surface

**Phase ID:** P03
**Goal:** Expose the inventory service as a JSON REST API with structured errors.
**Depends on:** P02
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T005 — Implement REST endpoints
  - **Scope:** `src/routes.ts`, `src/server.ts`, `test/routes.test.ts`
  - **Change:** Add HTTP routes for POST /items, GET /items, GET /items/:id, PATCH /items/:id, DELETE /items/:id, and POST /items/:id/adjust.
  - **Covers:** R-001, R-002, R-003, R-004, R-005
  - **Depends on:** T004
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T005-01: Each endpoint returns JSON and the documented success status code.
    - AC-T005-02: Request bodies are parsed and delegated to the inventory service.
    - AC-T005-03: Route-level tests exercising every endpoint pass.
  - **Validation:**
    - `npm test`
    - `npm run build`
  - **Expected evidence:** Test output showing route tests passing for all six endpoints.

- [ ] T006 — Map domain errors to structured HTTP responses
  - **Scope:** `src/middleware/errors.ts`, `test/errors.test.ts`
  - **Change:** Add error middleware translating validation errors to 400 and not-found errors to 404 with a JSON code and message body.
  - **Covers:** R-007
  - **Depends on:** T005
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T006-01: Invalid input returns HTTP 400 with a JSON body containing code and message.
    - AC-T006-02: Unknown item references return HTTP 404 with a JSON body containing code and message.
    - AC-T006-03: No unhandled error leaks a stack trace in the response body.
  - **Validation:**
    - `npm test`
    - `npm run lint`
  - **Expected evidence:** Test output showing 400 and 404 structured error response tests passing.

- [ ] T007 — Document run and usage instructions
  - **Scope:** `README.md`
  - **Change:** Write a README covering install, build, run, database file location, and example requests for each endpoint.
  - **Covers:** R-006, R-007
  - **Depends on:** T006
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T007-01: README lists install, build, test, and start commands.
    - AC-T007-02: README shows an example request and response for every endpoint.
    - AC-T007-03: README states where the SQLite database file is stored.
  - **Validation:**
    - manual: Read README.md and confirm it documents all commands, every endpoint example, and the database file location.
  - **Expected evidence:** README.md containing command list, endpoint examples, and database file path.

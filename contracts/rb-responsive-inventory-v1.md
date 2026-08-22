# RB Responsive Inventory Contract v1

`rb-responsive-inventory/v1` makes responsive-review accounting falsifiable. A
review may keep a readable `RESPONSIVE_INVENTORY.md`, but UI-bearing reviews
also write `RESPONSIVE_INVENTORY.json` beside it and validate that JSON before
finalization.

The contract is platform, framework, language, and layout-system neutral. The
reviewer first discovers the target's own layout vocabulary, then records the
result of analyzing each high-risk parent/child topology candidate.

## Accounting

Both `uiFiles` and `layoutCandidates` obey:

```text
discovered = analyzed + excluded + unresolved = entries.length
```

A path-only list is not analyzed evidence. Every candidate entry records:

- stable ID, source path, mechanism, and source references with roles;
- the invariants actually checked;
- each relevant layout state with parent constraint, child requirement,
  relationship, and compatibility assessment;
- a disposition and rationale;
- finding IDs for confirmed or likely defects;
- limitations for unknown or false-positive-risk candidates.

Candidate dispositions are `CONFIRMED_DEFECT`, `LIKELY_DEFECT`,
`ANALYZED_SAFE`, `FALSE_POSITIVE_RISK`, `EXCLUDED`, and `UNKNOWN`. Only the last
two count as excluded or unresolved; all other dispositions count as analyzed.

The file inventory links candidate IDs to their owning source path. Every
candidate appears exactly once in that linkage. Discovery commands or parsers,
their purpose, and their limitations are retained so another reviewer can
repeat or challenge the denominator.

## Non-UI targets

Reviews without any UI/layout surface use `applicability: NOT_APPLICABLE` and a
grounded reason. They do not invent zero-count responsive coverage.

## Validation

```bash
node <plugin-root>/scripts/rb-harness.cjs review validate-responsive \
  .rb/reviews/<review-id>/RESPONSIVE_INVENTORY.json
```

`tree validate` also validates the contract, its review-directory identity,
finding references, and the required JSON companion whenever a narrative
`RESPONSIVE_INVENTORY.md` exists.

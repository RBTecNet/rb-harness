# Responsive Evidence

Use this reference for every UI-bearing review. Adapt it to the target's actual
platform, layout system, supported devices, and available safe tooling. Do not
assume web, CSS, a framework, or fixed universal viewport sizes.

## Coverage model

Build a surface-by-layout-state matrix before making broad claims. Include the
materially distinct shells, pages, dialogs, drawers, forms, tables, navigation,
and long or conditional regions. Derive narrow, intermediate, wide, zoomed,
orientation, window, or device states from the product's declared support and
discovered breakpoints. Record what was statically inspected, exercised at
runtime, visually inspected, skipped, or blocked.

Depth changes evidence depth, not accounting honesty:

- `quick` may sample static candidates, but must publish the complete discovered
  UI-file denominator, the sampled numerator, and explicit unreviewed coverage;
  it cannot emit a broad responsive clean result.
- `balanced` must mechanically inventory all first-party UI source files and all
  discoverable layout declarations. It must inspect every candidate returned by
  the high-risk topology queries below or preserve each unresolved candidate and
  path as `UNKNOWN`. It need not manually read every non-candidate line.
- `deep` includes the balanced static inventory and adds broader runtime,
  computed-layout, visual, state, content, and assistive-technology evidence
  where safe. Runtime unavailability never reduces the balanced static duty.

## Reconciled static inventory

Use these terms consistently:

- a **layout declaration** is a mechanically discovered container, placement,
  sizing, overflow, wrapping, or positioning instruction;
- a **high-risk candidate** is one parent/child or nested-region relationship
  selected by a topology invariant for inspection;
- a **candidate path** is only provenance. A path is not itself an analyzed
  candidate and cannot be counted as one.

Before sampling screens or making findings, discover the target's actual UI
boundaries from routes or screen registries, template/component directories,
design-system sources, style/build configuration, and UI tests. Exclude generated
or third-party code explicitly. Record paths and counts by materially distinct
surface kind; do not let the reviewer self-select only familiar pages, tables,
or above-the-fold regions.

Discover the project's own layout vocabulary and responsive semantics from
source, configuration, generated-style inputs, and authoritative local
documentation. Then use broad mechanical search or parsing across the complete
first-party UI inventory to extract container declarations and the placement or
sizing constraints of their owned children. Do not hard-code one framework's
class names as the production rule.

Evaluate each discovered layout state for at least these general invariants:

- child span, line, area, or placement requirements exceeding the parent's
  declared tracks and therefore creating or depending on implicit tracks;
- base/unconditional child constraints that are incompatible with the base
  container and are repaired only at a wider or later layout state;
- fixed or intrinsic minimum sizes that exceed available container space;
- non-wrapping flex or row layouts whose children cannot shrink or reflow;
- absolute, fixed, sticky, overlay, and nested-scroll relationships that can
  clip, overlap, obscure, or make actions unreachable.

Resolve statically knowable topology instead of deferring it merely because a
runtime session is unavailable. When the active base parent and owned-child
constraints are known, a child placement/span that exceeds the parent's base
tracks is direct static evidence of an implicit-track dependency. Classify the
relationship from those semantics after checking same-state overrides and
generated/custom configuration. Runtime remains useful for impact and geometry,
but its absence does not turn known incompatible source constraints into a
generic runtime UNKNOWN.

Run and record negative-control queries for every discovered mechanism rather
than stopping after the first useful pattern. A fixed-width search, for example,
does not cover track/span topology. Trace reusable components and dynamic layout
composition far enough to determine their effective parent/child constraints;
when static resolution is not possible, keep the candidate unresolved.

Publish a responsive static-inventory reconciliation with at least:

- first-party UI files discovered, inspected, excluded, and unresolved;
- layout containers/candidates discovered, analyzed, excluded, and unresolved;
- surface kinds and layout mechanisms covered;
- candidate paths or a provenance-linked artifact containing them;
- the commands/parsers used and their limitations.

For every UI-bearing review, write
`.rb/reviews/<review-id>/RESPONSIVE_INVENTORY.json` conforming to
`rb-responsive-inventory/v1`. Every high-risk candidate needs its own stable
entry containing source references for the parent/child/config relationship,
the invariants actually checked, explicit active layout-state assessments,
disposition, rationale, limitations when unresolved, and finding IDs when it is
a confirmed or likely defect. Link every candidate exactly once from its owning
UI-file entry. A readable Markdown summary is optional; a bare path list never
satisfies this evidence duty.

The counts must reconcile: discovered equals analyzed plus excluded plus
unresolved for both files and candidates. Missing or inconsistent reconciliation
is incomplete review evidence and must be returned to the inspector before the
writer can finalize artifacts. Run `review validate-responsive` against the JSON;
do not infer successful reconciliation from prose or self-reported totals.

Inspect parent and child constraints as a system at every active layout state:

- declared and implicit grid tracks, placement, spans, gaps, and ordering;
- flex basis, wrapping, shrink/grow behavior, minimum intrinsic sizes, and
  `min`/`max` constraints;
- fixed, absolute, sticky, and overlay positioning, stacking, scroll ownership,
  safe areas, and viewport metadata;
- clipping and overflow at the page and nested-region levels;
- text wrapping, localization, long values, validation messages, dynamic
  content, loading/empty/error states, and enlarged text or zoom;
- reachable actions, visible focus, keyboard or equivalent navigation, and
  headers/footers that do not obscure focused or editable content.

A child that requires more tracks or space than its parent supplies is a
candidate even when no literal fixed width exists. Absence of page-level
horizontal overflow does not rule out implicit tracks, overlap, clipping,
unreadably compressed controls, or a broken nested scroller.

## Runtime and visual evidence

When safe runtime UI inspection is available, exercise representative complete
journeys rather than only opening the surface:

1. Enter each material layout state and open the relevant dynamic surface.
2. Traverse or scroll through its full extent, including conditional and
   below-the-fold groups.
3. Exercise representative empty, populated, long-content, validation, loading,
   error, and success states when they can change geometry.
4. Capture observable geometry appropriate to the platform: element/container
   bounds, overlap intersections, clipping, nested and page overflow, usable
   control dimensions, obscured focus/actions, or an equivalent native measure.
5. Capture full-surface or section evidence with target revision, layout state,
   route/journey, data/state, tooling provenance, and evidence provenance.

Visibility, attachment, clickability, or a screenshot of only the initial
viewport is not proof that the remainder is usable. Prefer behavioral and
geometry assertions over snapshot existence. Derive usable-size thresholds from
the product's design system, platform guidance, content, or control semantics;
do not invent a universal pixel threshold.

Treat old, unversioned, cropped, or provenance-free screenshots as leads. They
may corroborate current evidence but cannot establish a current clean result.
If fresh evidence cannot be collected, preserve the responsive area as partial
or `UNKNOWN` instead of silently treating it as covered.

## Claim calibration

Match every positive or clean-negative responsive statement to the matrix rows
and evidence that falsify it. Scope conclusions narrowly, for example to the
surfaces and layout states actually checked. A whole-product clean conclusion
requires representative coverage of all materially distinct layout systems and
complete interactive surfaces.

Classify a defect as `CONFIRMED` when current static semantics or runtime
geometry directly demonstrate it and the relevant configuration is known.
Use `LIKELY`, `UNKNOWN`, or `FALSE_POSITIVE_RISK` when generated styles, custom
breakpoints, runtime composition, platform behavior, or missing evidence could
change the result. Never infer a clean result from a search that only detects
one failure mechanism such as fixed widths.

## Remediation evidence

For a selected responsive finding, generated execution criteria must preserve a
falsifiable pre-fix case and prove the affected complete surface at both the
failing layout state and a representative wider state. Require observable
non-overlap, containment, usable controls, reachable actions, and correct scroll
ownership as relevant. Keep visual evidence supplementary unless the target has
a trustworthy visual-regression gate with a current baseline.

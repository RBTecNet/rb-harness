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

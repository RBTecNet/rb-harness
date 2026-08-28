# Evolution Artifact Shapes — Compatibility Notice

This legacy resource no longer defines artifact names, paths, requiredness, or
ownership. The orchestrator injects the code-owned canonical workflow authority
rendered from `WORKFLOW_DEFINITIONS`; that injected section is the sole runtime
contract for evolve outputs.

Keep this file only so existing packaged-resource paths remain readable. Do not
derive output requirements from older copies of this resource.

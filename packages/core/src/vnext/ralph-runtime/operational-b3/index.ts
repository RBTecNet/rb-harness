/**
 * Ralph Operational Core V2 — Milestone 1 admission boundary.
 *
 * This barrel exposes only immutable authorization artifacts and the Core
 * orchestration that stops at executor.dispatch-authorized.  It has no
 * executor, provider, subprocess, validation, evidence, or audit capability.
 */
export * from "./artifacts.js";
export * from "./admission.js";

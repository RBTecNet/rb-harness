import type { ValidationIssue } from "./types.js";

export interface OperationalValidation {
  valid: boolean;
  issues: ValidationIssue[];
  document?: Record<string, unknown>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ValidationIssue[], code: string, message: string, path: string): void {
  issues.push({ code, message, severity: "error", path });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], issues: ValidationIssue[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issue(issues, "operational.property.unknown", `Unknown property ${key}`, `${path}.${key}`);
  }
}

function stringArray(value: unknown, issues: ValidationIssue[], path: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    issue(issues, "operational.array.strings", "Expected an array of strings", path);
  }
}

function command(value: unknown, issues: ValidationIssue[], path: string): void {
  if (!object(value)) {
    issue(issues, "operational.command", "Command must be an object", path);
    return;
  }
  onlyKeys(value, ["argv", "cwd", "env"], issues, path);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((entry) => !nonEmpty(entry))) {
    issue(issues, "operational.command.argv", "Command argv must be a non-empty string array", `${path}.argv`);
  }
  if (value.cwd !== undefined && !nonEmpty(value.cwd)) issue(issues, "operational.command.cwd", "Command cwd must be a non-empty string", `${path}.cwd`);
  if (value.env !== undefined && !object(value.env)) issue(issues, "operational.command.env", "Command env must be an object", `${path}.env`);
  else if (object(value.env) && Object.values(value.env).some((entry) => !["string", "number", "boolean"].includes(typeof entry))) {
    issue(issues, "operational.command.env", "Command env values must be strings, numbers, or booleans", `${path}.env`);
  }
}

function positiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function probe(value: unknown, issues: ValidationIssue[], path: string, topLevel = false): void {
  if (!object(value)) {
    issue(issues, "operational.probe", "Probe must be an object", path);
    return;
  }
  if (topLevel && !nonEmpty(value.id)) issue(issues, "operational.step.id", "Step id is required", `${path}.id`);
  switch (value.kind) {
    case "http":
      onlyKeys(value, [...(topLevel ? ["id"] : []), "kind", "url", "method", "body", "headers", "status", "bodyIncludes", "timeoutSeconds"], issues, path);
      if (!nonEmpty(value.url)) issue(issues, "operational.http.url", "HTTP url is required", `${path}.url`);
      if (value.status !== undefined && !Number.isInteger(value.status)) issue(issues, "operational.http.status", "HTTP status must be an integer", `${path}.status`);
      if (value.bodyIncludes !== undefined) stringArray(value.bodyIncludes, issues, `${path}.bodyIncludes`);
      if (value.headers !== undefined && !object(value.headers)) issue(issues, "operational.http.headers", "HTTP headers must be an object", `${path}.headers`);
      break;
    case "tcp":
      onlyKeys(value, [...(topLevel ? ["id"] : []), "kind", "host", "port", "timeoutSeconds"], issues, path);
      if (!nonEmpty(value.host)) issue(issues, "operational.tcp.host", "TCP host is required", `${path}.host`);
      if (!Number.isInteger(value.port) && !nonEmpty(value.port)) issue(issues, "operational.tcp.port", "TCP port must be an integer or interpolated string", `${path}.port`);
      break;
    case "file":
      onlyKeys(value, [...(topLevel ? ["id"] : []), "kind", "path", "exists", "includes"], issues, path);
      if (!nonEmpty(value.path)) issue(issues, "operational.file.path", "File path is required", `${path}.path`);
      if (value.exists !== undefined && typeof value.exists !== "boolean") issue(issues, "operational.file.exists", "File exists must be boolean", `${path}.exists`);
      break;
    case "stdout":
      if (topLevel) issue(issues, "operational.step.kind", "stdout is only a process probe", `${path}.kind`);
      onlyKeys(value, ["kind", "includes"], issues, path);
      if (!nonEmpty(value.includes)) issue(issues, "operational.stdout.includes", "stdout includes is required", `${path}.includes`);
      break;
    default:
      issue(issues, "operational.probe.kind", "Probe kind must be http, tcp, file, or stdout", `${path}.kind`);
  }
  if (value.timeoutSeconds !== undefined && !positiveInteger(value.timeoutSeconds)) {
    issue(issues, "operational.timeout", "Probe timeoutSeconds must be a positive integer", `${path}.timeoutSeconds`);
  }
}

function step(value: unknown, issues: ValidationIssue[], path: string): void {
  if (!object(value)) {
    issue(issues, "operational.step", "Step must be an object", path);
    return;
  }
  if (!nonEmpty(value.id)) issue(issues, "operational.step.id", "Step id is required", `${path}.id`);
  if (value.kind === "command") {
    onlyKeys(value, ["id", "kind", "command", "timeoutSeconds", "expect"], issues, path);
    command(value.command, issues, `${path}.command`);
    if (value.timeoutSeconds !== undefined && (!Number.isInteger(value.timeoutSeconds) || Number(value.timeoutSeconds) < 0)) {
      issue(issues, "operational.timeout", "Command timeoutSeconds must be a non-negative integer", `${path}.timeoutSeconds`);
    }
    if (value.expect !== undefined) {
      if (!object(value.expect)) issue(issues, "operational.expect", "Command expect must be an object", `${path}.expect`);
      else {
        onlyKeys(value.expect, ["exitCode", "stdoutIncludes", "stderrIncludes"], issues, `${path}.expect`);
        if (value.expect.exitCode !== undefined && !Number.isInteger(value.expect.exitCode)) issue(issues, "operational.expect.exit", "Expected exitCode must be an integer", `${path}.expect.exitCode`);
        if (value.expect.stdoutIncludes !== undefined) stringArray(value.expect.stdoutIncludes, issues, `${path}.expect.stdoutIncludes`);
        if (value.expect.stderrIncludes !== undefined) stringArray(value.expect.stderrIncludes, issues, `${path}.expect.stderrIncludes`);
      }
    }
  } else if (value.kind === "process") {
    onlyKeys(value, ["id", "kind", "command", "ready", "readyTimeoutSeconds", "checks"], issues, path);
    command(value.command, issues, `${path}.command`);
    probe(value.ready, issues, `${path}.ready`);
    if (value.readyTimeoutSeconds !== undefined && !positiveInteger(value.readyTimeoutSeconds)) issue(issues, "operational.timeout", "Process readyTimeoutSeconds must be a positive integer", `${path}.readyTimeoutSeconds`);
    if (value.checks !== undefined) {
      if (!Array.isArray(value.checks)) issue(issues, "operational.process.checks", "Process checks must be an array", `${path}.checks`);
      else value.checks.forEach((entry, index) => probe(entry, issues, `${path}.checks[${index}]`));
    }
  } else if (["http", "tcp", "file", "stdout"].includes(String(value.kind))) {
    probe(value, issues, path, true);
  } else {
    issue(issues, "operational.step.kind", "Step kind must be command, process, http, tcp, or file", `${path}.kind`);
  }
}

/** Loopback hosts a scenario can only reach through a process it started itself. */
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]", "0.0.0.0", "::1"];

function localTarget(probe: Record<string, unknown>): string | undefined {
  if (probe.kind === "http" && nonEmpty(probe.url)) {
    const url = probe.url;
    const local = LOCAL_HOSTS.some((entry) => url.includes(`//${entry}:`) || url.includes(`//${entry}/`));
    return local ? url : undefined;
  }
  if (probe.kind === "tcp" && nonEmpty(probe.host) && LOCAL_HOSTS.includes(probe.host)) {
    return `${probe.host}:${String(probe.port ?? "")}`;
  }
  return undefined;
}

/**
 * A local endpoint is only reachable while the process serving it is alive.
 *
 * The verifier starts a `process` step, waits for `ready`, runs that step's own
 * `checks`, and then stops the process in a `finally`. A sibling `http`/`tcp`
 * step placed after it therefore runs against a closed port, and one placed in
 * a scenario with no `process` step at all never had a server to talk to.
 *
 * Both shapes pass every structural rule and can never pass execution. An
 * observed run spent nine attempts and five hours on exactly this: the executor
 * cannot repair the contract, because generated specifications are read-only to
 * it, so the phase could only fail until the circuit breaker paused the run.
 */
function reachableService(steps: unknown[], issues: ValidationIssue[], path: string): void {
  steps.forEach((entry, index) => {
    if (!object(entry)) return;
    const target = localTarget(entry);
    if (!target) return;
    const owner = steps.slice(0, index).find((candidate) => object(candidate) && candidate.kind === "process");
    issue(
      issues,
      "operational.step.unreachable-service",
      owner
        ? `Step ${String(entry.id ?? index)} probes ${target}, but the process started by step `
          + `${String((owner as Record<string, unknown>).id ?? "")} is stopped when its own step ends. `
          + "Move this assertion into that step's checks array."
        : `Step ${String(entry.id ?? index)} probes ${target}, but no earlier step starts a process to serve it. `
          + "Add a process step and put this assertion in its checks array.",
      `${path}.steps[${index}]`,
    );
  });
}

export function validateOperationalValue(value: unknown): OperationalValidation {
  const issues: ValidationIssue[] = [];
  if (!object(value)) {
    issue(issues, "operational.root", "Operational contract root must be an object", "$");
    return { valid: false, issues };
  }
  onlyKeys(value, ["contract", "cleanRoom", "environment", "scenarios"], issues, "$");
  if (value.contract !== "rb-operational/v1") issue(issues, "operational.contract", "contract must be rb-operational/v1", "$.contract");
  if (value.cleanRoom !== undefined) {
    if (!object(value.cleanRoom)) issue(issues, "operational.clean-room", "cleanRoom must be an object", "$.cleanRoom");
    else {
      onlyKeys(value.cleanRoom, ["exclude"], issues, "$.cleanRoom");
      if (value.cleanRoom.exclude !== undefined) stringArray(value.cleanRoom.exclude, issues, "$.cleanRoom.exclude");
    }
  }
  if (value.environment !== undefined) {
    if (!object(value.environment)) issue(issues, "operational.environment", "environment must be an object", "$.environment");
    else {
      onlyKeys(value.environment, ["inherit", "set"], issues, "$.environment");
      if (value.environment.inherit !== undefined) stringArray(value.environment.inherit, issues, "$.environment.inherit");
      if (value.environment.set !== undefined && !object(value.environment.set)) issue(issues, "operational.environment.set", "environment.set must be an object", "$.environment.set");
      else if (object(value.environment.set) && Object.values(value.environment.set).some((entry) => !["string", "number", "boolean"].includes(typeof entry))) {
        issue(issues, "operational.environment.set", "environment.set values must be strings, numbers, or booleans", "$.environment.set");
      }
    }
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    issue(issues, "operational.scenarios", "scenarios must be a non-empty array", "$.scenarios");
  } else {
    const scenarioIds = new Set<string>();
    value.scenarios.forEach((scenario, scenarioIndex) => {
      const path = `$.scenarios[${scenarioIndex}]`;
      if (!object(scenario)) {
        issue(issues, "operational.scenario", "Scenario must be an object", path);
        return;
      }
      onlyKeys(scenario, ["id", "title", "platforms", "steps"], issues, path);
      if (!nonEmpty(scenario.id)) issue(issues, "operational.scenario.id", "Scenario id is required", `${path}.id`);
      else if (scenarioIds.has(scenario.id)) issue(issues, "operational.scenario.id.duplicate", `Duplicate scenario id ${scenario.id}`, `${path}.id`);
      else scenarioIds.add(scenario.id);
      if (!nonEmpty(scenario.title)) issue(issues, "operational.scenario.title", "Scenario title is required", `${path}.title`);
      if (scenario.platforms !== undefined && (!Array.isArray(scenario.platforms) || scenario.platforms.some((entry) => !["linux", "darwin", "win32"].includes(String(entry))))) {
        issue(issues, "operational.scenario.platforms", "Platforms may contain only linux, darwin, or win32", `${path}.platforms`);
      }
      if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) issue(issues, "operational.scenario.steps", "Scenario steps must be a non-empty array", `${path}.steps`);
      else {
        const stepIds = new Set<string>();
        scenario.steps.forEach((entry, index) => {
          step(entry, issues, `${path}.steps[${index}]`);
          if (object(entry) && nonEmpty(entry.id)) {
            if (stepIds.has(entry.id)) issue(issues, "operational.step.id.duplicate", `Duplicate step id ${entry.id}`, `${path}.steps[${index}].id`);
            stepIds.add(entry.id);
          }
        });
        reachableService(scenario.steps, issues, path);
      }
    });
  }
  return { valid: issues.length === 0, issues, ...(issues.length === 0 ? { document: value } : {}) };
}

export function validateOperationalJson(source: string): OperationalValidation {
  try {
    return validateOperationalValue(JSON.parse(source));
  } catch (error) {
    return {
      valid: false,
      issues: [{ code: "operational.json", message: error instanceof Error ? error.message : String(error), severity: "error", path: "$" }],
    };
  }
}

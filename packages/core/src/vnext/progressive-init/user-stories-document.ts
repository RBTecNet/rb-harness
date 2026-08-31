import {
  USER_STORIES_CONTRACT,
  canonicalizeUserStories,
  userStoriesSemanticSha256,
  validateUserStories,
  type UserStories,
  type UserStoriesAuthority,
  type UserStoriesDetermination,
  type UserStoriesCapabilityParticipation,
  type UserStoriesFinding,
  type UserStoriesUpstreamProjection,
  type UserStory,
} from "./user-stories-ir.js";
import { semanticKey, type SemanticKey } from "../identity.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface UserStoriesDocumentMetadata {
  readonly stage: "user-stories";
  readonly contract: typeof USER_STORIES_CONTRACT;
  readonly completion: "complete";
  readonly upstreamProjectionSha256: string;
  readonly authoritativeInputSha256: string;
  readonly baselineSemanticSha256: string;
}

export interface ParsedUserStoriesDocument {
  readonly metadata: UserStoriesDocumentMetadata;
  readonly value: UserStories;
  readonly semanticSha256: string;
  readonly developerModified: boolean;
  readonly upstreamCompatibilityFindings: readonly UserStoriesFinding[];
}

export class UserStoriesDocumentError extends Error {
  constructor(message: string) {
    super(`USER_STORIES_DOCUMENT_INVALID: ${message}`);
    this.name = "UserStoriesDocumentError";
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function renderUserStoriesDocument(
  input: UserStories,
  upstream: UserStoriesUpstreamProjection,
  metadata: Omit<UserStoriesDocumentMetadata, "stage" | "contract" | "completion" | "baselineSemanticSha256">,
): string {
  const validated = validateUserStories(input, upstream);
  if (!validated.ok) throw new UserStoriesDocumentError(validated.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  const value = canonicalizeUserStories(validated.value);
  const semanticSha256 = userStoriesSemanticSha256(value);
  const lines = [
    "<!-- rb-progressive-init-stage: user-stories -->",
    `<!-- rb-user-stories-contract: ${USER_STORIES_CONTRACT} -->`,
    "<!-- rb-user-stories-completion: complete -->",
    `<!-- rb-user-stories-upstream-projection-sha256: ${metadata.upstreamProjectionSha256} -->`,
    `<!-- rb-user-stories-authoritative-input-sha256: ${metadata.authoritativeInputSha256} -->`,
    `<!-- rb-user-stories-baseline-semantic-sha256: ${semanticSha256} -->`,
    "",
    "# User Stories",
    "",
    `Project: ${json(value.projectKey)}`,
    "",
    "## Determinations",
    "",
  ];
  if (!value.determinations.length) lines.push("_None._", "");
  else {
    for (const determination of value.determinations) {
      lines.push(
        `### Determination ${determination.key}`,
        "",
        `Statement: ${json(determination.statement)}`,
        `Rationale: ${json(determination.rationale)}`,
        `Materiality: ${determination.materiality}`,
        `Rigidity: ${determination.rigidity}`,
        `Source: ${json(determination.source)}`,
        "",
      );
    }
  }
  lines.push("## Structural Decisions", "");
  if (!value.structuralDecisions.length) lines.push("_None._", "");
  else {
    for (const decision of value.structuralDecisions) {
      lines.push(
        `### Capability Participation \`${decision.key}\``,
        "",
        `Workflow: \`${decision.workflowKey}\``,
        `Capability: \`${decision.capabilityKey}\``,
        `Actor: \`${decision.actorKey}\``,
        `Operator: \`${decision.operatorActorKey}\``,
        `Source: ${json(decision.source)}`,
        "",
      );
    }
  }
  const workflows = new Map<SemanticKey, UserStory[]>();
  for (const story of value.stories) {
    const entries = workflows.get(story.workflowKey) ?? [];
    entries.push(story);
    workflows.set(story.workflowKey, entries);
  }
  for (const [, stories] of workflows) {
    const workflowKey = stories[0]!.workflowKey;
    lines.push(`## Workflow ${workflowKey}`, "");
    for (const story of stories) {
      lines.push(
        `### ${story.storyId} — ${story.key}`,
        "",
        `Actor: ${json(story.actorKey)}`,
        `Operator: ${json(story.operatorActorKey)}`,
        `Capabilities: ${json(story.capabilityKeys)}`,
        `Intent: ${json(story.intent)}`,
        `Outcome: ${json(story.outcome)}`,
        `Acceptance: ${json(story.acceptance)}`,
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

class Cursor {
  index = 0;
  constructor(readonly lines: readonly string[]) {}
  take(): string {
    const value = this.lines[this.index];
    if (value === undefined) throw new UserStoriesDocumentError("unexpected end of file");
    this.index += 1;
    return value;
  }
  expect(expected: string): void {
    const actual = this.take();
    if (actual !== expected) throw new UserStoriesDocumentError(`expected ${JSON.stringify(expected)} at line ${this.index}, received ${JSON.stringify(actual)}`);
  }
  peek(): string | undefined { return this.lines[this.index]; }
}

function comment(cursor: Cursor, name: string): string {
  const line = cursor.take();
  const match = new RegExp(`^<!-- ${name}: (.+) -->$`).exec(line);
  if (!match?.[1]) throw new UserStoriesDocumentError(`invalid ${name} metadata at line ${cursor.index}`);
  return match[1];
}

function hashComment(cursor: Cursor, name: string): string {
  const value = comment(cursor, name);
  if (!SHA256.test(value)) throw new UserStoriesDocumentError(`${name} must be a lowercase SHA-256`);
  return value;
}

function jsonString(line: string, label: string, lineNumber: number): string {
  if (!line.startsWith(`${label}: `)) throw new UserStoriesDocumentError(`expected ${label} at line ${lineNumber}`);
  let value: unknown;
  try { value = JSON.parse(line.slice(label.length + 2)); }
  catch { throw new UserStoriesDocumentError(`${label} must contain one valid JSON string at line ${lineNumber}`); }
  if (typeof value !== "string") throw new UserStoriesDocumentError(`${label} must contain one JSON string at line ${lineNumber}`);
  return value;
}

function jsonStrings(line: string, label: string, lineNumber: number): readonly string[] {
  if (!line.startsWith(`${label}: `)) throw new UserStoriesDocumentError(`expected ${label} at line ${lineNumber}`);
  let value: unknown;
  try { value = JSON.parse(line.slice(label.length + 2)); }
  catch { throw new UserStoriesDocumentError(`${label} must contain one valid JSON string array at line ${lineNumber}`); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new UserStoriesDocumentError(`${label} must contain one JSON string array at line ${lineNumber}`);
  }
  return value as readonly string[];
}

function keyFromJson(line: string, label: string, lineNumber: number): SemanticKey {
  const value = jsonString(line, label, lineNumber);
  const key = semanticKey(value);
  if (!key) throw new UserStoriesDocumentError(`${label} must contain one canonical SemanticKey at line ${lineNumber}`);
  return key;
}

function keyFromTicks(line: string, label: string, lineNumber: number): SemanticKey {
  const match = new RegExp("^" + label + ": `([^`]+)`$").exec(line);
  const key = match?.[1] ? semanticKey(match[1]) : undefined;
  if (!key) throw new UserStoriesDocumentError(`${label} must contain one canonical SemanticKey at line ${lineNumber}`);
  return key;
}

function developerAuthority(line: string, lineNumber: number): UserStoriesAuthority {
  if (!line.startsWith("Source: ")) throw new UserStoriesDocumentError(`expected Source at line ${lineNumber}`);
  let value: unknown;
  try { value = JSON.parse(line.slice("Source: ".length)); }
  catch { throw new UserStoriesDocumentError(`Source must contain one valid JSON authority object at line ${lineNumber}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserStoriesDocumentError(`Source must be an authority object at line ${lineNumber}`);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 1 || source.kind !== "developer") {
    throw new UserStoriesDocumentError(`persisted Source must be developer authority at line ${lineNumber}`);
  }
  return { kind: "developer" };
}

export function parseUserStoriesDocument(
  source: string,
  upstream: UserStoriesUpstreamProjection,
  options: { readonly allowUncoveredWorkflows?: boolean } = {},
): ParsedUserStoriesDocument {
  const normalized = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (normalized.includes("\r")) throw new UserStoriesDocumentError("bare carriage returns are not allowed");
  const lines = normalized.split("\n");
  const cursor = new Cursor(lines);
  if (comment(cursor, "rb-progressive-init-stage") !== "user-stories") throw new UserStoriesDocumentError("stage metadata must be user-stories");
  if (comment(cursor, "rb-user-stories-contract") !== USER_STORIES_CONTRACT) throw new UserStoriesDocumentError(`contract must be ${USER_STORIES_CONTRACT}`);
  if (comment(cursor, "rb-user-stories-completion") !== "complete") throw new UserStoriesDocumentError("completion metadata must be complete");
  const upstreamProjectionSha256 = hashComment(cursor, "rb-user-stories-upstream-projection-sha256");
  const authoritativeInputSha256 = hashComment(cursor, "rb-user-stories-authoritative-input-sha256");
  const baselineSemanticSha256 = hashComment(cursor, "rb-user-stories-baseline-semantic-sha256");
  cursor.expect("");
  cursor.expect("# User Stories");
  cursor.expect("");
  const projectKey = keyFromJson(cursor.take(), "Project", cursor.index);
  cursor.expect("");
  cursor.expect("## Determinations");
  cursor.expect("");
  const determinations: UserStoriesDetermination[] = [];
  if (cursor.peek() === "_None._") {
    cursor.take();
    cursor.expect("");
  } else {
    while (cursor.peek()?.startsWith("### Determination ")) {
      const heading = cursor.take();
      const key = semanticKey(heading.slice("### Determination ".length));
      if (!key) throw new UserStoriesDocumentError(`invalid determination heading at line ${cursor.index}`);
      cursor.expect("");
      const statement = jsonString(cursor.take(), "Statement", cursor.index);
      const rationale = jsonString(cursor.take(), "Rationale", cursor.index);
      const materialityLine = cursor.take();
      const materiality = materialityLine.slice("Materiality: ".length);
      if (!materialityLine.startsWith("Materiality: ") || !["product", "architecture", "implementation", "preference"].includes(materiality)) {
        throw new UserStoriesDocumentError(`invalid Materiality at line ${cursor.index}`);
      }
      const rigidityLine = cursor.take();
      const rigidity = rigidityLine.slice("Rigidity: ".length);
      if (!rigidityLine.startsWith("Rigidity: ") || !["RIGID", "FLEXIBLE"].includes(rigidity)) {
        throw new UserStoriesDocumentError(`invalid Rigidity at line ${cursor.index}`);
      }
      const sourceAuthority = developerAuthority(cursor.take(), cursor.index);
      cursor.expect("");
      determinations.push({
        key,
        statement,
        rationale,
        materiality: materiality as UserStoriesDetermination["materiality"],
        rigidity: rigidity as UserStoriesDetermination["rigidity"],
        source: sourceAuthority,
      });
    }
  }
  cursor.expect("## Structural Decisions");
  cursor.expect("");
  const structuralDecisions: UserStoriesCapabilityParticipation[] = [];
  if (cursor.peek() === "_None._") {
    cursor.take();
    cursor.expect("");
  } else {
    while (cursor.peek()?.startsWith("### Capability Participation ")) {
      const heading = cursor.take();
      const match = /^### Capability Participation `([^`]+)`$/.exec(heading);
      const key = match?.[1] ? semanticKey(match[1]) : undefined;
      if (!key) throw new UserStoriesDocumentError(`invalid Capability Participation heading at line ${cursor.index}`);
      cursor.expect("");
      const workflowKey = keyFromTicks(cursor.take(), "Workflow", cursor.index);
      const capabilityKey = keyFromTicks(cursor.take(), "Capability", cursor.index);
      const actorKey = keyFromTicks(cursor.take(), "Actor", cursor.index);
      const operatorActorKey = keyFromTicks(cursor.take(), "Operator", cursor.index);
      const sourceAuthority = developerAuthority(cursor.take(), cursor.index);
      cursor.expect("");
      structuralDecisions.push({
        kind: "capability-participation",
        key,
        workflowKey,
        capabilityKey,
        actorKey,
        operatorActorKey,
        source: sourceAuthority,
      });
    }
  }
  const stories: UserStory[] = [];
  const workflowHeadings = new Set<SemanticKey>();
  while (cursor.peek()?.startsWith("## Workflow ")) {
    const workflowHeading = cursor.take();
    const workflowKey = semanticKey(workflowHeading.slice("## Workflow ".length));
    if (!workflowKey) throw new UserStoriesDocumentError(`invalid workflow heading at line ${cursor.index}`);
    if (workflowHeadings.has(workflowKey)) throw new UserStoriesDocumentError(`duplicate workflow heading '${workflowKey}' at line ${cursor.index}`);
    workflowHeadings.add(workflowKey);
    cursor.expect("");
    let count = 0;
    while (cursor.peek()?.startsWith("### US-")) {
      const heading = cursor.take();
      const match = /^### (US-[1-9]\d*\.[1-9]\d*) — ([a-z][a-z0-9-]{1,47})$/.exec(heading);
      if (!match?.[1] || !match[2]) throw new UserStoriesDocumentError(`invalid story heading at line ${cursor.index}`);
      const key = semanticKey(match[2]);
      if (!key) throw new UserStoriesDocumentError(`invalid story SemanticKey at line ${cursor.index}`);
      cursor.expect("");
      const actorKey = keyFromJson(cursor.take(), "Actor", cursor.index);
      const operatorActorKey = keyFromJson(cursor.take(), "Operator", cursor.index);
      const capabilityKeys = jsonStrings(cursor.take(), "Capabilities", cursor.index).map((entry) => {
        const capabilityKey = semanticKey(entry);
        if (!capabilityKey) throw new UserStoriesDocumentError(`Capabilities contains an invalid SemanticKey at line ${cursor.index}`);
        return capabilityKey;
      });
      const intent = jsonString(cursor.take(), "Intent", cursor.index);
      const outcome = jsonString(cursor.take(), "Outcome", cursor.index);
      const acceptance = jsonStrings(cursor.take(), "Acceptance", cursor.index);
      if (cursor.peek() === "") cursor.take();
      stories.push({ key, storyId: match[1], workflowKey, capabilityKeys, actorKey, operatorActorKey, intent, outcome, acceptance });
      count += 1;
    }
    if (!count) throw new UserStoriesDocumentError(`workflow '${workflowKey}' must contain at least one story`);
  }
  if (cursor.index !== lines.length) throw new UserStoriesDocumentError(`unexpected content at line ${cursor.index + 1}`);
  const decoded: UserStories = { contract: USER_STORIES_CONTRACT, stage: "user-stories", projectKey, determinations, structuralDecisions, stories };
  const validated = validateUserStories(decoded, upstream, [], {
    requireWorkflowCoverage: options.allowUncoveredWorkflows !== true,
  });
  const findings = validated.ok ? [] : validated.findings;
  const upstreamCompatibilityFindings = findings.filter((entry) => entry.code === "upstream" || entry.code === "coverage");
  const intrinsicFindings = findings.filter((entry) => entry.code !== "upstream" && entry.code !== "coverage");
  if (intrinsicFindings.length) {
    throw new UserStoriesDocumentError(intrinsicFindings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; "));
  }
  const value = canonicalizeUserStories(decoded);
  const semanticSha256 = userStoriesSemanticSha256(value);
  return {
    metadata: {
      stage: "user-stories",
      contract: USER_STORIES_CONTRACT,
      completion: "complete",
      upstreamProjectionSha256,
      authoritativeInputSha256,
      baselineSemanticSha256,
    },
    value,
    semanticSha256,
    developerModified: semanticSha256 !== baselineSemanticSha256,
    upstreamCompatibilityFindings,
  };
}

import type {
  ResponsiveCandidate,
  ResponsiveInventoryDocument,
  ResponsiveInventoryValidation,
  ValidationIssue,
} from "./types.js";

const CONTRACT = "rb-responsive-inventory/v1" as const;
const DEPTHS = new Set(["quick", "balanced", "deep"]);
const FILE_DISPOSITIONS = new Set(["ANALYZED", "EXCLUDED", "UNKNOWN"]);
const CANDIDATE_DISPOSITIONS = new Set([
  "CONFIRMED_DEFECT",
  "LIKELY_DEFECT",
  "ANALYZED_SAFE",
  "FALSE_POSITIVE_RISK",
  "EXCLUDED",
  "UNKNOWN",
]);
const STATE_ASSESSMENTS = new Set(["COMPATIBLE", "INCOMPATIBLE", "UNKNOWN"]);

function issue(issues: ValidationIssue[], code: string, message: string): void {
  issues.push({ code, message, severity: "error" });
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty);
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function validateAccounting(
  issues: ValidationIssue[],
  prefix: string,
  section: Record<string, unknown>,
  actual: { analyzed: number; excluded: number; unresolved: number; total: number },
): void {
  for (const key of ["discovered", "analyzed", "excluded", "unresolved"] as const) {
    if (!nonNegativeInteger(section[key])) issue(issues, `${prefix}.${key}`, `${prefix}.${key} must be a non-negative integer`);
  }
  if (!["discovered", "analyzed", "excluded", "unresolved"].every((key) => nonNegativeInteger(section[key]))) return;
  const discovered = section.discovered as number;
  const analyzed = section.analyzed as number;
  const excluded = section.excluded as number;
  const unresolved = section.unresolved as number;
  if (discovered !== analyzed + excluded + unresolved) {
    issue(issues, `${prefix}.reconciliation`, `${prefix}: discovered must equal analyzed + excluded + unresolved`);
  }
  if (discovered !== actual.total || analyzed !== actual.analyzed || excluded !== actual.excluded || unresolved !== actual.unresolved) {
    issue(issues, `${prefix}.entries`, `${prefix} counts must equal the individually disposed entries`);
  }
}

function validateCandidate(issues: ValidationIssue[], candidate: Record<string, unknown>, index: number): void {
  const prefix = `responsive.candidates.entries[${index}]`;
  if (!nonEmpty(candidate.id) || !/^RC-[A-Z0-9][A-Z0-9-]*$/.test(candidate.id)) {
    issue(issues, `${prefix}.id`, "Candidate id must match RC-<STABLE-ID>");
  }
  for (const key of ["path", "mechanism", "rationale"] as const) {
    if (!nonEmpty(candidate[key])) issue(issues, `${prefix}.${key}`, `${key} is required`);
  }
  if (!CANDIDATE_DISPOSITIONS.has(String(candidate.disposition))) {
    issue(issues, `${prefix}.disposition`, "Unsupported candidate disposition");
  }
  if (!stringArray(candidate.invariantsChecked) || candidate.invariantsChecked.length === 0) {
    issue(issues, `${prefix}.invariants`, "Every candidate must name the invariants actually checked");
  } else if (!unique(candidate.invariantsChecked)) {
    issue(issues, `${prefix}.invariants.duplicate`, "Candidate invariantsChecked entries must be unique");
  }

  if (!Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length === 0) {
    issue(issues, `${prefix}.sourceRefs`, "Every candidate must cite parent/child/config source evidence");
  } else {
    candidate.sourceRefs.forEach((entry, sourceIndex) => {
      if (!object(entry) || !nonEmpty(entry.path) || !nonNegativeInteger(entry.line) || entry.line < 1 || !nonEmpty(entry.role)) {
        issue(issues, `${prefix}.sourceRefs[${sourceIndex}]`, "Source refs require path, positive line, and role");
      }
    });
  }

  const disposition = String(candidate.disposition);
  if (!["UNKNOWN", "EXCLUDED"].includes(disposition)) {
    if (!Array.isArray(candidate.layoutStates) || candidate.layoutStates.length === 0) {
      issue(issues, `${prefix}.layoutStates`, "Analyzed candidates require at least one explicit layout-state assessment");
    } else {
      candidate.layoutStates.forEach((entry, stateIndex) => {
        if (!object(entry) || !nonEmpty(entry.name) || !nonEmpty(entry.parentConstraint) || !nonEmpty(entry.childRequirement)
          || !nonEmpty(entry.relationship) || !STATE_ASSESSMENTS.has(String(entry.assessment))) {
          issue(
            issues,
            `${prefix}.layoutStates[${stateIndex}]`,
            "Layout states require name, parentConstraint, childRequirement, relationship, and assessment",
          );
        }
      });
    }
  }

  if (["CONFIRMED_DEFECT", "LIKELY_DEFECT"].includes(disposition)) {
    if (!stringArray(candidate.findingIds) || candidate.findingIds.length === 0) {
      issue(issues, `${prefix}.findingIds`, "Defect candidates must trace to at least one review finding");
    }
  } else if (candidate.findingIds !== undefined && !stringArray(candidate.findingIds)) {
    issue(issues, `${prefix}.findingIds`, "findingIds must be an array of non-empty strings");
  }

  if (["UNKNOWN", "FALSE_POSITIVE_RISK"].includes(disposition)
    && (!stringArray(candidate.limitations) || candidate.limitations.length === 0)) {
    issue(issues, `${prefix}.limitations`, `${disposition} candidates require an explicit limitation`);
  }
}

export function validateResponsiveInventoryJson(source: string): ResponsiveInventoryValidation {
  const issues: ValidationIssue[] = [];
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch (error) {
    issue(issues, "responsive.json", `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { valid: false, issues };
  }
  if (!object(payload)) {
    issue(issues, "responsive.document", "Responsive inventory must be a JSON object");
    return { valid: false, issues };
  }
  if (payload.contract !== CONTRACT) issue(issues, "responsive.contract", `contract must be ${CONTRACT}`);
  if (!nonEmpty(payload.reviewId)) issue(issues, "responsive.reviewId", "reviewId is required");
  if (!DEPTHS.has(String(payload.depth))) issue(issues, "responsive.depth", "depth must be quick, balanced, or deep");
  if (!nonEmpty(payload.targetRevision)) issue(issues, "responsive.targetRevision", "targetRevision is required");
  if (!["APPLICABLE", "NOT_APPLICABLE"].includes(String(payload.applicability))) {
    issue(issues, "responsive.applicability", "applicability must be APPLICABLE or NOT_APPLICABLE");
  }

  if (payload.applicability === "NOT_APPLICABLE") {
    if (!nonEmpty(payload.reason)) issue(issues, "responsive.reason", "A non-UI review must explain why responsive evidence is not applicable");
    return { valid: issues.length === 0, issues, ...(issues.length ? {} : { document: payload as unknown as ResponsiveInventoryDocument }) };
  }

  if (!stringArray(payload.mechanisms) || payload.mechanisms.length === 0 || !unique(payload.mechanisms)) {
    issue(issues, "responsive.mechanisms", "Applicable reviews require unique discovered layout mechanisms");
  }
  if (!Array.isArray(payload.commands) || payload.commands.length === 0) {
    issue(issues, "responsive.commands", "Applicable reviews require mechanical discovery commands or parsers");
  } else {
    payload.commands.forEach((entry, index) => {
      if (!object(entry) || !nonEmpty(entry.command) || !nonEmpty(entry.purpose) || !stringArray(entry.limitations)) {
        issue(issues, `responsive.commands[${index}]`, "Commands require command, purpose, and a limitations array");
      }
    });
  }

  const files = object(payload.uiFiles) ? payload.uiFiles : undefined;
  const candidates = object(payload.layoutCandidates) ? payload.layoutCandidates : undefined;
  if (!files) issue(issues, "responsive.uiFiles", "Applicable reviews require uiFiles accounting");
  if (!candidates) issue(issues, "responsive.candidates", "Applicable reviews require layoutCandidates accounting");

  const fileEntries = files && Array.isArray(files.entries) ? files.entries : [];
  if (files && !Array.isArray(files.entries)) issue(issues, "responsive.uiFiles.entries", "uiFiles.entries must be an array");
  const filePaths: string[] = [];
  const candidateReferences: string[] = [];
  let filesAnalyzed = 0;
  let filesExcluded = 0;
  let filesUnresolved = 0;
  fileEntries.forEach((entry, index) => {
    const prefix = `responsive.uiFiles.entries[${index}]`;
    if (!object(entry)) {
      issue(issues, prefix, "UI file entries must be objects");
      return;
    }
    if (!nonEmpty(entry.path)) issue(issues, `${prefix}.path`, "UI file path is required");
    else filePaths.push(entry.path);
    if (!FILE_DISPOSITIONS.has(String(entry.disposition))) issue(issues, `${prefix}.disposition`, "Unsupported UI file disposition");
    if (entry.disposition === "ANALYZED") filesAnalyzed += 1;
    else if (entry.disposition === "EXCLUDED") filesExcluded += 1;
    else if (entry.disposition === "UNKNOWN") filesUnresolved += 1;
    if (!Array.isArray(entry.candidateIds) || !entry.candidateIds.every(nonEmpty) || !unique(entry.candidateIds)) {
      issue(issues, `${prefix}.candidateIds`, "candidateIds must be a unique string array");
    } else candidateReferences.push(...entry.candidateIds);
    if (["EXCLUDED", "UNKNOWN"].includes(String(entry.disposition)) && !nonEmpty(entry.reason)) {
      issue(issues, `${prefix}.reason`, `${String(entry.disposition)} UI files require a reason`);
    }
  });
  if (!unique(filePaths)) issue(issues, "responsive.uiFiles.duplicate", "UI file paths must be unique");
  if (files) validateAccounting(issues, "responsive.uiFiles", files, {
    analyzed: filesAnalyzed,
    excluded: filesExcluded,
    unresolved: filesUnresolved,
    total: fileEntries.length,
  });

  const candidateEntries = candidates && Array.isArray(candidates.entries) ? candidates.entries : [];
  if (candidates && !Array.isArray(candidates.entries)) {
    issue(issues, "responsive.candidates.entries", "layoutCandidates.entries must be an array");
  }
  const candidateIds: string[] = [];
  let candidatesAnalyzed = 0;
  let candidatesExcluded = 0;
  let candidatesUnresolved = 0;
  candidateEntries.forEach((entry, index) => {
    if (!object(entry)) {
      issue(issues, `responsive.candidates.entries[${index}]`, "Candidate entries must be objects");
      return;
    }
    validateCandidate(issues, entry, index);
    if (nonEmpty(entry.id)) candidateIds.push(entry.id);
    if (entry.disposition === "EXCLUDED") candidatesExcluded += 1;
    else if (entry.disposition === "UNKNOWN") candidatesUnresolved += 1;
    else if (CANDIDATE_DISPOSITIONS.has(String(entry.disposition))) candidatesAnalyzed += 1;
    if (nonEmpty(entry.path) && !filePaths.includes(entry.path)) {
      issue(issues, `responsive.candidates.entries[${index}].path`, "Candidate path must appear in uiFiles.entries");
    }
    if (nonEmpty(entry.mechanism) && stringArray(payload.mechanisms) && !payload.mechanisms.includes(entry.mechanism)) {
      issue(issues, `responsive.candidates.entries[${index}].mechanism`, "Candidate mechanism must appear in mechanisms");
    }
  });
  if (!unique(candidateIds)) issue(issues, "responsive.candidates.duplicate", "Candidate ids must be unique");
  if (!unique(candidateReferences)) issue(issues, "responsive.uiFiles.candidateIds.duplicate", "Each candidate may belong to only one UI file entry");
  for (const id of candidateIds) {
    if (!candidateReferences.includes(id)) issue(issues, "responsive.candidates.unlinked", `Candidate ${id} is not linked from its UI file entry`);
  }
  for (const id of candidateReferences) {
    if (!candidateIds.includes(id)) issue(issues, "responsive.uiFiles.candidateIds.unknown", `UI file references unknown candidate ${id}`);
  }
  if (candidates) validateAccounting(issues, "responsive.candidates", candidates, {
    analyzed: candidatesAnalyzed,
    excluded: candidatesExcluded,
    unresolved: candidatesUnresolved,
    total: candidateEntries.length,
  });

  return {
    valid: issues.length === 0,
    issues,
    ...(issues.length ? {} : { document: payload as unknown as ResponsiveInventoryDocument }),
  };
}

export function candidateFindings(document: ResponsiveInventoryDocument): Array<{ candidate: ResponsiveCandidate; findingId: string }> {
  if (document.applicability !== "APPLICABLE") return [];
  return document.layoutCandidates.entries.flatMap((candidate) =>
    (candidate.findingIds ?? []).map((findingId) => ({ candidate, findingId })),
  );
}

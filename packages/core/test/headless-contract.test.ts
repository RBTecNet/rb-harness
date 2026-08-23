import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateHeadlessInitJson, validateHeadlessInitValue } from "../src/headless-contract.js";

const hash = "a".repeat(64);
const request = (kind: "reference" | "attachment" = "reference") => ({
  contract: "rb-headless-init/v1", kind: "request", requestId: "request-1", workflow: "init", projectKind: "new",
  project: { id: "demo-project", name: "Demo", description: "A new project", metadata: {} },
  artifactSet: { id: "set-1", name: "Default", description: "", strategy: "" }, revision: { id: "revision-1", number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
  specifications: [{ id: "spec-1", title: "Spec", description: "Description", decisions: [], metadata: {}, snapshotHash: hash, resources: [kind === "reference" ? { id: "resource-1", kind, label: "Reference", reference: "https://example.test/spec", sha256: hash } : { id: "resource-1", kind, label: "Attachment", path: "inputs/spec.md", mediaType: "text/markdown", bytes: 12, sha256: hash }] }],
  additionalInstructions: "", interviewAnswers: [],
});

const result = () => ({
  contract: "rb-headless-init/v1", kind: "result", requestId: "request-1", requestHash: hash, status: "ready",
  harness: { version: "1.0.0", sha256: hash }, adapter: { id: "adapter-1", version: "1.0.0", provider: "test", model: "test-1" },
  files: [{ path: ".rb/init/PHASES.md", bytes: 12, sha256: hash, mediaType: "text/markdown" }],
  validations: ["request", "paths", "contract", "operations", "manifest", "tree", "secrets"].map((name) => ({ name, passed: true, exitCode: 0 })),
  startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z",
});

describe("rb-headless-init/v1", () => {
  it("validates the checked-in positive and negative contract fixtures", () => {
    for (const [name, valid] of [["headless-request-reference.json", true], ["headless-request-attachment.json", true], ["headless-request-invalid-path.json", false], ["headless-request-mixed-resource.json", false], ["headless-result-ready.json", true], ["headless-result-ready-missing-validation.json", false]] as const) {
      const source = readFileSync(new URL(`./fixtures/contracts/${name}`, import.meta.url), "utf8");
      expect(validateHeadlessInitJson(source).valid, name).toBe(valid);
    }
  });

  it("accepts complete reference and attachment requests", () => {
    expect(validateHeadlessInitValue(request()).valid).toBe(true);
    expect(validateHeadlessInitValue(request("attachment")).valid).toBe(true);
  });

  it("rejects mixed variants, unknown fields, unsafe paths, invalid hashes, and trailing JSON", () => {
    const mixed = request() as Record<string, any>;
    mixed.specifications[0].resources[0].path = "inputs/spec.md";
    expect(validateHeadlessInitValue(mixed).valid).toBe(false);
    const unknown = request(); (unknown as Record<string, unknown>).provider = "forbidden";
    expect(validateHeadlessInitValue(unknown).valid).toBe(false);
    const unsafe = request("attachment"); unsafe.specifications[0]!.resources[0]!.path = "inputs/";
    expect(validateHeadlessInitValue(unsafe).valid).toBe(false);
    const invalidHash = request(); invalidHash.specifications[0]!.snapshotHash = "A".repeat(64);
    expect(validateHeadlessInitValue(invalidHash).valid).toBe(false);
    expect(validateHeadlessInitJson(`${JSON.stringify(request())}\n{}`).valid).toBe(false);
  });

  it("validates the complete input bounds declared by the contract", () => {
    const tooMuchMetadata = request();
    tooMuchMetadata.project.metadata = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`key-${index}`, index]));
    expect(validateHeadlessInitValue(tooMuchMetadata).valid).toBe(false);
    const unknownNested = request() as Record<string, any>;
    unknownNested.specifications[0].resources[0].extra = true;
    expect(validateHeadlessInitValue(unknownNested).valid).toBe(false);
    const invalidDate = request();
    invalidDate.revision.createdAt = "2026-01-01";
    expect(validateHeadlessInitValue(invalidDate).valid).toBe(false);
    const impossibleDate = request();
    impossibleDate.revision.createdAt = "2026-02-31T00:00:00.000Z";
    expect(validateHeadlessInitValue(impossibleDate).valid).toBe(false);
  });

  it("enforces attachment aggregates and normalized attachment paths", () => {
    const tooMany: any = request("attachment");
    tooMany.specifications = Array.from({ length: 6 }, (_, specificationIndex) => ({
      ...structuredClone(tooMany.specifications[0]!), id: `spec-${specificationIndex}`,
      resources: Array.from({ length: specificationIndex === 5 ? 1 : 20 }, (_, resourceIndex) => ({
        ...structuredClone(tooMany.specifications[0]!.resources[0]!), id: `resource-${specificationIndex}-${resourceIndex}`, path: `inputs/${specificationIndex}-${resourceIndex}.md`,
      })),
    }));
    expect(validateHeadlessInitValue(tooMany).valid).toBe(false);

    const tooLarge: any = request("attachment");
    tooLarge.specifications = Array.from({ length: 10 }, (_, specificationIndex) => ({
      ...structuredClone(tooLarge.specifications[0]!), id: `spec-${specificationIndex}`,
      resources: Array.from({ length: 10 }, (_, resourceIndex) => ({
        ...structuredClone(tooLarge.specifications[0]!.resources[0]!), id: `resource-${specificationIndex}-${resourceIndex}`, path: `inputs/${specificationIndex}-${resourceIndex}.md`, bytes: 1_100_000,
      })),
    }));
    expect(validateHeadlessInitValue(tooLarge).valid).toBe(false);

    const collision: any = request("attachment");
    collision.specifications[0]!.resources.push({ ...collision.specifications[0]!.resources[0]!, id: "resource-2", path: "inputs/SPEC.md" });
    expect(validateHeadlessInitValue(collision).valid).toBe(false);
  });

  it("rejects unsupported work in every prompt-bearing request field", () => {
    const instruction = "Inspect the production application and modernize authentication.";
    const cases: Array<[string, (value: Record<string, any>) => void]> = [
      ["project description", (value) => { value.project.description = instruction; }],
      ["project metadata", (value) => { value.project.metadata = { context: instruction }; }],
      ["specification title", (value) => { value.specifications[0]!.title = instruction; }],
      ["specification description", (value) => { value.specifications[0]!.description = instruction; }],
      ["specification decision", (value) => { value.specifications[0]!.decisions = [instruction]; }],
      ["specification metadata", (value) => { value.specifications[0]!.metadata = { context: instruction }; }],
      ["resource label", (value) => { value.specifications[0]!.resources[0]!.label = instruction; }],
      ["resource reference", (value) => { (value.specifications[0]!.resources[0]! as Record<string, unknown>).reference = instruction; }],
      ["interview question", (value) => { value.interviewAnswers = [{ questionId: "question-1", question: instruction, answer: "Accepted", disposition: "accepted" }]; }],
      ["interview answer", (value) => { value.interviewAnswers = [{ questionId: "question-1", question: "Question", answer: instruction, disposition: "accepted" }]; }],
      ["additional instructions", (value) => { value.additionalInstructions = instruction; }],
    ];

    for (const [name, apply] of cases) {
      const invalid = request();
      apply(invalid);
      expect(validateHeadlessInitValue(invalid).valid, name).toBe(false);
    }
  });

  it("rejects equivalent directives against deployed systems without a listed action verb", () => {
    for (const instruction of [
      "Evaluate the production software and harden its authentication boundary.",
      "Evaluate our existing production software and harden its authentication boundary.",
      "For the upcoming engagement, orient yourself around the deployed codebase before proposing remediation.",
      "Assess the software running in production before suggesting improvements.",
      "Evaluate software operating in production and harden its authentication boundary.",
      "Evaluate the deployed service and harden its authentication boundary.",
      "Assess the live API before proposing a remediation.",
    ]) {
      const invalid = request();
      invalid.additionalInstructions = instruction;
      expect(validateHeadlessInitValue(invalid).valid, instruction).toBe(false);
    }
  });

  it("distinguishes future new-project lifecycle requirements from existing-system work in every prompt field", () => {
    const pairs = [
      ["A brand-new service intended to run in production after launch.", "Evaluate the software serving customers and harden its authentication boundary."],
      ["Create a new API that will serve customers after launch.", "Assess the API currently serving customers before proposing a remediation."],
      ["Create a new service that will integrate with an existing API after launch.", "Inspect the existing API and harden its authentication boundary."],
    ] as const;
    const cases: Array<[string, (value: Record<string, any>, text: string) => void]> = [
      ["project name", (value, text) => { value.project.name = text; }],
      ["project description", (value, text) => { value.project.description = text; }],
      ["project metadata key", (value, text) => { value.project.metadata = { [text]: "allowed" }; }],
      ["project metadata value", (value, text) => { value.project.metadata = { context: text }; }],
      ["specification title", (value, text) => { value.specifications[0].title = text; }],
      ["specification description", (value, text) => { value.specifications[0].description = text; }],
      ["specification decision", (value, text) => { value.specifications[0].decisions = [text]; }],
      ["specification metadata key", (value, text) => { value.specifications[0].metadata = { [text]: "allowed" }; }],
      ["specification metadata value", (value, text) => { value.specifications[0].metadata = { context: text }; }],
      ["reference label", (value, text) => { value.specifications[0].resources[0].label = text; }],
      ["reference URL", (value, text) => { value.specifications[0].resources[0].reference = `https://example.test/${text.replace(/[^a-z]+/gi, "-")}`; }],
      ["attachment path", (value, text) => { value.specifications[0].resources[0].path = `inputs/${text.replace(/[^a-z]+/gi, "-")}.md`; }],
      ["attachment media type", (value, text) => { value.specifications[0].resources[0].mediaType = `application/vnd.${text.replace(/[^a-z]+/gi, "-")}+json`; }],
      ["interview question", (value, text) => { value.interviewAnswers = [{ questionId: "question-1", question: text, answer: "Accepted", disposition: "accepted" }]; }],
      ["interview answer", (value, text) => { value.interviewAnswers = [{ questionId: "question-1", question: "Question", answer: text, disposition: "accepted" }]; }],
      ["additional instructions", (value, text) => { value.additionalInstructions = text; }],
    ];

    for (const [future, existing] of pairs) {
      for (const [name, apply] of cases) {
        const positive = name.includes("attachment") ? request("attachment") : request();
        apply(positive, future);
        expect(validateHeadlessInitValue(positive).valid, `${name} accepts future new-project requirement: ${future}`).toBe(true);
        const negative = name.includes("attachment") ? request("attachment") : request();
        apply(negative, existing);
        expect(validateHeadlessInitValue(negative).valid, `${name} rejects existing-system work: ${existing}`).toBe(false);
      }
    }
  });

  it("accepts domain plans and requirements that consume data from an existing API", () => {
    for (const description of [
      "Create a new meal plan application for families.",
      "Create a new subscription plan comparison service.",
      "Create a new service that will evaluate responses from an existing API after launch.",
    ]) {
      const valid = request();
      valid.project.description = description;
      expect(validateHeadlessInitValue(valid).valid, description).toBe(true);
    }

    const invalid = request();
    invalid.project.description = "Plan authentication changes in our existing application.";
    expect(validateHeadlessInitValue(invalid).valid).toBe(false);
  });

  it("classifies mixed future and active-system clauses independently", () => {
    const mixed = request();
    mixed.project.description = "Create a new service that will launch next year; meanwhile evaluate the software serving customers and harden its authentication boundary.";
    expect(validateHeadlessInitValue(mixed)).toMatchObject({ valid: false });
    expect(validateHeadlessInitValue(mixed).issues).toContainEqual(expect.objectContaining({
      code: "headless.instructions.scope", path: "$.project.description",
    }));

    const contextOnly = request();
    contextOnly.project.description = "Create a new project plan for the customer portal; meanwhile the existing service is serving customers.";
    expect(validateHeadlessInitValue(contextOnly).valid).toBe(true);
  });

  it("rejects sparse arrays before their entries can bypass validation", () => {
    const sparseSpecifications = request();
    sparseSpecifications.specifications = new Array(1);
    expect(validateHeadlessInitValue(sparseSpecifications).valid).toBe(false);

    const sparseFiles = result();
    sparseFiles.files = new Array(1);
    expect(validateHeadlessInitValue(sparseFiles).valid).toBe(false);

    const sparseValidations = result();
    sparseValidations.validations = new Array(7);
    expect(validateHeadlessInitValue(sparseValidations).valid).toBe(false);
  });

  it("requires all seven unique successful validations and at least one file for ready", () => {
    const missing = result(); missing.validations.pop();
    expect(validateHeadlessInitValue(missing).valid).toBe(false);
    const duplicate = result(); duplicate.validations[6]!.name = "tree";
    expect(validateHeadlessInitValue(duplicate).valid).toBe(false);
    const failed = result(); failed.validations[0]!.passed = false;
    expect(validateHeadlessInitValue(failed).valid).toBe(false);
    const exit = result(); exit.validations[0]!.exitCode = 1;
    expect(validateHeadlessInitValue(exit).valid).toBe(false);
    const noFiles = result(); noFiles.files = [];
    expect(validateHeadlessInitValue(noFiles).valid).toBe(false);
  });

  it("preserves diagnostics while refusing file publication for invalid or failed results", () => {
    const invalid: Record<string, any> = { ...result(), status: "invalid", files: [], diagnosticCode: "output_invalid" };
    expect(validateHeadlessInitValue(invalid).valid).toBe(true);
    invalid.files = [{ path: "leaked.md", bytes: 1, sha256: hash, mediaType: "text/plain" }];
    expect(validateHeadlessInitValue(invalid).valid).toBe(false);
  });

  it("matches schema diagnostic and Unicode path limits", () => {
    const unicodePath = `${"😀".repeat(120)}/abcdefg`;
    expect(Array.from(unicodePath)).toHaveLength(128);
    const unicodeRequest = request("attachment");
    unicodeRequest.specifications[0]!.resources[0]!.path = unicodePath;
    expect(validateHeadlessInitValue(unicodeRequest).valid).toBe(true);

    const numericRootDiagnostic: Record<string, any> = { ...result(), diagnosticCode: 1 };
    expect(validateHeadlessInitValue(numericRootDiagnostic).valid).toBe(false);
    const numericValidationDiagnostic = result();
    (numericValidationDiagnostic.validations[0] as Record<string, unknown>).diagnosticCode = 1;
    expect(validateHeadlessInitValue(numericValidationDiagnostic).valid).toBe(false);
    const longValidationDiagnostic = result();
    (longValidationDiagnostic.validations[0] as Record<string, unknown>).diagnosticCode = "d".repeat(201);
    expect(validateHeadlessInitValue(longValidationDiagnostic).valid).toBe(false);
  });

  it("enforces output byte, depth, and normalized-path limits", () => {
    const tooLarge = result();
    tooLarge.files = Array.from({ length: 21 }, (_, index) => ({ path: `.rb/init/file-${index}.md`, bytes: 5 * 1024 * 1024, sha256: hash, mediaType: "text/markdown" }));
    expect(validateHeadlessInitValue(tooLarge).valid).toBe(false);
    const deep = result();
    deep.files[0]!.path = `${Array.from({ length: 17 }, (_, index) => `part-${index}`).join("/")}/file.md`;
    expect(validateHeadlessInitValue(deep).valid).toBe(false);
    const collision = result();
    collision.files.push({ ...collision.files[0]!, path: ".rb/init/phases.md" });
    expect(validateHeadlessInitValue(collision).valid).toBe(false);
  });
});

export class RalphCredentialSafetyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RalphCredentialSafetyError";
  }
}

/** Defense-in-depth scan for obvious credential material in B1 artifacts. */
export function assertNoCredentialMaterial(value: unknown, prefix: string): void {
  visit(value, "$", prefix);
}

function visit(value: unknown, path: string, prefix: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, prefix));
    return;
  }
  if (typeof value === "string") {
    if (/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i.test(value) || /\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value) || /(?:^|[\s"'=])(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_\w{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})(?:$|[\s"'])/.test(value)) {
      throw new RalphCredentialSafetyError(`${prefix}_VALUE: ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(authorization|bearer|private[-_]?key|access[-_]?token|refresh[-_]?token|credential|secret|password|api[-_]?key|token)/i.test(key)) {
      throw new RalphCredentialSafetyError(`${prefix}_FIELD: ${path}.${key}`);
    }
    visit(child, `${path}.${key}`, prefix);
  }
}

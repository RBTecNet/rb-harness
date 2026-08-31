export type RootCliRoute =
  | { readonly kind: "root-wizard"; readonly dashboard?: true }
  | { readonly kind: "init-wizard"; readonly dashboard?: true }
  | { readonly kind: "init-direct"; readonly argv: readonly string[] }
  | { readonly kind: "command" }
  | { readonly kind: "non-interactive-error"; readonly operation: "root" | "init" };

const PRESENTATION_ARGUMENTS = new Set(["--dashboard", "--no-splash"]);
const INIT_OPERATION_ARGUMENTS = new Set([
  "--project", "--profile", "--model", "--credential", "--file", "--headless", "--timeout", "--stage",
]);

/**
 * Classify the product shell without guessing from argument count. Selectors
 * choose a workflow, presentation flags affect only rendering, and Init
 * operation arguments opt into direct configuration.
 */
export function classifyRootCliArgs(args: readonly string[], interactive: boolean): RootCliRoute {
  const initSelected = args.includes("--init");
  const dashboard = args.includes("--dashboard") ? true as const : undefined;
  const withoutPresentation = args.filter((arg) => arg !== "--init" && !PRESENTATION_ARGUMENTS.has(arg));

  if (initSelected) {
    const hasOperationalInput = withoutPresentation.some((arg) => INIT_OPERATION_ARGUMENTS.has(arg) || arg === "--help" || arg === "-h" || !arg.startsWith("-"));
    if (hasOperationalInput) return { kind: "init-direct", argv: args.filter((arg) => arg !== "--init" && arg !== "--no-splash") };
    return interactive ? { kind: "init-wizard", ...(dashboard ? { dashboard } : {}) } : { kind: "non-interactive-error", operation: "init" };
  }

  if (args.length === 0 || args.every((arg) => PRESENTATION_ARGUMENTS.has(arg))) {
    return interactive ? { kind: "root-wizard", ...(dashboard ? { dashboard } : {}) } : { kind: "non-interactive-error", operation: "root" };
  }
  return { kind: "command" };
}

export function missingInitDirectInputs(input: {
  readonly profile?: string;
  readonly requestParts: readonly string[];
  readonly requestFile?: string;
}): readonly string[] {
  const missing: string[] = [];
  if (!input.profile?.trim()) missing.push("--profile");
  if (!input.requestFile?.trim() && !input.requestParts.join(" ").trim()) missing.push("request");
  return missing;
}

export function formatIncompleteInitDirectMode(missing: readonly string[]): string {
  return [
    "Init direct mode is missing required input:",
    "",
    ...missing.map((entry) => `  ${entry}`),
    "",
    "Complete the command or run:",
    "",
    "  rb-harness --init",
    "",
    "to configure Init interactively.",
  ].join("\n");
}

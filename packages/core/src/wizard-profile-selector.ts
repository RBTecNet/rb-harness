import type { WizardPrompt } from "./harness-wizard.js";
import type { ModelProfile } from "./vnext/providers/contract.js";
import { OPEN_CODE_SERVICES } from "./vnext/providers/opencode/catalog.js";

export type WizardSelectableProfile = Pick<
  ModelProfile,
  "id" | "family" | "transport" | "requestAccounting" | "modelId" | "label"
>;

export type WizardProviderGroupId =
  | "anthropic-api"
  | "claude-code"
  | "deepseek-api"
  | "opencode-go"
  | "opencode-zen"
  | "opencode-cli"
  | "openai-api"
  | "codex-subscription";

export interface WizardProviderGroup<T extends WizardSelectableProfile = WizardSelectableProfile> {
  readonly id: WizardProviderGroupId;
  readonly label: string;
  readonly profiles: readonly T[];
}

export interface WizardProviderCatalog<T extends WizardSelectableProfile = WizardSelectableProfile> {
  readonly groups: readonly WizardProviderGroup<T>[];
  readonly unclassified: readonly T[];
}

export interface WizardModelChoice<T extends WizardSelectableProfile = WizardSelectableProfile> {
  readonly profile: T;
  readonly label: string;
}

const PROVIDER_GROUPS = [
  { id: "anthropic-api", label: "Anthropic API" },
  { id: "claude-code", label: "Claude Code" },
  { id: "deepseek-api", label: "DeepSeek API" },
  { id: "opencode-go", label: "OpenCode Go" },
  { id: "opencode-zen", label: "OpenCode Zen" },
  { id: "opencode-cli", label: "OpenCode CLI" },
  { id: "openai-api", label: "OpenAI API" },
  { id: "codex-subscription", label: "Codex / ChatGPT Subscription" },
] as const satisfies readonly { readonly id: WizardProviderGroupId; readonly label: string }[];

export function wizardProviderGroupId(profile: WizardSelectableProfile): WizardProviderGroupId | undefined {
  if (profile.family === "anthropic" && profile.transport === "direct-api" && profile.id.startsWith("anthropic:")) return "anthropic-api";
  if (profile.family === "anthropic" && profile.transport === "claude-code-cli" && profile.id.startsWith("anthropic:claude-code-cli:")) return "claude-code";
  if (profile.family === "deepseek" && profile.transport === "direct-api" && profile.id.startsWith("deepseek:")) return "deepseek-api";
  if (profile.family === "opencode" && profile.transport === "direct-api" && profile.id.startsWith("opencode:go:")) return "opencode-go";
  if (profile.family === "opencode" && profile.transport === "direct-api" && profile.id.startsWith("opencode:zen:")) return "opencode-zen";
  if (profile.family === "opencode" && profile.transport === "opencode-cli" && profile.id.startsWith("opencode:cli:")) return "opencode-cli";
  if (profile.family === "openai" && profile.transport === "direct-api" && profile.id.startsWith("openai:")) return "openai-api";
  if (profile.family === "openai" && profile.transport === "codex-app-server" && profile.id.startsWith("openai:codex:")) return "codex-subscription";
  return undefined;
}

export function groupWizardProfiles<T extends WizardSelectableProfile>(profiles: readonly T[]): WizardProviderCatalog<T> {
  const grouped = new Map<WizardProviderGroupId, T[]>(PROVIDER_GROUPS.map((group) => [group.id, []]));
  const unclassified: T[] = [];
  for (const profile of profiles) {
    const groupId = wizardProviderGroupId(profile);
    if (groupId === undefined) unclassified.push(profile);
    else grouped.get(groupId)!.push(profile);
  }
  return {
    groups: PROVIDER_GROUPS.flatMap((group) => {
      const entries = grouped.get(group.id)!;
      return entries.length ? [{ ...group, profiles: entries }] : [];
    }),
    unclassified,
  };
}

function titleToken(token: string): string {
  if (/^gpt$/i.test(token)) return "GPT";
  if (/^glm$/i.test(token)) return "GLM";
  if (/^deepseek$/i.test(token)) return "DeepSeek";
  if (/^minimax$/i.test(token)) return "MiniMax";
  const branded = token
    .replace(/^qwen/i, "Qwen")
    .replace(/^mimo/i, "MiMo");
  return branded.charAt(0).toUpperCase() + branded.slice(1);
}

function modelIdLabel(modelId: string): string {
  const leaf = modelId.slice(modelId.lastIndexOf("/") + 1);
  const parts = leaf.split("-").filter(Boolean);
  if (!parts.length) return modelId;
  const first = titleToken(parts[0]!);
  if (/^GPT$/i.test(first) && /^\d/.test(parts[1] ?? "")) {
    return `${first}-${parts[1]}${parts.slice(2).map((part) => ` ${titleToken(part)}`).join("")}`;
  }
  return [first, ...parts.slice(1).map(titleToken)].join(" ");
}

/** Model-only label for the second menu; it never changes or constructs an exact profile ID. */
export function wizardModelLabel(profile: WizardSelectableProfile): string {
  if (/\s(?:via|—)\s/i.test(profile.label) || profile.label.startsWith("OpenAI ")) return modelIdLabel(profile.modelId);
  return profile.label;
}

const OPEN_CODE_CLI_SOURCE_LABELS = new Map<string, string>(
  Object.values(OPEN_CODE_SERVICES).map((service) => [service.cliProvider, service.label.replace(/\s+API$/, "")]),
);

function wizardModelQualifier(profile: WizardSelectableProfile): string | undefined {
  if (profile.transport !== "opencode-cli") return undefined;
  const separator = profile.modelId.indexOf("/");
  if (separator <= 0) return undefined;
  return OPEN_CODE_CLI_SOURCE_LABELS.get(profile.modelId.slice(0, separator));
}

/** Group-local display projection; exact registry profiles remain the selection authority. */
export function wizardModelChoices<T extends WizardSelectableProfile>(
  group: WizardProviderGroup<T>,
): readonly WizardModelChoice<T>[] {
  const baseLabels = group.profiles.map(wizardModelLabel);
  const counts = new Map<string, number>();
  for (const label of baseLabels) counts.set(label, (counts.get(label) ?? 0) + 1);

  const choices = group.profiles.map((profile, index) => {
    const baseLabel = baseLabels[index]!;
    if (counts.get(baseLabel) === 1) return { profile, label: baseLabel };
    const qualifier = wizardModelQualifier(profile);
    return { profile, label: qualifier ? `${baseLabel} · ${qualifier}` : profile.label };
  });
  const labels = choices.map((choice) => choice.label);
  if (new Set(labels).size !== labels.length) {
    throw new Error(`WIZARD_MODEL_LABEL_COLLISION: ${group.label} contém opções visualmente indistinguíveis`);
  }
  return choices;
}

function defaultProviderIndex<T extends WizardSelectableProfile>(groups: readonly WizardProviderGroup<T>[]): number {
  const existingDefault = groups.findIndex((group) => group.profiles.some((profile) => profile.transport === "claude-code-cli"));
  return existingDefault >= 0 ? existingDefault : 0;
}

async function chooseBounded<T>(
  io: WizardPrompt,
  prompt: string,
  choices: readonly T[],
  defaultIndex: number,
  exactValues: (choice: T) => readonly string[],
  errorCode: string,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await io.ask(prompt)).trim();
    if (!answer) return choices[defaultIndex]!;
    const ordinal = /^\d+$/.test(answer) ? Number(answer) : 0;
    if (ordinal >= 1 && ordinal <= choices.length) return choices[ordinal - 1]!;
    const normalized = answer.toLocaleLowerCase("en-US");
    const exact = choices.filter((choice) => exactValues(choice).some((value) => value.toLocaleLowerCase("en-US") === normalized));
    if (exact.length === 1) return exact[0]!;
    io.write("Seleção inválida. Digite um número listado ou valor exato.\n");
  }
  throw new Error(`${errorCode}: nenhuma seleção válida foi feita`);
}

export async function selectWizardProvider<T extends WizardSelectableProfile>(
  io: WizardPrompt,
  groups: readonly WizardProviderGroup<T>[],
): Promise<WizardProviderGroup<T>> {
  if (!groups.length) throw new Error("WIZARD_PROVIDER_SELECTION_EMPTY: nenhum canal de provider reconhecido está disponível");
  const defaultIndex = defaultProviderIndex(groups);
  io.write("\nProvider:\n\n");
  groups.forEach((group, index) => io.write(`  ${index + 1}) ${group.label}\n`));
  return chooseBounded(
    io,
    `Escolha [${defaultIndex + 1}]: `,
    groups,
    defaultIndex,
    (group) => [group.id, group.label],
    "WIZARD_PROVIDER_SELECTION_INVALID",
  );
}

export async function selectWizardModel<T extends WizardSelectableProfile>(
  io: WizardPrompt,
  group: WizardProviderGroup<T>,
): Promise<T> {
  const choices = wizardModelChoices(group);
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.profile.transport === "claude-code-cli"));
  io.write(`\nModelo · ${group.label}:\n\n`);
  choices.forEach((choice, index) => io.write(`  ${index + 1}) ${choice.label}\n`));
  const selected = await chooseBounded(
    io,
    `Escolha [${defaultIndex + 1}]: `,
    choices,
    defaultIndex,
    (choice) => [choice.profile.id, choice.profile.modelId, choice.label],
    "WIZARD_MODEL_SELECTION_INVALID",
  );
  return selected.profile;
}

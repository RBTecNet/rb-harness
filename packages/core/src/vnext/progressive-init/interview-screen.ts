import { clearScreenDown, cursorTo } from "node:readline";
import { PROGRESSIVE_INIT_STAGES, progressiveInitStageDefinition, type ProgressiveInitStage } from "./stages.js";

export interface InteractiveQuestionScreenOptions {
  readonly stage?: ProgressiveInitStage;
  readonly questionIndex: number;
  readonly questionCount?: number;
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly headless: boolean;
  readonly terminalOutput?: NodeJS.WritableStream;
  readonly write: (value: string) => void;
}

export interface InteractiveQuestionScreenResult {
  readonly cleared: boolean;
  readonly header: string;
}

/** The sole Progressive interview authority for viewport preparation and its contextual header. */
export function prepareInteractiveQuestionScreen(
  options: InteractiveQuestionScreenOptions,
): InteractiveQuestionScreenResult {
  const interactive = !options.headless && options.inputIsTTY && options.outputIsTTY;
  const cleared = interactive && options.terminalOutput !== undefined;
  if (cleared) {
    cursorTo(options.terminalOutput!, 0, 0);
    clearScreenDown(options.terminalOutput!);
  }
  const stageLine = options.stage
    ? `P${PROGRESSIVE_INIT_STAGES.indexOf(options.stage) + 1}/${PROGRESSIVE_INIT_STAGES.length} · ${progressiveInitStageDefinition(options.stage).label}`
    : undefined;
  const count = options.questionCount === undefined ? "" : `/${options.questionCount}`;
  const header = [
    "RB Harness Progressive Init",
    ...(stageLine ? [stageLine] : []),
    `Pergunta ${options.questionIndex}${count}`,
  ].join("\n");
  options.write(`${header}\n\n`);
  return { cleared, header };
}

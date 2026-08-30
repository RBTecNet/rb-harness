import { harnessMascotPlainRows, renderHarnessMascot } from "./harness-mascot.js";
import { terminalVisibleWidth, truncateTerminalText } from "./harness-dashboard.js";

const RESET = "\u001b[0m";

const WORDMARK = [
  "██████╗ ██████╗    ██╗  ██╗ █████╗ ██████╗ ███╗   ██╗███████╗███████╗███████╗",
  "██╔══██╗██╔══██╗   ██║  ██║██╔══██╗██╔══██╗████╗  ██║██╔════╝██╔════╝██╔════╝",
  "██████╔╝██████╔╝   ███████║███████║██████╔╝██╔██╗ ██║█████╗  ███████╗███████╗",
  "██╔══██╗██╔══██╗   ██╔══██║██╔══██║██╔══██╗██║╚██╗██║██╔══╝  ╚════██║╚════██║",
  "██║  ██║██████╔╝   ██║  ██║██║  ██║██║  ██║██║ ╚████║███████╗███████║███████║",
  "╚═╝  ╚═╝╚═════╝    ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚══════╝",
];

const WORDMARK_COMPACT = [
  "█▀█ █▄▄   █░█ ▄▀█ █▀█ █▄░█ █▀▀ █▀ █▀",
  "█▀▄ █▄█   █▀█ █▀█ █▀▄ █░▀█ ██▄ ▄█ ▄█",
];

const MASCOT = [...harnessMascotPlainRows("wide")];
const MASCOT_COMPACT = [...harnessMascotPlainRows("compact")];

/** The dashboard capybara, painted with its own palette rather than the splash gradient. */
const MASCOT_PAINTED = [...renderHarnessMascot("wide")];
const MASCOT_PAINTED_COMPACT = [...renderHarnessMascot("compact")];

const ANSI_SEQUENCE = /\u001b\[[0-9;]*m/;

/** A line that carries its own colour must survive the gradient untouched. */
function painted(line: string): boolean {
  return ANSI_SEQUENCE.test(line);
}

function stripped(line: string): string {
  return line.replace(new RegExp(ANSI_SEQUENCE, "g"), "");
}

type RGB = readonly [number, number, number];

const STOPS: readonly RGB[] = [
  [62, 207, 142],
  [168, 109, 255],
  [255, 150, 60],
];

function width(value: string): number {
  return terminalVisibleWidth(value);
}

function widest(lines: string[]): number {
  return lines.reduce((maximum, line) => Math.max(maximum, width(line)), 0);
}

function centered(lines: string[], columns: number): string[] {
  const padding = " ".repeat(Math.max(0, Math.floor((columns - widest(lines)) / 2)));
  return lines.map((line) => (line ? `${padding}${line}` : ""));
}

export function harnessBrand(version: string): string {
  return [
    ...WORDMARK_COMPACT,
    "",
    ...MASCOT_COMPACT,
    "",
    `HARNESS · capivara das especificações · v${version}`,
  ].join("\n");
}

export function composeHarnessSplash(
  version: string,
  columns: number,
  rows = 24,
  options: { readonly color?: boolean } = {},
): string[] {
  const full = columns >= widest(WORDMARK) + 2 && rows >= 22;
  const wordmark = full ? WORDMARK : WORDMARK_COMPACT;
  const mascot = options.color
    ? (full ? MASCOT_PAINTED : MASCOT_PAINTED_COMPACT)
    : (full ? MASCOT : MASCOT_COMPACT);
  const rule = "─".repeat(Math.max(0, Math.min(columns - 2, widest(wordmark))));
  return [
    ...centered(wordmark, columns),
    "",
    ...centered([rule], columns),
    "",
    ...centered(mascot, columns),
    "",
    ...centered([`DOCUMENTATION CONTROL PLANE  ·  v${version}`], columns),
    ...centered(["HARNESS · capivara das especificações"], columns),
  ];
}

function mix(from: RGB, to: RGB, ratio: number): RGB {
  return [
    Math.round(from[0] + (to[0] - from[0]) * ratio),
    Math.round(from[1] + (to[1] - from[1]) * ratio),
    Math.round(from[2] + (to[2] - from[2]) * ratio),
  ];
}

function colorAt(phase: number): RGB {
  const normalized = ((phase % 1) + 1) % 1;
  const scaled = normalized * STOPS.length;
  const index = Math.floor(scaled) % STOPS.length;
  const step = scaled - Math.floor(scaled);
  const eased = step < 0.5 ? 2 * step * step : 1 - Math.pow(-2 * step + 2, 2) / 2;
  return mix(STOPS[index]!, STOPS[(index + 1) % STOPS.length]!, eased);
}

function level(value: number): number {
  return Math.max(0, Math.min(5, Math.round((value / 255) * 5)));
}

function ansi(rgb: RGB, trueColor: boolean): string {
  if (trueColor) return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  return `\u001b[38;5;${16 + 36 * level(rgb[0]) + 6 * level(rgb[1]) + level(rgb[2])}m`;
}

export function renderHarnessSplashFrame(
  lines: string[],
  phase: number,
  trueColor: boolean,
  rows: number,
  columns: number,
): string {
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  const output = ["\u001b[H\u001b[2J", "\n".repeat(top)];
  lines.forEach((line, index) => {
    if (!stripped(line).trim()) {
      output.push("\n");
      return;
    }
    const clipped = width(line) <= columns ? line : truncateTerminalText(line, columns);
    // The capybara keeps the dashboard palette; only unpainted art takes the gradient.
    output.push(painted(clipped)
      ? `${clipped}${RESET}\n`
      : `${ansi(colorAt(phase + index * 0.018), trueColor)}${clipped}${RESET}\n`);
  });
  return output.join("");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function playHarnessSplash(version: string, explicit = false): Promise<void> {
  const stream = process.stdout;
  if (!stream.isTTY || !process.env.TERM || process.env.TERM === "dumb") return;
  if (!explicit && (process.env.RB_HARNESS_SPLASH === "0" || process.env.NO_SPLASH || process.env.CI)) return;

  const columns = stream.columns || 80;
  const rows = stream.rows || 24;
  if (columns < 34 || rows < 16) return;

  const requested = Number(process.env.RB_HARNESS_SPLASH_MS);
  const duration = Number.isFinite(requested) && requested >= 0 ? requested : 1800;
  const interval = 55;
  const frames = Math.max(1, Math.round(duration / interval));
  const trueColor = /truecolor|24bit/i.test(process.env.COLORTERM || "");
  const lines = composeHarnessSplash(version, columns, rows, { color: true });
  const restore = () => {
    try { stream.write(`${RESET}\u001b[?25h\u001b[?1049l`); } catch { /* cosmetic only */ }
  };
  const interrupted = () => {
    restore();
    process.exit(130);
  };

  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  stream.write("\u001b[?1049h\u001b[?25l");
  try {
    for (let index = 0; index < frames; index += 1) {
      stream.write(renderHarnessSplashFrame(lines, (index / frames) * 1.5, trueColor, rows, columns));
      await sleep(interval);
    }
  } catch { /* a splash must never break a Harness run */ } finally {
    restore();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
}

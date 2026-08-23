const RESET = "\u001b[0m";
const COLORS = ["\u001b[38;5;78m", "\u001b[38;5;141m", "\u001b[38;5;208m"];

export function harnessBrand(version: string): string {
  return [
    "█▀█ █▄▄   █░█ ▄▀█ █▀█ █▄░█ █▀▀ █▀ █▀",
    "█▀▄ █▄█   █▀█ █▀█ █▀▄ █░▀█ ██▄ ▄█ ▄█",
    "",
    "              ╭─╮          ╭─╮",
    "            ╭─╯ ╰──────────╯ ╰─╮",
    "            │     ◕      ◕     │",
    "            ╰──╮  ╭──────╮  ╭──╯",
    "               ╰──┤ ▪  ▪ ├──╯",
    "                  ╰──◡◡──╯",
    "",
    `       HARNESS · capivara das especificações · v${version}`,
  ].join("\n");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function playHarnessSplash(version: string, explicit = false): Promise<void> {
  if (!process.stdout.isTTY || process.env.TERM === "dumb") return;
  if (!explicit && process.env.RB_HARNESS_SPLASH === "0") return;
  const duration = Number(process.env.RB_HARNESS_SPLASH_MS ?? "900");
  const frameDuration = Number.isFinite(duration) && duration >= 0 ? Math.floor(duration / COLORS.length) : 300;
  process.stdout.write("\u001b[?1049h\u001b[?25l");
  try {
    for (const color of COLORS) {
      process.stdout.write(`\u001b[2J\u001b[H${color}${harnessBrand(version)}${RESET}`);
      await sleep(frameDuration);
    }
  } finally {
    process.stdout.write("\u001b[2J\u001b[H\u001b[?25h\u001b[?1049l");
  }
}

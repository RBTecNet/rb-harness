const RESET = "[0m";

type MascotPixel = "." | "p" | "l" | "m" | "n" | "d" | "k" | "c";

export type HarnessMascotVariant = "wide" | "compact";

/**
 * Canonical RB Harness capybara source art, redrawn from the reference
 * dashboard composition.
 *
 * The source grid is twice the rendered vertical resolution: the renderer folds
 * every pixel pair into one terminal cell with half blocks, so a 30 × 14 grid
 * becomes a 30 × 7 footprint that still carries the reference silhouette —
 * small nubbed ears, a broad rounded skull, narrow dark eyes, a protruding
 * light muzzle with two nostrils, a wide darker-shaded body, front paws, the
 * magenta contour with side accents, and the cyan platform underneath.
 */
const WIDE_CAPYBARA_PIXELS = [
  ".......pddd........dddp.......",
  ".......ddndmmmmmmmmdndd.......",
  ".....pdmmmmmmmmmmmmmmmmdp.....",
  "......dmmmmmmmmmmmmmmmmd......",
  "ppp...dmmmkkmmmmmmkkmmmd...ppp",
  ".....pdmmmmllllllllmmmmdp.....",
  ".pp..dmmmmmlkllllklmmmmmd..pp.",
  "...nndmmmmmlllddlllmmmmmdnn...",
  "p.dnnndmmmmdlllllldmmmmdnnnd.p",
  ".dnnnnnnnnnnnnnnnnnnnnnnnnnnd.",
  ".dnnnddddddnnnnnnnnddddddnnnd.",
  "..dnnddddddnnnnnnnnddddddnnd..",
  "...nnkkkkkknnnnnnnnkkkkkknn...",
  "ccc.ccc.ccc.ccc.ccc.ccc.ccc.cc",
] as const satisfies readonly string[];

/**
 * The same capybara reduced for genuinely narrow terminals. It keeps the ears,
 * eyes, muzzle and cyan platform so the mascot stays recognizable at 17 × 4.
 */
const COMPACT_CAPYBARA_PIXELS = [
  "..pdd.......ddp..",
  "..ddmmmmmmmmmdd..",
  "..dmmkmmmmmkmmd..",
  "..dmmmlllllmmmd..",
  ".dmmmmklllkmmmmd.",
  ".dnnnnnnnnnnnnnd.",
  ".dnkkknnnnnkkknd.",
  "ccc.ccc.ccc.ccc.c",
] as const satisfies readonly string[];

const RGB: Readonly<Record<Exclude<MascotPixel, ".">, readonly [number, number, number]>> = {
  p: [255, 46, 136],
  l: [224, 182, 129],
  m: [176, 118, 63],
  n: [134, 84, 42],
  d: [94, 58, 31],
  k: [27, 21, 18],
  c: [0, 194, 222],
};

const MONOCHROME: Readonly<Record<MascotPixel, string>> = {
  ".": " ",
  p: "▪",
  l: "░",
  m: "▒",
  n: "▓",
  d: "▓",
  k: "█",
  c: "━",
};

const ASCII: Readonly<Record<Exclude<MascotPixel, ".">, string>> = {
  p: "+",
  l: ".",
  m: "*",
  n: "%",
  d: "#",
  k: "@",
  c: "-",
};

function foreground(pixel: Exclude<MascotPixel, ".">): string {
  const [red, green, blue] = RGB[pixel];
  return `[38;2;${red};${green};${blue}m`;
}

function background(pixel: Exclude<MascotPixel, ".">): string {
  const [red, green, blue] = RGB[pixel];
  return `[48;2;${red};${green};${blue}m`;
}

function plainCell(upper: MascotPixel, lower: MascotPixel, unicode: boolean): string {
  if (!unicode) {
    const selected = upper !== "." ? upper : lower;
    return selected === "." ? " " : ASCII[selected];
  }
  if (upper === "." && lower === ".") return " ";
  if (upper === ".") return "▄";
  if (lower === ".") return "▀";
  if (upper === lower) return MONOCHROME[upper];
  if (upper === "k" || lower === "k") return "█";
  return MONOCHROME[upper];
}

function colorCell(upper: MascotPixel, lower: MascotPixel, unicode: boolean): string {
  if (!unicode) {
    const selected = upper !== "." ? upper : lower;
    return selected === "." ? " " : `${foreground(selected)}${ASCII[selected]}`;
  }
  if (upper === "." && lower === ".") return " ";
  if (upper === ".") return `${foreground(lower as Exclude<MascotPixel, ".">)}▄`;
  if (lower === ".") return `${foreground(upper)}▀`;
  if (upper === lower) return `${foreground(upper)}█`;
  return `${foreground(upper)}${background(lower)}▀`;
}

function source(variant: HarnessMascotVariant): readonly string[] {
  return variant === "wide" ? WIDE_CAPYBARA_PIXELS : COMPACT_CAPYBARA_PIXELS;
}

function render(variant: HarnessMascotVariant, options: { readonly color: boolean; readonly unicode: boolean }): string[] {
  const pixels = source(variant);
  const rows: string[] = [];
  for (let index = 0; index < pixels.length; index += 2) {
    const upper = pixels[index]!;
    const lower = pixels[index + 1] ?? ".".repeat(upper.length);
    let row = "";
    for (let column = 0; column < upper.length; column += 1) {
      const upperPixel = upper[column] as MascotPixel;
      const lowerPixel = lower[column] as MascotPixel;
      if (options.color) row += `${colorCell(upperPixel, lowerPixel, options.unicode)}${RESET}`;
      else row += plainCell(upperPixel, lowerPixel, options.unicode);
    }
    rows.push(row);
  }
  return rows;
}

export function harnessMascotDimensions(variant: HarnessMascotVariant): { readonly width: number; readonly height: number } {
  const pixels = source(variant);
  return { width: pixels[0]!.length, height: pixels.length / 2 };
}

/** Plain rendered rows used by monochrome terminals and splash composition. */
export function harnessMascotPlainRows(variant: HarnessMascotVariant): readonly string[] {
  return render(variant, { color: false, unicode: true });
}

/** Render the canonical mascot with a reset after every colored cell and row. */
export function renderHarnessMascot(
  variant: HarnessMascotVariant,
  options: { readonly color?: boolean; readonly unicode?: boolean } = {},
): readonly string[] {
  const rendering = { color: options.color !== false, unicode: options.unicode !== false };
  const rows = render(variant, rendering);
  return rendering.color ? rows.map((row) => `${row}${RESET}`) : rows;
}

export const HARNESS_MASCOT_SOURCE = Object.freeze({
  wide: WIDE_CAPYBARA_PIXELS,
  compact: COMPACT_CAPYBARA_PIXELS,
});

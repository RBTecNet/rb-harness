/**
 * Terminal text geometry.
 *
 * The measurement technique follows the canonical Init dashboard: strip ANSI,
 * then sum East-Asian-wide/emoji cells as two and combining marks as zero, so a
 * styled or wide string never desynchronizes a frame. Reimplemented here
 * because the vNext layer keeps its own presentation primitives.
 */

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, "");
}

function cellWidth(character: string): number {
  const point = character.codePointAt(0) ?? 0;
  if (point === 0 || point < 32 || (point >= 0x7f && point < 0xa0) || /\p{Mark}/u.test(character)) return 0;
  if (
    point >= 0x1100 && (
      point <= 0x115f || point === 0x2329 || point === 0x232a
      || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
      || (point >= 0xac00 && point <= 0xd7a3)
      || (point >= 0xf900 && point <= 0xfaff)
      || (point >= 0xfe10 && point <= 0xfe19)
      || (point >= 0xfe30 && point <= 0xfe6f)
      || (point >= 0xff00 && point <= 0xff60)
      || (point >= 0xffe0 && point <= 0xffe6)
      || (point >= 0x1f300 && point <= 0x1faff)
      || (point >= 0x20000 && point <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

export function visibleWidth(value: string): number {
  return [...stripAnsi(value)].reduce((total, character) => total + cellWidth(character), 0);
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(value);
  if (visibleWidth(plain) <= width) return value;
  const target = Math.max(0, width - 1);
  let used = 0;
  let result = "";
  for (const character of plain) {
    const cells = cellWidth(character);
    if (used + cells > target) break;
    result += character;
    used += cells;
  }
  return `${result}…`;
}

export function pad(value: string, width: number): string {
  const fitted = truncate(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

export function center(value: string, width: number): string {
  const fitted = truncate(value, width);
  const left = Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2));
  return `${" ".repeat(left)}${fitted}`;
}

/**
 * Wrap on word boundaries, breaking a word only when it cannot fit a whole
 * line. Explicit newlines are preserved as paragraph breaks so a multiline
 * question or option keeps its shape.
 */
export function wrap(value: string, width: number): readonly string[] {
  if (width <= 0) return [];
  const rows: string[] = [];
  for (const paragraph of stripAnsi(value).split("\n")) {
    if (!paragraph.trim()) {
      rows.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) rows.push(line);
      if (visibleWidth(word) <= width) {
        line = word;
        continue;
      }
      let rest = word;
      while (visibleWidth(rest) > width) {
        let taken = "";
        let used = 0;
        for (const character of rest) {
          const cells = cellWidth(character);
          if (used + cells > width) break;
          taken += character;
          used += cells;
        }
        rows.push(taken);
        rest = rest.slice(taken.length);
      }
      line = rest;
    }
    if (line) rows.push(line);
  }
  return rows.length ? rows : [""];
}

/** Wrap a raw buffer without collapsing whitespace, for a live text editor. */
export function wrapVerbatim(value: string, width: number): readonly string[] {
  if (width <= 0) return [""];
  const rows: string[] = [];
  let line = "";
  for (const character of value) {
    if (character === "\n") {
      rows.push(line);
      line = "";
      continue;
    }
    if (visibleWidth(line) + cellWidth(character) > width) {
      rows.push(line);
      line = "";
    }
    line += character;
  }
  rows.push(line);
  return rows;
}

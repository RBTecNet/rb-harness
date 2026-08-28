function normalizeLogicalPath(value: string): string {
  if (value.trim() === "${RB_VERIFY_ROOT}") return ".";
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\$\{RB_VERIFY_ROOT\}\/?/, "")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function globExpression(value: string): RegExp {
  let source = "^";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "*") {
      if (value[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

/** Whether one declared ownership token owns a concrete project-relative path. */
export function scopeTokenCoversPath(rawToken: string, rawPath: string): boolean {
  const token = normalizeLogicalPath(rawToken);
  const path = normalizeLogicalPath(rawPath);
  if (!token || !path) return false;
  if (/[*?]/.test(token)) return globExpression(token).test(path);
  return path === token || path.startsWith(`${token}/`);
}

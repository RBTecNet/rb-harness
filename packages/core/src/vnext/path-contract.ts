/**
 * Provider-facing and Core-owned syntax for one project-relative ownership
 * token. Directory ownership is represented without a trailing slash; bounded
 * globs remain valid, while project-wide globs do not.
 */
export const PROJECT_RELATIVE_PATH_PATTERN = "^(?![A-Za-z]:/)(?!(?:\\*|\\*\\*|\\*\\*/\\*)$)(?:(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000\\n\\r\\t`]+)(?:/(?:(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000\\n\\r\\t`]+))*$";

const PROJECT_RELATIVE_PATH = new RegExp(PROJECT_RELATIVE_PATH_PATTERN);

export function projectRelativePathSyntaxIsSafe(value: string): boolean {
  return PROJECT_RELATIVE_PATH.test(value);
}

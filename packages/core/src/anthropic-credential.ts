export const ANTHROPIC_WORKSPACE_ID_PATTERN = /^wrkspc_[A-Za-z0-9]+$/;

export function isAnthropicWorkspaceId(value: string): boolean {
  return ANTHROPIC_WORKSPACE_ID_PATTERN.test(value);
}

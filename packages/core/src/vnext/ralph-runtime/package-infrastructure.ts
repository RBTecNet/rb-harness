export const WORKSPACE_PACKAGE_INFRASTRUCTURE_ROOTS_V1: readonly string[] = Object.freeze([".npm", "node_modules"]);

export function isWorkspacePackageInfrastructurePathV1(path: string): boolean {
  return WORKSPACE_PACKAGE_INFRASTRUCTURE_ROOTS_V1.some((root) => path === root || path.startsWith(`${root}/`));
}

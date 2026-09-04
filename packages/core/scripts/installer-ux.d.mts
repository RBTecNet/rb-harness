export interface InstallerPackageMetadata {
  readonly name?: string;
  readonly version?: string;
}

export declare function pathContainsDirectory(
  pathValue: unknown,
  directory: unknown,
  separator?: string,
): boolean;

export declare function pathGuidance(pathValue: unknown, binDirectory: string): string | undefined;

export declare function canonicalPublicInstallCommand(metadata: InstallerPackageMetadata): string;

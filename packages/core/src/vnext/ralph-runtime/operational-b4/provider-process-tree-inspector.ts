import { liveTreeMembers, readProcessTable } from "../../../process-tree.js";
import type { ProviderProcessTreeInspectorV2, ProviderProcessTreeStateV2 } from "./opencode-cli-observer.js";

/**
 * Real Linux process-group/tree observation for the durable M4-A worker.
 * An unreadable process table is UNKNOWN, never an empty tree.
 */
export class LinuxProviderProcessTreeInspectorV2 implements ProviderProcessTreeInspectorV2 {
  inspect(input: { readonly processIdentity: { readonly pid: number }; readonly processGroupId: number | null }): ProviderProcessTreeStateV2 {
    if (process.platform === "win32" || input.processGroupId === null || input.processGroupId < 1 || input.processIdentity.pid < 1) return "UNKNOWN";
    const rows = readProcessTable();
    if (rows === undefined) return "UNKNOWN";
    const members = new Set(liveTreeMembers(input.processIdentity.pid, rows));
    for (const row of rows) {
      if (row.groupId === input.processGroupId && !row.zombie) members.add(row.pid);
    }
    return members.size > 0 ? "ACTIVE" : "QUIESCENT";
  }
}

export const realProviderProcessTreeInspectorV2: ProviderProcessTreeInspectorV2 = Object.freeze(new LinuxProviderProcessTreeInspectorV2());

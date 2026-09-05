import type { BudgetUsage } from "./contracts.js";

export function deriveBudgetUsage(used: number, limit: number): BudgetUsage {
  if (!Number.isSafeInteger(used) || used < 0) throw new Error("RALPH_INVALID_BUDGET_USED");
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("RALPH_INVALID_BUDGET_LIMIT");
  return {
    used,
    limit,
    remaining: Math.max(limit - used, 0),
    exhausted: used >= limit,
    exceeded: used > limit,
  };
}

/** The current operation may finish at the limit; only the next operation is denied. */
export function canStartBudgetedOperation(usage: BudgetUsage): boolean {
  return !usage.exceeded && usage.used < usage.limit;
}

export function canCompleteCurrentBudgetedOperation(usage: BudgetUsage): boolean {
  return !usage.exceeded;
}

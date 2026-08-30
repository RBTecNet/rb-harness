export const CANONICAL_INIT_RECOVERY_BUDGET = Object.freeze({
  maxCorrectiveRegenerationsPerSlice: 2,
  maxCorrectiveRegenerationsPerRun: 3,
  maxSemanticOperationsPerRun: 5,
  maxTransportInvocationsPerRun: 7,
  maxTransportRetriesPerSemanticOperation: 1,
  maxTransportRetriesPerRun: 2,
} as const);

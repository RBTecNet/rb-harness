export type IrInvariantId =
  | "I-01" | "I-02" | "I-03" | "I-04" | "I-05"
  | "I-06" | "I-07" | "I-08" | "I-09" | "I-10"
  | "I-11" | "I-12" | "I-13" | "I-14" | "I-15"
  | "I-16" | "I-17" | "I-18" | "I-19" | "I-20";

export type FindingClass = "semantic-invalid" | "user-decision-required" | "fatal";

export interface Finding {
  readonly invariant: IrInvariantId;
  readonly classification: FindingClass;
  readonly message: string;
  readonly pointer: string;
  readonly offending?: readonly string[];
}

export interface ValidationOutcome {
  readonly valid: boolean;
  readonly findings: readonly Finding[];
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly Finding[] };


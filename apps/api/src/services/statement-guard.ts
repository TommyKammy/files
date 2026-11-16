/**
 * Optional predicate that makes a batched insert conditional on the mutation it
 * documents having actually applied (e.g. an optimistic-lock guarded restore).
 */
export interface ConditionalWriteGuard {
  /** SQL predicate appended after `WHERE`. */
  sql: string;
  bindings?: ReadonlyArray<string | number | null>;
}

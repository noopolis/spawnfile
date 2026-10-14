/** Optimizer-safe projection of the public atomic grader feedback contract. */
export interface AtomicFeedback {
  failed_check_count: number;
  omitted_failed_checks: number;
  failed_checks: { template: string; unit: string; probability: number | null }[];
}

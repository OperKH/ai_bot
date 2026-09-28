/** What the crow's LLM calls have cost today; the day is UTC's, the bot's own, the same for every chat */
export interface BudgetState {
  day: string;
  spentUsd: number;
}

/** The UTC date of `now`, e.g. `2026-09-26` */
export function budgetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** When the next day's budget begins: the coming UTC midnight */
export function nextBudgetDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Today's spending, starting from zero on a new day */
export function today(state: BudgetState | undefined, now: Date): BudgetState {
  const day = budgetDay(now);
  return state?.day === day ? state : { day, spentUsd: 0 };
}

export function spend(state: BudgetState | undefined, now: Date, costUsd: number): BudgetState {
  const current = today(state, now);
  return { day: current.day, spentUsd: current.spentUsd + costUsd };
}

/**
 * Whether new arcs may still be written today. A guard against a bug that
 * writes in circles more than a limit on normal use: a day of news costs
 * about a quarter of the default limit.
 */
export function withinBudget(state: BudgetState | undefined, now: Date, limitUsd: number): boolean {
  return today(state, now).spentUsd < limitUsd;
}

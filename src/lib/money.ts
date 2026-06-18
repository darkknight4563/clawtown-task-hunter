// Money helpers for the play-money ledger.
//
// v1 uses Float columns; a production system handling real value would use
// integer minor-units or Decimal. We round to 2dp at every boundary to keep
// floating-point drift out of balances.

export const STAKE_RATIO = 0.1; // agent stakes 10% of their bid

export const SYSTEM_ACCOUNTS = {
  escrow: "escrow",
  escrowStake: "escrow_stake",
  platform: "platform",
} as const;

export type SystemAccountOwner =
  (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS];

/** Round to 2 decimal places. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Stake required for a given bid amount. */
export function stakeFor(bidAmount: number): number {
  return round2(bidAmount * STAKE_RATIO);
}

/** Format an amount for display, e.g. "1,250.00 TTT". */
export function formatAmount(amount: number, currency = "TTT"): string {
  return `${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

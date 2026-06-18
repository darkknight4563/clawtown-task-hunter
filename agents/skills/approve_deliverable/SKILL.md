---
name: approve_deliverable
description: |
  Creator/admin action: approve a submitted deliverable, release escrow+stake.
  Usage: node run.js <task_id> [deliverable_id]
  Validates task=awarded/delivered, escrow+stake locks exist.
  Creates LedgerTx PAYOUT(bid_amount) + REFUND(budget-bid) + STAKE_RELEASE.
  Updates balances/reserved. Sets Task=completed, Deliverable=approved, Stake=released.
  Emits TASK_STATUS_CHANGED (hunters) + PAYOUT/REFUND/STAKE_RELEASE (audit).
  AuditLog run_type=deliverable_approved with tx ids.
  Idempotency keys on all payout/refund/stake_release txs to prevent double-pay.
  Guards: writes_enabled → SYSTEM_ALERT + skip ledger mutations.
---

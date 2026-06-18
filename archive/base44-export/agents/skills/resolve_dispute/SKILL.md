---
name: resolve_dispute
description: |
  Admin resolves a dispute with a split payout.
  Usage: node run.js <task_id> <creator_pct> <agent_pct> [slash_stake=true|false] [resolution_notes]
  pct pair must sum to 100. Distributes escrow proportionally.
  Optionally slashes agent stake (stake_slash tx, Stake{status=slashed}).
  Updates Dispute{status=resolved_split|resolved_creator|resolved_agent}, Task{status=completed}.
  Emits DISPUTE_RESOLVED (audit+hunters), STAKE_SLASH if applicable.
  AuditLog run_type=dispute_resolved.
  Guards: writes_enabled, idempotency on payout txs.
---

---
name: award_task
description: Two-step task award flow. Step 1 (prepare): validates balances/stakes, returns a summary for confirmation. Step 2 (confirm): executes award, escrow lock, stake creation, notifications. Never awards without explicit CONFIRM AWARD.
argument-hint: <task_id> <agent_handle> <step: prepare|confirm>
---

## Flow
1. Agent receives: AWARD <task_id> <agent_handle>  → runs with step=prepare
2. Returns summary to user. User must send: CONFIRM AWARD
3. Agent runs with step=confirm → executes award

## Safety checks (both steps)
- Bid must exist with status=pending or auto for this agent+task
- Creator LedgerAccount must have balance >= bid_amount (if account exists)
- Agent must be active and not suspended
- Task must be in open or bidding status
- If any check fails: do NOT change any status, log error in AuditLog, return clear error message

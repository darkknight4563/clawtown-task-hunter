---
name: process_new_task
description: Runs the full ClawTown pipeline for a newly created task. Classifies, matches top agents, enforces one-bid-per-agent-per-task, places ONE auto-bid from top-ranked agent only (if rules pass), queues EventOutbox notifications, and writes an AuditLog record.
argument-hint: <task_id>
---

## Rules enforced
1. One active bid per agent per task — checks for existing non-final bids (pending/auto) before creating. If duplicate detected, updates existing bid instead of creating new.
2. Auto-bid fires ONLY for top-ranked agent. No manual variants unless PLACE VARIANT BIDS is explicitly requested.
3. AuditLog record written for every run with matches, bids placed/skipped, notifications, errors.
4. Never changes task status to awarded/completed — that is a separate two-step flow.

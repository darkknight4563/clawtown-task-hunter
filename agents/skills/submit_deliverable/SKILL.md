---
name: submit_deliverable
description: |
  Worker action: submit a deliverable for an awarded task.
  Usage: node run.js <task_id> <agent_id> <title> <content_or_link>
  Creates Deliverable{status=submitted}, updates Task{status=delivered,last_activity_at},
  emits DELIVERABLE_SUBMITTED (hunters) + CREATOR_DM (if creator slack id known),
  writes AuditLog{run_type=deliverable_submitted}.
  Guards: writes_enabled. Propagates is_test.
---

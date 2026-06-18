---
name: open_dispute
description: |
  Open a dispute on an awarded/in_progress/delivered task.
  Usage: node run.js <task_id> <raised_by_slack_user_id> <reason_text>
  Creates Dispute{status=open}, updates Task{status=disputed},
  emits DISPUTE_OPENED (alerts + audit), AGENT_DM + CREATOR_DM.
  AuditLog run_type=dispute_opened.
  Guards: writes_enabled.
---

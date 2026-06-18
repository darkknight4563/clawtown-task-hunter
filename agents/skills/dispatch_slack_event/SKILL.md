---
name: dispatch_slack_event
description: Dispatches pending EventOutbox records to Slack. Supports mode=sweep (batch) or mode=single (single event_id).
argument-hint: {"mode": "sweep"} or {"mode": "single", "event_id": "<id>"}
---

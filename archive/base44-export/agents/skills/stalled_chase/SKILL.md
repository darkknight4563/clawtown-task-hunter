---
name: stalled_chase
description: Every 2 hours, find tasks stuck in in_progress or delivered states with no recent activity. For each stale task: if stalled_pings_sent >= max_pings, emit INVARIANT_FAIL. Otherwise increment stalled_pings_sent, set last_activity_at, emit STALLED_CHASE. Always emit STALLED_CHASE_SUMMARY + AuditLog. Guards on stalled_chase_enabled and writes_enabled.
---

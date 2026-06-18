---
name: no_bid_rescue
description: Hourly loop to nudge stuck tasks with 0 bids. Finds open/bidding tasks older than min_age_minutes with budget >= min_budget_ttt, increments rescue_reminders_sent counter, suggests top-3 matching agents by tag overlap, emits N NO_BID_RESCUE records + 1 NO_BID_RESCUE_SUMMARY, writes AuditLog. Guards on no_bid_rescue_enabled and writes_enabled.
---

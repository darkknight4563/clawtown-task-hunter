---
name: market_pulse
description: Daily 24-hour marketplace digest. Computes task/bid/ledger/outbox stats, emits ONE EventOutbox MARKET_PULSE record → dispatcher posts to #clawtown-task-hunters. Guards on market_pulse_enabled PlatformSetting.
---

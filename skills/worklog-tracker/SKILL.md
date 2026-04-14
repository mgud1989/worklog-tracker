---
name: worklog-tracker
description: Manage Toggl time tracking and Tempo worklog consolidation during coding sessions
triggers:
  - session start
  - session resume
  - commit
  - push
  - task completion
  - worklog
  - toggl
  - tempo
  - time tracking
  - horas
---

# Worklog Tracker Skill

You have access to a Toggl + Tempo MCP server (`toggl`) for time tracking.

## Toggl Timer (Automatic)

Toggl timers are now managed AUTOMATICALLY by session hooks. You do NOT need to start or stop timers.

- **SessionStart hook** auto-starts a Toggl timer with the current branch name
- **SessionEnd hook** auto-stops the running timer

No manual timer management is needed. If the dev asks about the timer, explain it runs automatically.

### When the dev asks about their time

Use `read_tracking_data` for Toggl entries or `tempo_read_worklogs` for Tempo worklogs.

## Nudge System (Automatic)

MCP tool responses include reminders about unpushed sessions. When you see a nudge:

1. Mention it to the dev naturally (e.g., "By the way, you have unpushed sessions from today")
2. Offer to run `preview_tempo_push` so they can review
3. Do NOT push without their explicit confirmation

## Push Workflow

When the dev asks to consolidate or push hours:

1. **ALWAYS** use `preview_tempo_push` first to show a summary of session-based work time
2. Let the dev review -- they may want to change issue keys, merge entries, or adjust
3. Push ONLY after explicit confirmation via `push_tempo_worklogs`

Use `tempo_delete_worklog` if the dev needs to fix a bad push.

## Rules

- NEVER push to Tempo without the dev reviewing the preview and confirming
- Session logs (ACTIVITY-based) measure time WITH Claude. Toggl measures total dev time. They are different
- Timer is automatic -- do not start/stop timers manually unless the dev explicitly asks
- For Tempo push: the dev validates and confirms before anything goes to Tempo

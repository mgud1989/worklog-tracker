---
name: worklog-tracker
description: Manage session-based Tempo worklog consolidation during coding sessions
triggers:
  - session start
  - session resume
  - commit
  - push
  - task completion
  - worklog
  - tempo
  - time tracking
  - horas
---

# Worklog Tracker Skill

You have access to the `worklog-tracker` MCP server for Tempo worklog workflows. Bash hooks log sessions; you handle review/push to Tempo with the dev.

## How time tracking works

- **SessionStart hook** (bash) logs `START` to `.logs/session-YYYY-MM.log`.
- **Stop hook** (bash) logs `ACTIVITY` on every Claude response.
- **SessionEnd hook** (bash) logs `STOP`.
- **UserPromptSubmit hook** runs `nudge-check` on every user prompt — its stdout is injected into your context, so you may see push reminders even without calling any MCP tool.

## Push Workflow (session-log → Tempo)

When the dev asks to push hours / consolidate / "subir worklogs":

1. **ALWAYS** call `preview_tempo_push` first — it parses session logs, consolidates by branch/day, detects already-pushed worklogs (via `[session:id]` markers), and shows a table with issue keys, hours, and unmapped branches.
2. Let the dev review. They may want to fix issue keys (extracted from branch names like `feature/PROJ-123-foo`), merge entries, or skip a branch.
3. Only after explicit confirmation call `push_tempo_worklogs` with the worklog list from the preview.

Use `tempo_delete_worklog` if a bad push needs reverting (find the ID via `tempo_read_worklogs`).

## Nudge System

`UserPromptSubmit` hook runs `nudge-check` and injects reminders into your context when:
- There are unpushed sessions older than `pushReminderAfterHours` (default 4h)
- It's past `endOfDayHour` (default 19)
- Cooldown of `cooldownMinutes` (default 30) has elapsed since the last nudge

When you see a nudge:
1. Mention it naturally to the dev ("By the way, you have unpushed sessions from today")
2. Offer to run `preview_tempo_push`
3. Do NOT push without explicit confirmation

## Rules

- NEVER push to Tempo without the dev reviewing the preview and confirming
- Session logs (ACTIVITY-based) measure time WITH Claude
- For Tempo push: dev validates and confirms before anything goes to Tempo

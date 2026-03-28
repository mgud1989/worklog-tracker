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

## Toggl Timer Management

Toggl timers are YOUR responsibility. Hooks only handle session logs — you manage the timer with context and judgment.

### When a session starts or resumes

1. Check if there's a running timer via `smart_timer_control` or `read_tracking_data`
2. If running with the same branch/task → do nothing, mention it's already running
3. If running with a different task → ask the dev: "Tenés un timer corriendo con X, ¿lo cambio a Y?"
4. If no timer running → suggest starting one with the current branch or task name. Ask first, don't auto-start

### When the dev commits, pushes, or completes a task

Ask: "¿Cierro el timer de Toggl o seguís trabajando en esto?"
Do NOT stop the timer without asking.

### When the dev asks to consolidate or push hours

1. Use `preview_tempo_push` to show a summary of session-based work time
2. Let the dev review — they may want to change issue keys, merge entries, or adjust
3. Push only after confirmation via `push_tempo_worklogs`

### When the dev asks about their time

Use `read_tracking_data` for Toggl entries or `tempo_read_worklogs` for Tempo worklogs.

## Rules

- NEVER start or stop a Toggl timer without asking the dev first
- ALWAYS check for a running timer before suggesting a new one
- Session logs (ACTIVITY-based) measure time WITH Claude. Toggl measures total dev time. They are different
- For Tempo push: the dev validates and confirms before anything goes to Tempo
- Use `tempo_delete_worklog` if the dev needs to fix a bad push

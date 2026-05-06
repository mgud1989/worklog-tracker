# Skill Registry — worklog-tracker
Generated: 2026-05-06

## User Skills (`~/.claude/skills/`)

| Name | Path | Triggers |
|------|------|----------|
| architecture-cross-account-monitoring | `~/.claude/skills/architecture-cross-account-monitoring/SKILL.md` | monitoring, observability, logs, metrics, debugging, health check |
| billing-tasks | `~/.claude/skills/billing-tasks/SKILL.md` | billing report, billing tasks, reporte mensual |
| budget-investigate | `~/.claude/skills/budget-investigate/SKILL.md` | budget, alerta de budget, investigar costos |
| forja | `~/.claude/skills/forja/SKILL.md` | creating/linking/managing skills or agents, symlinks, manifest.yaml, sources.yaml |
| go-testing | `~/.claude/skills/go-testing/SKILL.md` | Go tests, teatest, Bubbletea TUI testing |
| janis-agent-analysis | `~/.claude/skills/janis-agent-analysis/SKILL.md` | janis agent, token usage, tenant analysis, agent monitoring |
| monitoring-access-logs | `~/.claude/skills/monitoring-access-logs/SKILL.md` | api gateway, access logs, 5xx errors, latency, api errors |
| monitoring-lambda-logs | `~/.claude/skills/monitoring-lambda-logs/SKILL.md` | lambda logs, lambda errors, cloudwatch logs |
| monitoring-metrics | `~/.claude/skills/monitoring-metrics/SKILL.md` | metrics, metrics insights, sqs queue, lambda errors count |
| skill-creator | `~/.claude/skills/skill-creator/SKILL.md` | create skill, add agent instructions, document patterns |
| sqs-optimizer | `~/.claude/skills/sqs-optimizer/SKILL.md` | optimize SQS, tune SQS consumer, batch size, concurrency |
| worklog-tracker | `skills/worklog-tracker/SKILL.md` | session start, session resume, commit, push, worklog, toggl, tempo, time tracking, horas |

## SDD Skills (`~/.claude/skills/`)

| Name | Path |
|------|------|
| sdd-init | `~/.claude/skills/sdd-init/SKILL.md` |
| sdd-explore | `~/.claude/skills/sdd-explore/SKILL.md` |
| sdd-propose | `~/.claude/skills/sdd-propose/SKILL.md` |
| sdd-spec | `~/.claude/skills/sdd-spec/SKILL.md` |
| sdd-design | `~/.claude/skills/sdd-design/SKILL.md` |
| sdd-tasks | `~/.claude/skills/sdd-tasks/SKILL.md` |
| sdd-apply | `~/.claude/skills/sdd-apply/SKILL.md` |
| sdd-verify | `~/.claude/skills/sdd-verify/SKILL.md` |
| sdd-archive | `~/.claude/skills/sdd-archive/SKILL.md` |
| sdd-onboard | `~/.claude/skills/sdd-onboard/SKILL.md` |

## Project Convention Files

- Global CLAUDE.md: `~/.claude/CLAUDE.md` (applies to all projects)
- No project-level CLAUDE.md, agents.md, or .cursorrules in worklog-tracker root

## Compact Rules

### worklog-tracker (session / time-tracking)
- Do NOT start/stop Toggl timer manually — hooks do it automatically
- Use `read_tracking_data` MCP tool to inspect current timer state
- Use `push_tempo_worklogs` / `sync_toggl_range_to_tempo` for Tempo sync
- Mode driven by `mcp.config.json` (toggl-only, tempo-only, or full)

### General (from ~/.claude/CLAUDE.md)
- Conventional commits, NO AI attribution in commits
- Never build after changes (`tsc` not run unless explicitly requested)
- Use bat/rg/fd/sd/eza — NOT cat/grep/find/sed/ls
- Rioplatense Spanish for Spanish input, warm English for English input

## Notes

- SDD phase skills (`sdd-*`) are invoked by the orchestrator directly — not listed in User Skills
- `_shared/` convention files are not listed — loaded by skills that need them
- worklog-tracker skill: project-level (`skills/worklog-tracker/SKILL.md`) wins over user-level

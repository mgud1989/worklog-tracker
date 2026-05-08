# Worklog Tracker

Tracker de horas para sesiones de Claude Code. Combina hooks bash, un MCP server Node/TypeScript y una CLI para registrar, consolidar y pushear worklogs a Tempo/Jira.

## Que hace

- **Session logger** — hooks de Claude Code registran START / ACTIVITY / STOP de cada sesión por branch + folder en `.logs/session-YYYY-MM.log`
- **Tempo push session-based** — la CLI y el MCP consolidan los logs de sesión en worklogs por branch/día, deduplican contra Tempo via marker `[session:id]` y permiten preview antes de pushear
- **Nudges** — hook `UserPromptSubmit` inyecta recordatorios al agente cuando hay sesiones sin pushear (cooldown configurable)

## Quick Start

```bash
git clone <repo-url> && cd worklog-tracker
./install.sh
```

`install.sh` es idempotente:
1. Verifica node v20+, npm, jq
2. Instala dependencias y compila a `dist/`
3. Crea `.env` y `mcp.config.json` desde los ejemplos (no los pisa)
4. Mergea hooks globales en `~/.claude/settings.json` (preserva otros hooks que tengas)
5. Symlinkea la skill a `~/.claude/skills/worklog-tracker/SKILL.md` (futuras updates por `git pull`)
6. Registra el MCP server en Claude Code (`claude mcp add worklog-tracker -s user`)

Después editás:
1. **`.env`** — tokens de Tempo, Jira
2. **`mcp.config.json`** — `defaultIssueKey`, etc.
3. Reiniciás Claude Code para que tome los hooks, la skill y el MCP server.

## Configuración

### `.env`

| Variable | Descripción |
|----------|-------------|
| `TEMPO_API_TOKEN` | Token de Tempo. Requerido para tools de Tempo |
| `JIRA_BASE_URL` | URL de la org (`https://tu-org.atlassian.net`). Requerido para Tempo |
| `JIRA_API_TOKEN` | Token de Jira. Requerido para Tempo |
| `JIRA_EMAIL` | Email de Atlassian. Requerido si `JIRA_AUTH_TYPE=basic` |
| `JIRA_AUTH_TYPE` | `basic` (default) o `bearer` |
| `JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID` | Opcional: ID del custom field de Tempo Account (sin prefijo `customfield_`) |
| `DOTENV_PATH` | Opcional: path explícito al `.env` |

El loader busca `.env` en este orden: `DOTENV_PATH` > junto a `MCP_CONFIG_PATH` > project root > `cwd`. Esto permite que la CLI funcione desde cualquier directorio.

### `mcp.config.json`

```json
{
  "timezone": "America/Argentina/Buenos_Aires",
  "defaultIssueKey": "INFRAV2-543",
  "defaultWorkAttributes": "Desarrollo e Implementacion",
  "inactivityThresholdMinutes": 10,
  "logRetentionMonths": 3,
  "nudge": {
    "enabled": true,
    "cooldownMinutes": 30,
    "pushReminderAfterHours": 4
  }
}
```

| Campo | Descripción |
|-------|-------------|
| `timezone` | Timezone IANA del equipo |
| `defaultIssueKey` | Issue fallback cuando no se detecta una key en branch o descripción |
| `defaultWorkAttributes` | String o array `[{key,value}]` para atributos default de Tempo |
| `inactivityThresholdMinutes` | Gap entre ACTIVITY logs que cierra una "ventana" de trabajo (default 10) |
| `logRetentionMonths` | Meses de logs de sesión que se conservan en `.logs/` (default 3) |
| `nudge.enabled` | Master switch (default `true`) |
| `nudge.cooldownMinutes` | Cooldown entre nudges para no spamear al dev (default 30) |
| `nudge.pushReminderAfterHours` | Umbral de horas sin pushear para disparar el recordatorio de push-overdue (default 4) |

> **Nudge flow**: el primer prompt de cada día calendario dispara un saludo de buenos días (con o sin sesiones pendientes según el estado). Después del saludo, si quedan sesiones sin pushear y pasaron más de `pushReminderAfterHours` desde el último push, se vuelve a recordar. Cooldown global (`cooldownMinutes`) evita repeticiones dentro del mismo bloque de tiempo.

## Hooks de Claude Code

Se instalan en `~/.claude/settings.json` y corren globalmente:

| Evento | Comando | Acción |
|--------|---------|--------|
| `SessionStart` | `hooks/session-logger.sh start` | Loggea `START` en `.logs/session-YYYY-MM.log` |
| `Stop` | `hooks/session-logger.sh activity` | Loggea `ACTIVITY` después de cada respuesta del agente |
| `SessionEnd` | `hooks/session-logger.sh stop` | Loggea `STOP` en `.logs/session-YYYY-MM.log` |
| `UserPromptSubmit` | `node dist/cli.js nudge-check` | Inyecta reminders al agente si hay sesiones sin pushear |

El `folder` es el basename del repo (`git rev-parse --show-toplevel`) o del cwd si no es git. El `branch` es `git branch --show-current`. Todo log queda en `.logs/session-YYYY-MM.log`.

Para remover hooks: `scripts/setup-global-hooks.sh --remove` (preserva otros hooks que tengas instalados).

## CLI

Todos los comandos resuelven sus paths relativos al repo (cwd-independent):

```bash
node dist/cli.js tempo push [--date today|YYYY-MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run]
node dist/cli.js nudge-check
```

- **`tempo push`** — parsea logs, consolida, detecta duplicados contra Tempo y pushea. `--dry-run` solo muestra el preview. Mutuamente excluyentes: `--date` vs `--from/--to`
- **`nudge-check`** — invocado por el hook `UserPromptSubmit`. Output silencioso si no hay nada que avisar; nunca falla con exit ≠ 0 (no debe bloquear el prompt del dev)

## Tools MCP

### Session-log (siempre disponibles)

- **`preview_tempo_push`** — parsea session logs, consolida por branch/día, filtra ya pusheados (marker `[session:id]`) y devuelve preview con horas, issue keys y branches sin mapear. Inputs: `date` o `from`/`to`

### Tempo (si hay tokens Tempo+Jira)

- **`tempo_create_worklog`** — crea worklog (`issueKey`, `timeSpentHours`, `date`, `description?`, `startTime?`, `workAttributes?`)
- **`tempo_read_worklogs`** — lista worklogs del usuario en un `startDate`/`endDate`
- **`tempo_delete_worklog`** — borra worklog por `tempoWorklogId`
- **`push_tempo_worklogs`** — pushea worklogs confirmados desde el output de `preview_tempo_push`. Incluye marker `[session:id]` en la descripción para dedup

## Skill de Claude Code

`skills/worklog-tracker/SKILL.md` define cómo el agente maneja el push workflow y los nudges. **`install.sh` la symlinkea automáticamente** a `~/.claude/skills/worklog-tracker/SKILL.md`, así que cualquier `git pull` futuro la actualiza sin re-correr el install.

Claude Code la auto-descubre por su frontmatter (`name` + `description`) — no hace falta editar `~/.claude/CLAUDE.md`.

Si por algún motivo querés instalarla a mano (ej. en una máquina sin acceso a este repo):

```bash
mkdir -p ~/.claude/skills/worklog-tracker
ln -s "$(pwd)/skills/worklog-tracker/SKILL.md" ~/.claude/skills/worklog-tracker/SKILL.md
```

Sin la skill, el MCP server sigue funcionando — solo perdés el comportamiento guiado del agente (preview → confirm → push, manejo de nudges).

## MCP Client Config (manual)

Si no usaste `install.sh` y querés registrar a mano:

```json
{
  "mcpServers": {
    "worklog-tracker": {
      "command": ["node", "/ABSOLUTE/PATH/worklog-tracker/dist/index.js"],
      "env": {
        "MCP_CONFIG_PATH": "/ABSOLUTE/PATH/worklog-tracker/mcp.config.json"
      }
    }
  }
}
```

Usá rutas absolutas para evitar problemas de `cwd`.

## Getting API Tokens

1. **Tempo** — Tempo > Settings > API Integration → crear token
2. **Jira** — [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) → crear token

## Uninstall

```bash
scripts/setup-global-hooks.sh --remove                # quita SOLO los hooks de wt (preserva otros)
rm ~/.claude/skills/worklog-tracker/SKILL.md           # quita el symlink de la skill
claude mcp remove worklog-tracker -s user              # desregistra el MCP server
```

`.env`, `mcp.config.json` y `.logs/` quedan intactos — borralos a mano si querés un cleanup total.

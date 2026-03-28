# Toggl + Tempo MCP Server

Servidor MCP para tracking automático en Toggl y carga de horas en Tempo/Jira desde agentes IA (Claude Code, Cursor, etc.).

## Quick Start

```bash
git clone <repo-url> && cd toggl-mcp
./install.sh
```

El script instala dependencias, compila, crea archivos de config y configura los hooks globales de Claude Code.

Despues edita:
1. **`.env`** — tus API tokens (Toggl, Tempo, Jira)
2. **`mcp.config.json`** — tu `workspaceId` de Toggl

Listo.

## Que hace

- **MCP Server**: expone herramientas para registrar/editar tiempo en Toggl, crear worklogs en Tempo y sincronizar entre ambos.
- **Claude Code Hooks**: arranca y para el timer de Toggl automaticamente con cada sesion de Claude Code.
- **CLI**: `node dist/cli.js` para control manual del timer.

## Configuracion

### `.env`

| Variable | Descripcion |
|----------|-------------|
| `TOGGL_API_TOKEN` | Token de API de Toggl |
| `TEMPO_API_TOKEN` | Token de API de Tempo |
| `JIRA_BASE_URL` | URL de tu org (`https://tu-org.atlassian.net`) |
| `JIRA_API_TOKEN` | Token de API de Jira |
| `JIRA_EMAIL` | Tu email de Atlassian |
| `JIRA_AUTH_TYPE` | `basic` (default) o `bearer` |
| `JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID` | Opcional: ID del custom field de Tempo Account |

El servidor carga `.env` desde `process.cwd()`. Para otra ubicacion: `DOTENV_PATH=/ruta/al/.env`.

### `mcp.config.json`

```json
{
  "workspaceId": "8167186",
  "timezone": "America/Argentina/Buenos_Aires",
  "defaultIssueKey": "INFRAV2-543",
  "defaultWorkAttributes": "Desarrollo e Implementacion"
}
```

- `workspaceId` — lo encontras en la URL de Toggl: `track.toggl.com/{workspaceId}/...`
- `timezone` — timezone del equipo
- `defaultIssueKey` — fallback para sync cuando la entrada no tiene issue key
- `defaultWorkAttributes` — puede ser string o array de `{ key, value }`

## Claude Code Hooks

Los hooks se instalan globalmente en `~/.claude/settings.json` y corren en TODA sesion:

| Evento | Accion |
|--------|--------|
| **SessionStart** | Log de inicio de sesion |
| **Stop** | Registra actividad (cada respuesta de Claude) |
| **SessionEnd** | Log de cierre de sesion |

Los hooks solo registran session logs. El timer de Toggl lo maneja Claude via la skill `worklog-tracker` con supervision del dev.

Para remover: `scripts/setup-global-hooks.sh --remove`

## Skill de Toggl (opcional)

Para que Claude maneje el timer de Toggl con contexto (sugiere iniciar/parar, consulta antes de actuar):

1. Copia `skills/worklog-tracker/SKILL.md` a `~/.claude/skills/worklog-tracker/SKILL.md`
2. Agrega en tu `~/.claude/CLAUDE.md` la referencia a la skill:

```markdown
| Session start, resume, commit, push, time tracking, toggl, tempo, horas | `~/.claude/skills/worklog-tracker/SKILL.md` |
```

Sin la skill, igual podes usar las tools de Toggl manualmente pidiendole a Claude.

## MCP Client Config

Agrega el servidor a tu cliente MCP (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "toggl": {
      "command": ["node", "/ABSOLUTE/PATH/toggl-mcp/dist/index.js"],
      "env": {
        "MCP_CONFIG_PATH": "/ABSOLUTE/PATH/toggl-mcp/mcp.config.json"
      }
    }
  }
}
```

Usa rutas absolutas para evitar problemas de `cwd`.

## Tools MCP

### Toggl

- **`log_work_entry`** — crea entrada cerrada (`description`, `timeRange`, `project?`, `tags?`)
- **`smart_timer_control`** — start/stop de timer (`action`, `description?`, `time?`, `project?`, `tags?`)
- **`read_tracking_data`** — lista entradas por rango (`timeRange`)
- **`update_work_entry`** — edita entrada existente (`entryId`, campos opcionales)

### Tempo

- **`tempo_create_worklog`** — crea worklog en Tempo/Jira (`issueKey`, `timeSpentHours`, `date`)
- **`tempo_read_worklogs`** — lista worklogs del usuario (`startDate`, `endDate`)

### Sync

- **`sync_toggl_range_to_tempo`** — sincroniza entradas de Toggl a Tempo por rango. Busca `ISSUE-123` en la descripcion; si no encuentra, usa `defaultIssueKey`. Evita duplicados con marcador `[toggl:<entryId>]`.

## Getting API Tokens

1. **Toggl** — [track.toggl.com/profile](https://track.toggl.com/profile) → scroll al fondo
2. **Tempo** — Tempo > Settings > API Integration → crear token
3. **Jira** — [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) → crear token

## Uninstall

```bash
scripts/setup-global-hooks.sh --remove
```

Esto remueve los hooks de `~/.claude/settings.json`. El resto del proyecto se borra manualmente.

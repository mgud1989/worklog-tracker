# Toggl + Tempo MCP Server

Servidor MCP en TypeScript para operar tracking en Toggl y carga de horas en Tempo/Jira desde agentes IA.

## Objetivo

- Exponer herramientas MCP para registrar/editar tiempo en Toggl.
- Exponer herramientas MCP para crear/consultar worklogs en Tempo.
- Sincronizar bloques cerrados de Toggl hacia Tempo con reglas de fallback.

## Requisitos

- Node.js 20+.
- `mcp.config.json` con `workspaceId` y `timezone`.
- Archivo `.env` con credenciales (no se recomienda hardcodear secretos en la config MCP del cliente).

## Configuración

### 1) Variables de entorno

Crea `.env` basado en `.env.example`:

```bash
TOGGL_API_TOKEN=...

TEMPO_API_TOKEN=...
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_API_TOKEN=...
JIRA_EMAIL=you@company.com
JIRA_AUTH_TYPE=basic
JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID=
```

Notas:
- El servidor carga `.env` automáticamente desde `process.cwd()`.
- Si necesitas otra ubicación, usa `DOTENV_PATH=/ruta/al/.env`.

### 2) Config MCP del servidor

Ejemplo de `mcp.config.json`:

```json
{
  "workspaceId": "8167186",
  "timezone": "America/Argentina/Buenos_Aires",
  "defaultIssueKey": "INFRAV2-543",
  "defaultWorkAttributes": "Desarrollo e Implementacion"
}
```

Notas:
- `defaultIssueKey` y `defaultWorkAttributes` se usan como fallback en `sync_toggl_range_to_tempo`.
- `defaultWorkAttributes` puede ser:
  - string: se interpreta como `_Tipotarea_` (caso Tempo común), o
  - array: `[{ "key": "_Tipotarea_", "value": "DesarrolloeImplementacion" }]`.

### 3) Config MCP del cliente (Cursor/Claude/etc.)

Usar ruta absoluta al build evita problemas de `cwd`:

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

## Scripts

- `npm run dev`: ejecuta server en modo desarrollo.
- `npm run build`: compila TypeScript a `dist/`.
- `npm run start`: ejecuta el build compilado.

## Tools MCP

### Toggl

- `log_work_entry`: crea entrada cerrada (`description`, `timeRange`, `project?`, `tags?`).
- `smart_timer_control`: start/stop de timer (`action`, `description?`, `time?`, `project?`, `tags?`).
- `read_tracking_data`: lista entradas por rango (`timeRange`).
- `update_work_entry`: edita entrada existente (`entryId`, `description?`, `start?`, `stop?`, `project?`, `tags?`).

### Tempo

- `tempo_create_worklog`: crea worklog en Tempo/Jira (`issueKey`, `timeSpentHours`, `date`, `description?`, `startTime?`, `workAttributes?`).
- `tempo_read_worklogs`: lista worklogs del usuario autenticado (`startDate`, `endDate`).

### Sync

- `sync_toggl_range_to_tempo`: sincroniza entradas cerradas de Toggl a Tempo por rango.
  - Busca `ISSUE-123` en la descripción de cada entrada.
  - Si no encuentra, usa `defaultIssueKey` (tool input o `mcp.config.json`).
  - Usa `defaultWorkAttributes` (tool input o `mcp.config.json`).
  - Evita duplicados con marcador en descripción de Tempo: `[toggl:<entryId>]`.

## Prácticas operativas recomendadas

- Rotar tokens periódicamente (Toggl, Tempo, Jira).
- No exponer `.env` en repositorio ni en logs.
- Mantener `timezone` único del equipo para evitar desfasajes de horas.

## Mantenimiento

- Documento de arquitectura y operación: `ARCHITECTURE.md`.

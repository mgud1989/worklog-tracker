# Auto Time Tracking — Spec & Diseño

## Objetivo

Automatizar el registro de horas trabajadas eliminando la carga manual, aprovechando que todo el equipo usa Claude Code y que la branch activa contiene el identificador de la tarea en Jira.

No se requiere precisión del 100%.

---

## Quick Start

### Prerequisitos

- Claude Code instalado
- Node.js 20+
- `jq` instalado (`brew install jq` en macOS, `apt install jq` en Ubuntu)
- El MCP server de Toggl configurado y funcionando (ver `README.md` del proyecto raíz)

### 1. Clonar y buildear

```bash
git clone <repo-url>
cd toggl-mcp
npm install
npm run build        # genera dist/cli.js
```

### 2. Configurar credenciales

Crear `.env` en la raíz del proyecto (ver `.env.example`):

```bash
TOGGL_API_TOKEN=tu_token_de_toggl
```

Crear `mcp.config.json` (ver `mcp.config.example.json`):

```json
{
  "workspaceId": "123456",
  "timezone": "America/Argentina/Buenos_Aires"
}
```

### 3. Verificar permisos del script

```bash
chmod +x session-logger/session-logger.sh
```

### 4. Configurar hooks en Claude Code

Agregar en `.claude/settings.local.json` (se crea por proyecto):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/session-logger/session-logger.sh start"
          },
          {
            "type": "command",
            "command": "BRANCH=$(git branch --show-current 2>/dev/null || echo 'no-branch') && node \"$CLAUDE_PROJECT_DIR\"/dist/cli.js timer start --description \"$BRANCH\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/session-logger/session-logger.sh activity"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/session-logger/session-logger.sh stop"
          },
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/dist/cli.js timer stop"
          }
        ]
      }
    ]
  }
}
```

### 5. Verificar que funciona

Iniciar una sesión de Claude Code en el proyecto. Deberías ver:
- Un timer activo en Toggl con el nombre de tu branch
- Una entrada `[START]` en `session-logger/.session-logs/session.log`

Al cerrar la sesión, el timer se detiene y se loggea `[STOP]`.

---

## Contexto y constraints

- Todo el equipo usa **Claude Code** en sus máquinas locales (macOS y Linux/Ubuntu)
- Las branches siguen el formato `PROJ-123-descripcion-breve` → Jira ID siempre disponible
- Ya existe un **MCP server en Node.js** corriendo en local via **stdio** con las herramientas:
  - `smart_timer_control(action, description)` — inicia o detiene un timer en Toggl
  - `log_work_entry(description, timeRange)` — crea una entrada cerrada
  - `read_tracking_data(timeRange)` — lee entradas en un rango
  - `update_work_entry(entryId, ...)` — edita una entrada existente
  - `sync_toggl_range_to_tempo(timeRange)` — sincroniza Toggl → Tempo
- En una sesión, el dev trabaja en **una sola branch**
- Los hooks de Claude Code son **shell scripts** — no pueden invocar el MCP stdio directamente
- Se creó un **CLI** (`src/cli.ts`) que reutiliza el adapter del MCP para exponer `timer start/stop` desde shell

---

## Arquitectura de la solución

```
Hooks de Claude Code (.claude/settings.local.json)
  │
  ├─ SessionStart (2 handlers, paralelos)
  │    ├─ session-logger.sh start     → loggea [START] en session.log
  │    └─ cli.js timer start          → inicia timer en Toggl con branch como description
  │
  ├─ Stop (1 handler)
  │    └─ session-logger.sh activity  → loggea [ACTIVITY] en session.log
  │
  ├─ SessionEnd (2 handlers, paralelos)
  │    ├─ session-logger.sh stop      → loggea [STOP] en session.log
  │    └─ cli.js timer stop           → detiene timer en Toggl
  │
  └─ Watchdog (invocación pendiente de definir)
       └─ session-logger.sh check    → evalúa actividad git, loggea [INACTIVITY] si inactivo
```

Los handlers del mismo evento corren **en paralelo e independientes**. Si uno falla, el otro sigue.

Las rutas en los hooks usan `$CLAUDE_PROJECT_DIR` para ser portables entre máquinas.

---

## Componentes

### 1. Session Logger (`session-logger/session-logger.sh`)

Script único que centraliza todo el logging de sesión en un solo archivo (`session-logger/.session-logs/session.log`).

**Acciones:**

| Parámetro  | Label          | Fuente de datos       | Requiere stdin |
| ---------- | -------------- | --------------------- | -------------- |
| `start`    | `[START]`      | Hook SessionStart     | Sí (JSON)      |
| `stop`     | `[STOP]`       | Hook SessionEnd       | Sí (JSON)      |
| `activity` | `[ACTIVITY]`   | Hook Stop             | Sí (JSON)      |
| `check`    | `[INACTIVITY]` | Git (watchdog)        | No             |

**Formato de log:**

```
dd-mm-yyyy HH:mm:ss - [LABEL] - Branch: <branch> - session: <session_id>
```

**Datos del hook (stdin JSON):**

Los hooks de Claude Code envían un JSON con:
- `session_id` — ID único de la sesión
- `transcript_path` — path al transcript
- `cwd` — working directory
- `hook_event_name` — nombre del evento
- `source` (SessionStart) — `startup` | `resume` | `clear` | `compact`
- `reason` (SessionEnd) — `clear` | `resume` | `logout` | `prompt_input_exit` | `other`
- `model` (SessionStart) — modelo usado

Actualmente solo se extrae `session_id`. El resto queda disponible para uso futuro.

**Watchdog (check):**

Evalúa actividad git en el repo. Solo loggea si detecta **inactividad** (umbral: 10 minutos).

Señales:
- `git log -1 --pretty=format:"%ct"` → timestamp del último commit
- `git status --porcelain` → archivos modificados sin commitear
- `stat` (compatible BSD/GNU) → fecha de última modificación de esos archivos

Exit codes: `0` = activo (no loggea nada), `1` = inactivo (loggea `[INACTIVITY]`)

---

### 2. CLI (`src/cli.ts`)

Entrypoint CLI que expone las operaciones del MCP server para uso desde shell scripts y hooks.

**Uso:**

```bash
node dist/cli.js timer start --description "PROJ-123-descripcion" [--project NAME] [--tags tag1,tag2]
node dist/cli.js timer stop
```

Reutiliza la misma config (`.env` + `mcp.config.json`) y el mismo `TogglTempoAdapter` que el MCP server. Zero duplicación de lógica.

---

### 3. Configuración de hooks (`.claude/settings.local.json`)

Los hooks están configurados con múltiples handlers por evento. Los handlers dentro del mismo evento corren **en paralelo e independientes** — si uno falla, el otro sigue.

Ver sección Quick Start para la configuración completa.

---

## Señales de actividad

Hay dos fuentes complementarias de actividad:

| Señal                    | Qué detecta                          | Componente               |
| ------------------------ | ------------------------------------ | ------------------------ |
| `[ACTIVITY]` (hook Stop) | Dev interactuando con Claude         | session-logger.sh        |
| Git (watchdog)           | Dev trabajando por fuera de Claude   | session-logger.sh check  |

Ambas son necesarias: el hook cubre la interacción con Claude, git cubre el desarrollo en editor sin Claude.

---

## Manejo de sesión abandonada

| Escenario                                           | Cobertura                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| Dev deja de trabajar pero Claude Code sigue abierto | ✅ Watchdog detecta inactividad (si alguien lo invoca)                  |
| Dev cierra Claude Code normalmente                  | ✅ Hook SessionEnd → loggea [STOP] + detiene timer en Toggl            |
| Crash / apagón / kill -9                            | ⚠️ SessionEnd no corre. Timer queda abierto en Toggl                   |
| Próxima sesión con timer abierto                    | ✅ Hook SessionStart → `smart_timer_control(start)` detiene el anterior e inicia uno nuevo |

---

## Pendientes

- [ ] **¿Quién invoca el watchdog?** — `/loop` de Claude solo cubre inactividad mientras Claude está abierto. Un cron del sistema (`crontab`/`launchd`) cubriría también dev sin Claude, pero es externo al proyecto. Decisión pendiente.
- [ ] **Wrapper para hooks** — El comando inline de SessionStart (git + node) es frágil. Un wrapper script daría cohesión al caso de uso y simplificaría la config. De momento funciona sin él.
- [ ] **Parseo de Jira ID** — Actualmente se usa la branch completa como description del timer. Pendiente decidir si parsear solo el Jira ID (`PROJ-123`) para mejor integración con Tempo sync.
- [ ] **Manejo de crash/kill -9** — El timer queda abierto en Toggl. Opciones: a) que el SessionStart cierre timers huérfanos, b) reconciliación en la siguiente sincronización con Tempo.
- [ ] **Probar en Linux (Ubuntu)** — El script usa `stat` con detección BSD/GNU, pero falta validar en entorno real.
- [ ] **Instrucciones en CLAUDE.md** — Definir instrucciones para que Claude maneje el timer durante la sesión (pause/resume en commit/push, cron watchdog si se elige `/loop`).

---

## Archivos del proyecto

| Archivo                                    | Propósito                                    |
| ------------------------------------------ | -------------------------------------------- |
| `session-logger/session-logger.sh`         | Logger + watchdog unificado                  |
| `session-logger/.session-logs/session.log` | Archivo de log (acumulativo, carpeta oculta) |
| `session-logger/spec.md`                   | Este documento                               |
| `src/cli.ts`                               | CLI para invocar timer desde hooks           |
| `.claude/settings.local.json`              | Configuración de hooks                       |

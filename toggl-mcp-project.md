# Proyecto: Toggl MCP server (MCP + Skill)

## Objetivo: Asiste al dev en la carga de horas permitiendo que cualquier asistente de IA (Cursor, Windsurf, Claude Desktop, etc.) interactúe con el ecosistema Toggl > Jira mediante lenguaje natural y reglas de contexto.

### 1. Requerimientos Funcionales (User Stories)
| ID | Requerimiento| Descripción|
|----|----|
| RF-01| Registro por Lenguaje Natural| El dev puede decir: "Cargame 3hs en el ticket de refactor de Auth" y la IA debe identificar el ticket y ejecutar el log.
| RF-02| Start/Stop timer | El agente de AI puede iniciar o detener un timer de Toggl asociado a una tarea específica.
| RF-03| Read tracking data | Si el dev pregunta "qué hice hoy", la IA consulta los registros en Toggl.
| RF-05| Validación de Carga| La Skill debe retornar una confirmación detallada (Ticket, Tiempo, Proyecto) para evitar errores de la IA.

### 2. Arquitectura Técnica
La solución se basa en el Model Context Protocol (MCP), que actúa como el "enchufe universal" entre los LLMs y herramientas locales.
Componentes del Ecosistema:
- AI Agent: (Cursor, ClaudeCode, OpenCode) El Agent de AI que consume la Skill y usa el MCP Server.
- MCP Server: Un servidor Node.js que expone las funciones de `toggl-tempo`.
- Core Logic (toggl-tempo): El paquete npm existente que maneja la lógica de negocio y APIs.
      │
      ▼
[ AI Assistant (Cursor/Claude) ] ── (Maneja el contexto y ejecuta las acciones)
      │
      ▼ [ MCP Protocol ]
[ Toggl MCP Server ] 
      │
      └─> [ Ejecución de Comandos (toggl-tempo) ]
              │
              ▼
      [ Toggl API / Jira API ]

### 3. Definición de Herramientas (Tool Specs)
Para que el agente sepa qué puede hacer, el MCP Server debe exponer las siguientes funciones (herramientas):
- A. `log_work_entry`: Carga horas específicamente.
Parámetros: Description (string), time range (date range), *project (string), *tags (string[]).
Uso: Cuando el dev pide cargar un set de horas a una tarea específica.
- B. `smart_timer_control`: Inicia o detiene un timer de Toggl asociado a una tarea específica.
Parámetros: Description (string), time (date), *project (string), *tags (string[]).
Uso: La IA usa el context_hint para buscar el ticket más probable y empezar el timer en Toggl.
- C. `read_tracking_data`: Lee los datos de tracking de Toggl.
Parámetros: time range (date range).
Uso: La IA puede consultar los datos de tracking de Toggl para analizar la actividad del día.

### 4. References
- [Toggl Track API v9](https://toggl.com/blog/toggl-track-api-v9/)
- [toggl-tempo npm package](https://www.npmjs.com/package/toggl-tempo?activeTab=readme)

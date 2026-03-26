# PRD: Tempo Push — Consolidacion de sesiones a Tempo

## Problema

Hoy el flujo Toggl → Tempo requiere que el dev use Toggl como timer. Queremos ofrecer una alternativa directa a Tempo sin depender de Toggl, usando los logs de sesion que ya se generan con los hooks de Claude Code.

Los edge cases de auto-push en SessionEnd (crash, idle, terminal cerrada) hacen inviable un push automatico. La consolidacion manual al final del dia es mas robusta y confiable.

## Solucion

Un comando CLI `tempo push` que:

1. Lee los logs de sesion del dia (o rango de fechas)
2. Agrupa entries por session_id y branch
3. Calcula tiempo REAL de trabajo usando ventanas de ACTIVITY (gaps > threshold = idle)
4. Muestra resumen al dev para validacion
5. Pushea a Tempo con confirmacion

## Flujo del dev

```
# Al final del dia
node dist/cli.js tempo push --date today

# Output:
# Sesiones de hoy (26-03-2026):
#   feat/auth    2h 35min  (3 sesiones)
#   fix/login    0h 45min  (1 sesion)
#   Total:       3h 20min
#
# ¿Pushear a Tempo? (y/n)
```

## Reglas de calculo

- Tiempo de trabajo = suma de ventanas entre START/ACTIVITY entries consecutivas
- Gap entre entries > THRESHOLD (default 10min) = idle, no cuenta
- Branch = agrupador natural, se mapea a issue key via descripcion o defaultIssueKey
- Si hay STOP sin ACTIVITY previo reciente, se usa la ultima ACTIVITY como fin real

## Requisitos

- [ ] Parsear logs de sesion por fecha (`session-YYYY-MM.log`)
- [ ] Agrupar por session_id, consolidar por branch
- [ ] Calcular duracion con threshold de inactividad configurable
- [ ] Comando CLI `tempo push` con flags `--date`, `--dry-run`
- [ ] Preview antes de pushear (nunca push silencioso)
- [ ] Tool MCP `push_sessions_to_tempo` para que Claude pueda hacerlo

## Configuracion

En `mcp.config.json`:
```json
{
  "mode": "toggl" | "tempo" | "both",
  "inactivityThresholdMinutes": 10
}
```

## Fuera de scope (por ahora)

- Auto-push en SessionEnd
- Deteccion de sesiones huerfanas
- UI/dashboard de sesiones

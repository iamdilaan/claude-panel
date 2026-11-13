# Formato de transcripts de Claude Code (observado)

Observado en noviembre de 2026 sobre sesiones reales y transcripts de subagentes. Versiones de Claude Code vistas: 2.1.160 → 2.1.322, con entrypoints
`cli` y `claude-desktop`. **No es un formato documentado**: cambia entre
versiones, así que el parser ignora todo lo que no conoce y nunca falla por un
campo ausente.

## Ubicación

```
~/.claude/projects/<cwd-de-lanzamiento con / → ->/
    <session-uuid>.jsonl          ← la sesión (lo único que indexamos)
    <session-uuid>/subagents/agent-<id>.jsonl   ← subagentes (ignorados)
    <session-uuid>/tool-results/…               ← salidas grandes (ignorados)
    memory/                                     ← memoria del proyecto (ignorado)
```

- El nombre de la carpeta es el **directorio desde el que se lanzó** `claude`, no
  el proyecto en el que se trabajó. Es habitual que muchas sesiones
  vivan en `-Users-<usuario>` porque se lanzan desde `~`.
- Hay carpetas de proyecto que solo tienen `memory/` y ningún transcript.
- Retención: Claude Code borra los transcripts antiguos (por defecto,
  `cleanupPeriodDays`). Por eso SQLite conserva los metadatos
  aunque el archivo desaparezca (`transcript_present = 0`).

## Estructura general

- Una línea = un objeto JSON con `type`. En la práctica no hay líneas inválidas,
  pero la última puede estar a medio escribir: el lector no la consume
  hasta que termina en `\n`.
- `sessionId` coincide siempre con el nombre del archivo.
- Hay archivos de hasta **107 MB**. La mayor parte del peso son
  `api-request-blob` y `tool_result`. Hay que leer en streaming y de forma
  incremental (guardamos el offset de bytes y el estado acumulado).
- **Los timestamps no están ordenados** en ninguna sesión: hay mensajes
  asíncronos y registros de cola. Por eso siempre se usan min/max, nunca
  «primero/último».

## Tipos de registro

| type | qué es | usamos |
|---|---|---|
| `user` | prompt humano, `tool_result`, comando local, aviso de agente… | sí |
| `assistant` | bloques `thinking` / `text` / `tool_use` | sí (solo `text` cuenta como respuesta) |
| `system` | `subtype`: `away_summary`, `compact_boundary`, `turn_duration`, `informational`, `local_command`, `stop_hook_summary`, `api_error`, `bridge_status` | `away_summary` |
| `ai-title` | `aiTitle`: título generado por Claude Code | sí |
| `custom-title` | `customTitle`: título puesto por la persona | sí |
| `last-prompt` | `lastPrompt`: **a veces falta el campo** | sí |
| `pr-link` | `prNumber`, `prUrl`, `prRepository` (se repite) | sí, deduplicado |
| `attachment`, `mode`, `permission-mode`, `atis-latch`, `bridge-session`, `session-owner`, `api-request*`, `file-history-*`, `queue-operation`, `frame-link`, `tools-used`, `cost-state`, `artifact-*` | estado interno | no |

Campos comunes en `user` / `assistant` / `system` / `attachment`: `uuid`,
`parentUuid`, `timestamp` (ISO UTC), `cwd`, `gitBranch`, `version`,
`entrypoint`, `isSidechain`, `userType`, `slug`. `user` además puede llevar
`isMeta`, `isCompactSummary`, `toolUseResult`, `promptSource`…

### Mensajes de usuario que *no* son prompts

`message.content` puede ser un string o un array de bloques (`text`,
`tool_result`, `image`). Contamos como prompt humano solo el texto que queda
tras limpiarlo:

- `isMeta: true` → fuera.
- `isSidechain: true` → fuera (son subagentes).
- `isCompactSummary: true` → resumen de compactación; se cuenta como
  `compactions`.
- Solo `tool_result` → fuera.
- Empieza por `<bash-stdout>`, `<bash-stderr>`, `<local-command-stdout>`,
  `<local-command-caveat>`, `<task-notification>` (avisos de agentes en
  segundo plano), `<command-message>` o `[Request interrupted…` → fuera.
- `<command-name>/x</command-name>…<command-args>a</command-args>` → `/x a`.
- `<bash-input>cmd</bash-input>` → `! cmd`.
- Los bloques `<system-reminder>…</system-reminder>` y las etiquetas
  `<pasted_content …>` se eliminan.

## Campos con trampa

- **`cwd` cambia dentro de una sesión** cada vez que el agente hace `cd`. Ha
  llegado a haber 21 cwd distintos en una sola sesión.
  - `launch_cwd` = primer `cwd` no sidechain. Es donde hay que ejecutar
    `claude --resume`, porque Claude Code busca la sesión en la carpeta de
    proyecto derivada del cwd.
  - `cwd` (directorio principal de trabajo) = el que tiene más registros, con
    estas reglas:
    - cada cwd se agrupa en su raíz git, si la tiene;
    - lo que hay bajo `node_modules` se agrupa en el directorio que lo contiene;
    - se ignoran `~/.claude/**` y `$HOME`, salvo que no haya otra cosa;
    - sin git no se agrupa en el padre: `sitios/proyecto-a` (492) gana a
      `sitios` (490).
  - `project_name` = basename de `cwd`, o `~`.
- **`gitBranch` no es fiable**: vale `"HEAD"` en el 100 % de los registros
  observados, porque las sesiones se lanzan fuera de un repo. **Nunca se lee
  del JSONL.** La rama y el estado se consultan en vivo con
  `git status --porcelain=v1 --branch` en `cwd` (con timeout).
- **Actividad**: después de que la sesión termina pueden llegar registros sueltos
  (`system/informational`, `queue-operation`), a veces días más tarde.
  `last_activity_at` = último `user`/`assistant` no sidechain. Cualquier otro
  timestamp solo se usa como respaldo.
- **`away_summary`**: Claude Code genera un resumen en español de «dónde lo
  dejamos» (hay 7 sesiones que lo tienen) y le añade el sufijo
  ` (disable recaps in /config)`, que quitamos. Lo damos por válido si
  `last_message_at <= away_summary_at`. Comparamos con el último mensaje
  real y no con el mtime, porque el mtime se mueve con registros de metadatos.
- `entrypoint: "claude-desktop"` marca las sesiones de la app de escritorio. En
  esas sesiones el panel solo ofrece «Continuar con resumen».

## Definiciones de columnas derivadas

- `message_count` = prompts humanos + respuestas de asistente con texto.
- `title` = `custom-title` > `ai-title` > primer prompt (80 caracteres).
- `started_at` = timestamp mínimo de cualquier registro.
- `project_name`: basename de la raíz git si la hay; si el
  directorio de trabajo es `~` sin repo, «Sin proyecto»; si no, `custom-title`
  > `ai-title` > basename del directorio con más trabajo. Se recalcula en cada
  scan desde el estado guardado (por si se hace `git init`). Encima se aplican
  los alias de `project_alias` (por ruta > por nombre) en la vista `sessions_v`.
  El scanner nunca escribe en `project_alias`.
- `status` lo calcula `refreshStatuses` (en cada scan y cada 30 s en el daemon):
  1. un `SessionEnd` posterior a la última actividad → `closed`;
  2. un proceso vivo con ese `sessionId` → `active` (busy) / `paused` (idle);
  3. un proceso `claude` sin registro → la sesión más reciente lanzada en su cwd;
  4. actividad hace menos de 15 min → `active` (heurística); si no → `closed`.
  El scanner nunca pisa `user_note`, `pinned`, `archived` ni `summary_*`.

## Registro de procesos vivos: `~/.claude/sessions/`

Claude Code mantiene un `<pid>.json` por cada proceso interactivo vivo:

```json
{"pid": 69504, "sessionId": "<uuid>", "cwd": "<cwd de lanzamiento>",
 "procStart": "Wed Nov 11 14:36:49 2026", "status": "busy", "kind": "interactive",
 "entrypoint": "cli", "version": "2.1.322", "updatedAt": 1794410242924, …}
```

- `procStart` está en UTC y en formato C; coincide con
  `TZ=UTC LC_ALL=C ps -o lstart=`. Lo usamos para descartar PIDs reutilizados.
- Junto a cada `.json` hay un `<pid>.<hash>.key` con un token de comunicación
  entre procesos. **ClaudePanel nunca lee los `.key`.**
- Si un proceso `claude` no tiene entrada en el registro (versiones antiguas),
  recurrimos a `ps` + `lsof -d cwd`.

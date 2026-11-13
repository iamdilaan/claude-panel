# ClaudePanel

Un panel en la barra de menú de macOS para volver a tus sesiones de Claude Code.

Si trabajas con Claude Code en varios proyectos a la vez, acabas con decenas de
sesiones repartidas por terminales que ya cerraste. ClaudePanel las indexa todas
(también las cerradas), guarda un resumen breve de dónde se quedó cada una y te
devuelve a ella con un clic: abre Terminal en el directorio correcto y retoma la
sesión, o empieza una nueva que ya sabe en qué estabas.

- **Local**: sin servicios externos, sin cuentas, sin telemetría.
- **Solo lectura** sobre `~/.claude`: nunca modifica tus transcripts.
- **Interfaz en español.** macOS 13+.

## Cómo funciona

```
┌──────────────┐  hooks Stop/SessionEnd   ┌────────────────────────────┐
│ Claude Code  │ ───────────────────────▶ │ daemon (127.0.0.1:7437)    │
│ ~/.claude/   │ ◀── lee (nunca escribe)  │ scanner · SQLite · Haiku   │
│   projects   │                          │ copia local · lanzador     │
└──────────────┘                          └──────┬───────────┬─────────┘
                                                 │           │ osascript
                           UI React (navegador o │           ▼
                           popover de la app) ◀──┘      Terminal.app
```

1. **Scanner.** Lee de forma incremental los transcripts JSONL de
   `~/.claude/projects` y guarda en SQLite lo esencial de cada sesión: proyecto,
   título, primer y último prompt, fechas, PR enlazado. Nunca copia el transcript
   entero al índice.
2. **Hooks.** Claude Code avisa al daemon al terminar cada respuesta (`Stop`) y al
   cerrar la sesión (`SessionEnd`), así el panel se actualiza al momento. Si el
   daemon está apagado, los avisos esperan en una cola.
3. **Resumen.** Cuando una sesión cambia, el daemon prepara un extracto (con las
   claves y contraseñas ya tapadas) y se lo pasa a `claude -p --model haiku`, sin
   herramientas, para obtener tres líneas: qué se hacía, dónde se quedó y qué
   seguía. Es lo único que sale de tu máquina, y usa tu propia cuenta de Claude
   Code. Sin `claude` disponible, hay un resumen heurístico local.
4. **Copia local.** Claude Code borra los transcripts antiguos; ClaudePanel guarda
   una copia filtrada y comprimida (solo texto de prompts y respuestas) para poder
   seguir resumiendo la sesión después.
5. **Lanzador.** «Reanudar» abre Terminal con `claude --resume <id>`;
   «Continuar con resumen» abre una sesión nueva cuyo primer mensaje es el resumen.
6. **UI.** La misma interfaz React se ve en el popover de la app (Tauri) o en el
   navegador.

El código está en `packages/`: `core` (scanner, índice, lanzador, redacción),
`summarizer`, `daemon` (API HTTP), `cli` (`cpanel`), `ui` y `app` (Tauri 2, Rust).

## Requisitos

- macOS 13 o posterior
- Node 26 (`.nvmrc`). better-sqlite3 trae binario precompilado; no compila nada.
- Claude Code (`claude`) en el PATH. Lo usa el resumidor y es lo que se abre en Terminal.
- Para compilar la app de la barra de menú: Rust estable (rustup) y las Command Line
  Tools de Xcode. No hacen falta en tiempo de ejecución.

## Instalación

```sh
git clone https://github.com/iamdilaan/claude-panel.git
cd claude-panel
npm install

# 1. Hooks de Claude Code: enseña el diff de ~/.claude/settings.json y hace backup
node packages/cli/src/cpanel.ts install-hooks

# 2. App de barra de menú (compila la UI y el bundle; copia a ~/Applications)
PATH="$HOME/.cargo/bin:$PATH" npm run app:build
npm run app:install

# 3. Daemon y app al iniciar sesión (enseña los plists antes de escribirlos)
node packages/cli/src/cpanel.ts launchd install

# 4. Comprobar
node packages/cli/src/cpanel.ts doctor
```

Todos los pasos se pueden repetir sin efectos: si no hay nada que cambiar, lo dicen y
no tocan nada. Sin terminal interactiva, añade `--yes` después de revisar `--dry-run`.

Opcional: `npm link -w @cpanel/cli` deja `cpanel` en el PATH. En lo que sigue,
`cpanel` equivale a `node packages/cli/src/cpanel.ts`.

### Permisos de macOS

La primera vez que el daemon haga algo nuevo, macOS puede preguntar:

- **Automatización › node › Terminal**: necesario para abrir sesiones. Si lo
  deniegas, `cpanel doctor` lo detecta y te dice dónde reactivarlo.
- **Acceso a la carpeta Escritorio o Documentos**: solo si tienes proyectos ahí.
  El daemon consulta `git status` en el directorio de cada proyecto (salvo en
  repos cuya config define programas; ver «Seguridad»).

## Uso

- **⌥⌘P** abre o cierra el panel (o clic en el icono). Se cierra al perder el foco.
  El icono lleva un punto cuando hay alguna sesión activa.
- **Clic derecho** en el icono: «Abrir en el navegador» y «Salir».
- **Navegador**: `cpanel open` (o «Abrir en el navegador») abre la misma UI, a lo
  ancho. Abrir http://127.0.0.1:7437 a mano no basta: la página no trae el token.

En cada tarjeta:

| Acción | Qué hace |
|---|---|
| Continuar con resumen | Abre Terminal en el directorio del proyecto con `claude "<resumen>"`: una sesión nueva que empieza sabiendo dónde lo dejaste. Funciona aunque la sesión original sea de Claude Desktop o ya no exista. |
| Reanudar | `claude --resume <id>` en el directorio donde se lanzó. No está disponible en sesiones de Desktop ni si Claude Code borró el transcript. Si la sesión sigue abierta en otra Terminal, avisa antes. |
| Copiar resumen | El mismo texto de «Continuar», al portapapeles |
| Fijar / Archivar | Arriba del todo, o fuera de la lista (casilla «Archivadas» para verlas) |
| Finder | Abre el directorio del proyecto |
| Nombre del proyecto | Clic para renombrarlo (alias). Vacío = nombre original |
| Nota | Clic para escribir lo que no quieres olvidar; tiene prioridad sobre el resumen |

Chips: rama en vivo con cambios sin commit (●), commits sin subir (↑) y sin traer (↓),
el PR de la sesión, «Desktop», «resumen antiguo» (hubo actividad después del último
resumen; se regenera solo) y «solo copia» (Claude Code borró el transcript).

`/` enfoca el buscador; Enter en una tarjeta = «Continuar con resumen».

### CLI

| Comando | |
|---|---|
| `cpanel scan [--full] [--json] [--all]` | indexa y lista |
| `cpanel summarize [id…] [--recent N] [--force]` | resume con Haiku |
| `cpanel alias ls \| set <clave> <alias> \| rm <clave>` | renombra o fusiona proyectos |
| `cpanel archive` | crea o actualiza las copias locales |
| `cpanel archive --prune --older-than 90d [--dry-run]` | borra copias sin actividad en N días |
| `cpanel delete <id>` | quita una sesión del panel (no toca el transcript; no se reindexa) |
| `cpanel install-hooks` / `uninstall-hooks` | hooks de Claude Code |
| `cpanel launchd install` / `uninstall` | arranque al iniciar sesión |
| `cpanel doctor` | diagnóstico completo |
| `cpanel uninstall [--purge]` | desinstalación (ver abajo) |
| `cpanel open` | abre el panel en el navegador |
| `cpanel daemon` | daemon en primer plano (desarrollo) |

### Configuración

`~/.claude-panel/config.json` (opcional; todo tiene valor por defecto):

```json
{
  "shortcut": "Alt+Super+P",
  "archive_enabled": true,
  "archive_retention_days": null
}
```

- `shortcut`: sintaxis de Tauri (`Alt`, `Super`/`Cmd`, `Shift`, `Ctrl` + tecla). Se
  lee al arrancar la app: `launchctl kickstart -k gui/$(id -u)/com.claudepanel.app`.
- `archive_retention_days`: si lo pones, el daemon borra cada día las copias locales
  de sesiones sin actividad en ese número de días. Por defecto no borra nada.

Para que no se vean los argumentos de `claude` en el título de la ventana de
Terminal: Ajustes de Terminal › Perfiles › Ventana › desmarca «Argumentos del proceso
activo». El panel ya fija el título a «ClaudePanel: <proyecto>».

## Qué guarda y dónde

| Ruta | Contenido |
|---|---|
| `~/.claude/projects` | Fuente de verdad. **Solo lectura**: ClaudePanel nunca la modifica. |
| `~/.claude-panel/sessions.db` | Índice SQLite: metadatos, resúmenes, notas, alias. Nunca el transcript. |
| `~/.claude-panel/archive/<id>.txt.gz` | Copia local filtrada y redactada de cada sesión (texto de prompts y respuestas, una línea por herramienta y solo los errores). Sirve para regenerar resúmenes cuando Claude Code borra el original. No es reanudable. |
| `~/.claude-panel/launch/<id>.md` | Prompt de «Continuar con resumen» |
| `~/.claude-panel/token` | Token local (0600) |
| `~/.claude-panel/logs/` | Logs con rotación (5 MB × 3) |
| `~/.claude-panel/backups/` | Copias de `settings.json` antes de cada cambio |
| `~/Library/LaunchAgents/com.claudepanel.{daemon,app}.plist` | Arranque al iniciar sesión |
| `~/Applications/ClaudePanel.app` | App de barra de menú |

`~/.claude-panel` es 0700; los archivos con contenido, 0600.

## Seguridad y privacidad

- **El daemon escucha solo en 127.0.0.1.** Rechaza cualquier Host que no sea
  `127.0.0.1:7437` o `localhost:7437` (protección contra DNS rebinding).
- **Toda la API exige el token local** (`x-cpanel-token`), también las lecturas;
  solo `/api/health` está abierta. Si el navegador manda Origin, tiene que ser el
  propio. Una web externa no puede leer nada (no hay CORS) ni enmarcar la página
  (`frame-ancestors 'none'`). Todas las respuestas llevan CSP y cabeceras de seguridad.
- **El daemon nunca entrega el token**: ni la página ni ninguna respuesta sin
  autenticar lo contienen, así que otro usuario del Mac o un proceso que llegue al
  puerto pero no pueda leer `~/.claude-panel/token` (0600) no lo obtiene.
- **La app de barra de menú** lee el token en Rust y lo inyecta en la página del
  daemon. La página del daemon no tiene acceso a las funciones de la app; solo la
  página local de «daemon apagado» puede pedir que se arranque.
- **En el navegador**, `cpanel open` abre `http://127.0.0.1:7437/#t=<token>`. El
  fragmento (`#…`) no viaja al servidor; la UI lo guarda en `sessionStorage` (solo
  esa pestaña) y lo borra de la URL al cargar. La URL se pasa a `osascript` por
  stdin, no como argumento, para que no aparezca en `ps`.
- **git sin ejecutar nada del repo**: la config de un repo (`.git/config`) puede
  hacer que `git status` ejecute programas. Antes de mirar el estado se lee esa
  config (`git config --list`, que no ejecuta nada) y solo se sigue si todas sus
  claves están en una lista cerrada de claves inocuas (formato, remotos, ramas,
  usuario, husky, git-lfs estándar…). Con cualquier otra, la tarjeta muestra
  «git omitido» y la clave que lo ha provocado. Además git corre siempre sin
  descargas perezosas (`GIT_NO_LAZY_FETCH`), sin protocolos de red, con
  `core.fsmonitor=false`, sin config del sistema, sin prompts, sin locks opcionales
  y sin entrar en submódulos. Tu config global (`~/.gitconfig`) se respeta.
- **Lanzador**: el AppleScript es fijo y el comando le llega como argumento. Al
  comando solo van rutas entre comillas simples POSIX y un session_id validado como
  UUID. El texto del transcript nunca entra en él: va a un archivo 0600 que el shell
  lee con `$(cat …)`. Hay tests que ejecutan los comandos en zsh y bash con rutas,
  títulos y prompts hostiles.
- **Redacción**: antes de enviar nada a `claude -p` y antes de archivar se tapan
  claves de API (Anthropic, OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Google…),
  JWT, tokens Bearer, credenciales en URLs, `KEY=valor` de `.env` y claves privadas.
  Las salidas de herramientas no se envían ni se archivan. Es una red de seguridad,
  no una garantía.
- **«Continuar con resumen»**: todo el texto que viene del transcript va en un
  bloque marcado como datos de la sesión anterior, no como instrucciones, y el
  contenido no puede cerrar ese bloque.
- **Sin recursión**: el resumidor corre con `CLAUDE_PANEL_SUMMARIZING=1` (los hooks
  salen al verla), `--no-session-persistence`, sin herramientas ni hooks, y el
  scanner ignora cualquier sesión que empiece con su marca.
- No se leen nunca los archivos `~/.claude/sessions/*.key`.

## Problemas frecuentes

Empieza siempre por `cpanel doctor`.

- **El panel dice «daemon apagado»**: pulsa «Iniciar daemon». Si no arranca, mira
  `~/.claude-panel/logs/daemon.err.log` y `launchctl print gui/$(id -u)/com.claudepanel.daemon`.
- **Puerto ocupado**: otro `cpanel daemon` lanzado a mano. Páralo; launchd reintenta
  cada 10 s.
- **El navegador dice «token ausente o inválido»**: abre el panel con `cpanel open`
  (el token se guarda por pestaña; una pestaña nueva con la URL a pelo no lo tiene).
- **Tras actualizar el código**: `launchctl kickstart -k gui/$(id -u)/com.claudepanel.daemon`
  (y `npm run app:build && npm run app:install` si cambió la app o la UI).
- **Una sesión no aparece**: `cpanel scan`. Los eventos de hook que llegaron con el
  daemon apagado esperan en `~/.claude-panel/queue/` y se procesan al arrancar.

## Desinstalación

```sh
cpanel uninstall --dry-run      # enseña exactamente qué va a quitar
cpanel uninstall                # agentes de launchd, hooks (con backup) y la app
cpanel uninstall --purge        # además ~/.claude-panel: índice, notas, copias locales y logs
```

Nunca toca `~/.claude/projects` ni nada de Claude Code salvo sus propios hooks en
`settings.json`. Con `--purge`, el backup de `settings.json` se guarda junto a él (en
`~/.claude/`), porque `~/.claude-panel/backups` también se borra. Después solo queda
el código: borra la carpeta del repo si ya no la quieres.

## Desarrollo

```sh
npm test                 # vitest: core, resumidor, daemon, CLI (incluye e2e de instalación en un HOME aislado)
npm run typecheck
PATH="$HOME/.cargo/bin:$PATH" npm run lint:app   # clippy sobre la app (rustup component add clippy)
npm run dev:ui           # Vite en :5174 con proxy al daemon
```

Con `dev:ui`, abre `http://127.0.0.1:5174/#t=$(cat ~/.claude-panel/token)`: la UI
solo toma el token del fragmento de la URL (o del que inyecta la app).

Node 26 ejecuta los `.ts` directamente (type stripping): no hay paso de build salvo
la UI y la app. El formato de los JSONL de Claude Code está documentado en
`docs/jsonl-format.md`.

## Auditoría de seguridad

Antes de publicarlo, ClaudePanel pasó varias rondas de ataque y corrección: qué se
probó, qué se encontró y cómo se arregló está en [SECURITY.md](SECURITY.md), junto
con cómo informar de una vulnerabilidad.

## Licencia

[MIT](LICENSE)

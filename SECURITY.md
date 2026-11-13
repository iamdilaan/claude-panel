# Seguridad

## Informar de una vulnerabilidad

Abre un [aviso de seguridad privado](https://github.com/iamdilaan/claude-panel/security/advisories/new)
en GitHub en vez de un issue público. Incluye los pasos para reproducirlo y la
versión (commit) afectada.

## Modelo de amenazas

ClaudePanel corre en tu Mac con tus permisos, así que lo que importa es qué puede
conseguir alguien que **no** es tú:

- **Una web abierta en tu navegador**, que puede hacer peticiones a `127.0.0.1`.
- **Otro usuario u otro proceso del mismo Mac** que llega al puerto del daemon pero
  no puede leer tus archivos.
- **El contenido de los transcripts**: texto de webs, salidas de herramientas,
  archivos de repos clonados y respuestas del modelo. Se trata siempre como no fiable.
- **La carpeta de cada proyecto**, que puede ser un repo de terceros con una config
  de git manipulada.

Queda fuera: alguien que ya ejecuta código como tu usuario (puede leer
`~/.claude` directamente) y la seguridad del propio Claude Code.

## Auditoría previa a la publicación

Antes de publicar el código se siguió este protocolo: agentes atacantes intentan
romperlo en una copia aislada; si lo consiguen, se audita cómo y por qué; otro
grupo de agentes lo reconstruye con tests que reproducen cada ataque; y se vuelve
a atacar, hasta que una ronda no consigue nada nuevo.

### Ronda 1

| Hallazgo | Gravedad | Arreglo |
|---|---|---|
| `git status` en la carpeta de un proyecto ejecutaba programas definidos en su `.git/config` (`core.fsmonitor`, filtros `clean`), con solo mostrar la tarjeta | media-alta | Lectura previa de la config y entorno de git endurecido (ver ronda 2) |
| El token del daemon iba incrustado en la página servida sin autenticar: otro usuario del Mac podía leerlo | media | El daemon nunca entrega el token. La app lo inyecta desde Rust; en el navegador llega en el fragmento `#t=` de la URL |
| La redacción dejaba pasar 15 de 34 formatos de secreto (contraseñas en URLs, PGP, `whsec_`, `SG.`, `curl -u`, `mysql -p`…) y recortaba antes de redactar | media | Más reglas, redacción antes de recortar y una batería permanente de secretos y de falsos positivos |
| `/api/git` y `/api/sessions` no pedían token | baja | Toda la API exige token, salvo `/api/health` |
| `install-hooks` escribía con nombres predecibles y seguía enlaces simbólicos | baja | Temporales y backups con nombre único (`O_EXCL`), carpeta de backups 0700, `settings.json` enlazado se respeta |
| Enlaces «PR #N» hacia cualquier web | baja | Solo `https://github.com/…/pull/N` y `https://gitlab.com/…/-/merge_requests/N` |
| El texto del transcript podía colarse como instrucción en «Continuar con resumen» | baja | Va en un bloque marcado como datos que el contenido no puede cerrar |

Lo que resistió: CSRF desde webs, DNS rebinding, recorrido de rutas en los
estáticos, inyección de comandos en el lanzador de Terminal, la IPC de la app
Tauri, XSS en la UI, inyección SQL y la cola de hooks.

### Ronda 2

| Hallazgo | Gravedad | Arreglo |
|---|---|---|
| La lista de claves de git **prohibidas** se podía saltar con un clon parcial: `git status` descargaba un objeto ausente por un transporte `ext::` y ejecutaba un comando | media-alta | Lista cerrada de claves **permitidas**; git corre siempre con `GIT_NO_LAZY_FETCH=1`, `protocol.allow=never`, `core.fsmonitor=false` y `--no-optional-locks` |
| Redactar antes de recortar hacía que dos expresiones regulares tardaran 11 s con un texto de 120 KB | baja | Todas las reglas con longitud acotada; solo se redacta el tramo que se va a usar |
| 19 formatos de secreto más (`.netrc`, `.pgpass`, Docker `auth`, cookies, `pypi-`, `ya29.`…) | baja | Añadidos a la batería permanente |
| La app no recuperaba el token si al arrancar aún no existía | regresión | La app relee el token si falta o si recibe un 401 |

### Ronda 3

Centrada en lo que cambió en la ronda 2. No encontró nada de gravedad media o
superior, así que el protocolo se dio por cerrado aquí.

| Hallazgo | Gravedad | Arreglo |
|---|---|---|
| Al acotar las expresiones regulares, un JWT con payload de más de ~8 KB dejaba de redactarse | baja | Sin tope de longitud (el inicio anclado mantiene el coste lineal) |
| `PASSWORD=$…` dejaba de redactarse al excluir las variables de shell | baja | Solo se excluye una referencia completa (`$VAR`, `${VAR}`) |
| Etiquetas PEM largas y claves SendGrid con segmentos largos | informativa | Límites ampliados |

Se comprobó además: ~1.200 entradas aleatorias de 200 KB a 1 MB sin pasar de
200 ms (crecimiento lineal); los ataques de git de las rondas 1 y 2 sin ejecutar
nada; repos normales (husky, git-lfs, remotos de `gh`, claves de VS Code) con su
rama visible; y la inyección del token restringida al origen del daemon.

## Límites conocidos

- La redacción es una red de seguridad, no una garantía: un formato de secreto que
  no conozca llegará al resumidor.
- Los repos cuya config tiene claves fuera de la lista permitida no muestran estado
  de git, aunque sean inofensivos.
- En el navegador, la URL con `#t=` puede quedar en el historial (que solo tú puedes
  leer). Cada pestaña nueva necesita `cpanel open`.

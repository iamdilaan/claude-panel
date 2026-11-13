/**
 * Redacción de secretos evidentes antes de enviar texto fuera del proceso
 * (a `claude -p`) o de archivarlo. Es una red de seguridad, no una garantía:
 * prioriza no dejar pasar patrones conocidos aunque a veces tape algo inocuo.
 * Es idempotente: lo ya tapado (`[REDACTED…]`) no se vuelve a tapar ni a contar.
 *
 * Coste lineal: el texto puede venir de una salida de herramienta enorme y
 * `redact()` corre síncrono en el daemon. Por eso ninguna regla tiene un
 * cuantificador sin tope que pueda reintentarse en cada posición: los nombres
 * de clave están acotados ({0,64}) y anclados al principio de su «palabra»
 * (`(?<![…])`), de modo que una racha larga de `a.a.a.…` solo se recorre una vez.
 */

/** Caracteres que forman un nombre de clave (`DB_PASS`, `aws.secret-key`). */
const NC = 'A-Za-z0-9_.-';
/** Inicio de un nombre: no puede ir pegado a otro carácter de nombre. */
const NAME_START = `(?<![${NC}])`;

/** Nombres de clave que delatan una contraseña: aceptan valores cortos. `PWD` a secas es el directorio. */
const PASS_NAME = String.raw`passw(?:or)?d|(?<=[_.-])pwd|(?<![a-z])pass(?:phrase|code)?(?![a-z])`;

const KEYWORDS = String.raw`api[_-]?key|apikey|secret|token|${PASS_NAME}|private[_-]?key|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|credentials?|auth[_-]?key|client[_-]?secret|session[_-]?key|conn(?:ection)?[_-]?str(?:ing)?|dsn`;

/** Nombre de clave con una palabra delatora. Acotado: sin backtracking cuadrático. */
const SECRET_NAME = `[${NC}]{0,64}?(?:${KEYWORDS})[${NC}]{0,64}`;
const PASS_ONLY_NAME = `[${NC}]{0,64}?(?:${PASS_NAME})[${NC}]{0,64}`;

/** Nombre de variable de entorno en mayúsculas (`MYSQL_PWD`), para las reglas sin `=`. */
const ENV_NAME = `[A-Z0-9_]{0,64}?(?:${KEYWORDS.toUpperCase()})[A-Z0-9_]{0,64}`;

/**
 * Valores que no son secretos: tipos o literales de código (`password: string`),
 * referencias completas a variables de shell (`$PASS`, `${TOKEN}`; no `$Zq8v…!x`) y expresiones (`getToken()`,
 * `form.password.value;`, `await …`).
 */
const NOT_A_VALUE = String.raw`(?!\[REDACTED)(?!\$\{?[A-Za-z_]\w{0,64}\}?(?=$|[\s"'\x60;,)&|]))(?!(?:string|number|boolean|null|undefined|true|false|any|unknown|none|nil|await|new|this)\b)(?![A-Za-z_][\w$]{0,64}(?:\.[A-Za-z_][\w$]{0,64}){0,8}\()(?![A-Za-z_][\w$]{0,64}(?:\.[A-Za-z_][\w$]{0,64}){1,8}[;,)])`;

/** Separador clave/valor: `=`, `:`, con espacios (y en YAML, salto de línea) alrededor. */
const SEP = String.raw`(\s{0,16}[:=]\s{0,16})`;

type Rule = [RegExp, string | ((m: string, ...g: string[]) => string)];

/** Atributos de Set-Cookie que no son valores secretos. */
const COOKIE_ATTR = /^(?:path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned|version|comment)$/i;

const RULES: Rule[] = [
  [/-----BEGIN [A-Z0-9 ]{0,200}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,200}PRIVATE KEY(?: BLOCK)?-----|$)/g, '[REDACTED:private-key]'],
  // clave PuTTY (.ppk): las líneas base64 que siguen a Private-Lines
  [/(Private-Lines:[ \t]{0,8}\d{1,5}[ \t]{0,8}\r?\n)(?!\[REDACTED)[A-Za-z0-9+/=]+(?:\r?\n(?!Private-)[A-Za-z0-9+/=]+)*/g, '$1[REDACTED:private-key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[REDACTED:anthropic-key]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED:stripe-key]'],
  [/\bwhsec_[A-Za-z0-9+/=]{20,}/g, '[REDACTED:stripe-key]'],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, '[REDACTED:github-token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED:gitlab-token]'],
  [/\bx(?:ox[abposrec]|app)-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, '[REDACTED:slack-webhook]'],
  [/(?<![\w.-])SG\.[\w-]{16,}\.[\w-]{16,}/g, '[REDACTED:sendgrid-key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  // Google: token de acceso OAuth y secreto de cliente
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[REDACTED:google-token]'],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, '[REDACTED:google-secret]'],
  [/\b(?:sbp|npm|hf|pypi|shpat|shpss|dop_v1)_[A-Za-z0-9_-]{20,}/g, '[REDACTED:token]'],
  // PyPI usa guion (pypi-AgEI…), no guion bajo
  [/\bpypi-[A-Za-z0-9_-]{50,}/g, '[REDACTED:pypi-token]'],
  // Twilio API key secret (SK + 32 hex)
  [/\bSK[0-9a-f]{32}\b/g, '[REDACTED:twilio-key]'],
  // token de bot de Discord: id en base64 . marca de tiempo . HMAC
  [/(?<![\w-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}(?![\w-])/g, '[REDACTED:discord-token]'],
  // sin tope de longitud: el lookbehind ancla el inicio, así que sigue siendo lineal
  [/(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  // firma de URLs prefirmadas: Azure SAS (sig=), S3 (X-Amz-Signature), GCS
  [/([?&](?:sig|signature|X-Amz-Signature|X-Goog-Signature)=)(?!\[REDACTED)[^&\s"'#<>]{8,2048}/gi, '$1[REDACTED]'],
  // cabecera Authorization: cualquier longitud
  [/\b(Authorization\s{0,8}:\s{0,8}(?:Bearer|Basic|Token)\s{1,8})(?!\[REDACTED)[^\s"'\\]+/gi, '$1[REDACTED]'],
  // Bearer suelto: largo, o corto si mezcla letras y dígitos («Bearer authentication» y «Bearer token1234» son prosa)
  [/\b(Bearer|Basic|Token)\s{1,8}(?:[A-Za-z0-9._~+/=-]{16,}|(?=[A-Za-z._~+/=-]{0,15}\d)(?![A-Za-z]{1,15}\d{1,15}(?![A-Za-z0-9._~+/=-]))[A-Za-z0-9._~+/=-]{8,})/gi, '$1 [REDACTED]'],
  // cabeceras Cookie / Set-Cookie: se tapa el valor de cada par nombre=valor
  [
    /(\b(?:Set-Cookie|Cookie)\s{0,8}:[ \t]{0,8})([^\n"']{1,4096})/gi,
    (_m, head: string, rest: string) =>
      head +
      rest.replace(/(^|;\s{0,8})([^=;\s]{1,256})=([^;]{1,4096})/g, (pair, sep: string, name: string, val: string) =>
        COOKIE_ATTR.test(name) || val.startsWith('[REDACTED') ? pair : `${sep}${name}=[REDACTED]`,
      ),
  ],
  // credenciales en URLs: scheme://user:pass@host (usuario vacío y `/` en la contraseña;
  // `host:3000/@vite` y `host:8080?next=@x` no son contraseñas: tras `:` no puede ir un puerto)
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@'"]{0,128}:)(?!\[REDACTED)(?!\d{1,5}(?:[/?#]|$))[^\s@'"]{1,256}@/gim, '$1[REDACTED]@'],
  // token como usuario de la URL: https://<token>@host
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)(?!\[REDACTED)(?=[A-Za-z_-]{0,255}\d)[A-Za-z0-9_-]{16,256}@/gi, '$1[REDACTED]@'],
  // curl -u usuario:contraseña · sshpass -p contraseña · mysql -pcontraseña
  [/(\bcurl\b[^\n]{0,200}?\s(?:-u|--user)\s{0,8})(["']?)([^\s:"']{0,128}:)(?!\[REDACTED)(?!\$)[^\s"']{1,256}\2/g, '$1$2$3[REDACTED]$2'],
  [/(\bsshpass\b(?:\s{1,8}-[a-oq-zA-Z]\S{0,64}){0,8}\s{1,8}-p\s{0,8})(["']?)(?!\[REDACTED)(?!\$)[^\s"']{1,256}\2/g, '$1$2[REDACTED]$2'],
  // mysql -p…: sin cruzar a otro comando (`npm i mysql && npm run build -prod`)
  [/(\bmysql(?:dump|admin|sh)?\b[^\n;&|]{0,200}?\s-p)(?!\[REDACTED)(?!\$)([^\s-]\S{0,255})/g, '$1[REDACTED]'],
  // .netrc: machine host login usuario password valor (en una línea o en varias)
  [/(\b(?:machine[ \t]{1,8}\S{1,253}(?:[ \t]{1,8}login[ \t]{1,8}\S{1,256})?|default[ \t]{1,8}login[ \t]{1,8}\S{1,256})\s{1,16}password[ \t]{1,8})(?!\[REDACTED)\S{1,256}/g, '$1[REDACTED]'],
  // …y la línea `password valor` suelta del formato multilínea, si el valor no es una palabra corriente
  [/(^[ \t]{0,16}password[ \t]{1,8})(?!\[REDACTED)(?=[A-Za-z]{0,255}[^\sA-Za-z])\S{4,256}(?=[ \t]{0,16}$)/gm, '$1[REDACTED]'],
  // .pgpass: host:puerto:base:usuario:contraseña
  [/(^[^\s:#]{1,253}:(?:\d{1,5}|\*):[^\s:]{1,128}:[^\s:]{1,128}:)(?!\[REDACTED)\S{1,256}$/gm, '$1[REDACTED]'],
  // Docker config.json: "auth": "base64(usuario:contraseña)"
  [/(["']auth["']\s{0,16}:\s{0,16})["'](?!\[REDACTED)[A-Za-z0-9+/=]{8,4096}["']/gi, '$1"[REDACTED]"'],
  // "apiKey": "valor" (JSON / objetos)
  [new RegExp(String.raw`(["'](?:${SECRET_NAME})["']\s{0,16}:\s{0,16})["'](?!\[REDACTED)[^"'\n]{6,1024}["']`, 'gi'), '$1"[REDACTED]"'],
  // valor entre comillas con espacios: PASSWORD="correct horse battery" · --password="a b"
  [
    new RegExp(String.raw`${NAME_START}(${SECRET_NAME})${SEP}(["'])${NOT_A_VALUE}(?=[^"'\n]{0,200}\s)[^"'\n]{4,200}\3`, 'gi'),
    '$1$2$3[REDACTED]$3',
  ],
  // contraseñas cortas: PASSWORD=abc12 · DB_PASS: x9y8
  [new RegExp(String.raw`${NAME_START}(${PASS_ONLY_NAME})${SEP}(["']?)${NOT_A_VALUE}[^\s"'\n]{4,1024}\3`, 'gi'), '$1$2$3[REDACTED]$3'],
  // API_KEY=valor · token: valor (.env, shell, YAML, cadenas de conexión con `;`)
  [new RegExp(String.raw`${NAME_START}(${SECRET_NAME})${SEP}(["']?)${NOT_A_VALUE}[^\s"'\n]{6,1024}\3`, 'gi'), '$1$2$3[REDACTED]$3'],
  // --password valor · --api-key valor (solo como opción: «fix token parsing» es prosa)
  [new RegExp(String.raw`(\s--?(?:${SECRET_NAME}))(\s{1,8})(["']?)${NOT_A_VALUE}(?!-)[^\s"'\n]{6,1024}\3`, 'gi'), '$1$2$3[REDACTED]$3'],
  // export/setenv/ENV NOMBRE valor (sin `=`: csh, Dockerfile antiguo)
  [new RegExp(String.raw`(\b(?:export|setenv|ENV)[ \t]{1,8}(?:${ENV_NAME})[ \t]{1,8})(["']?)${NOT_A_VALUE}(?![-=])[^\s"'\n]{4,1024}\2`, 'g'), '$1$2[REDACTED]$2'],
  // frase semilla BIP39 (12–24 palabras) tras «seed phrase», «mnemonic»…
  [/(\b(?:mnemonic|(?:seed|recovery|secret)[ _-]?(?:phrase|words))\s{0,8}[:=]?\s{0,8})(["']?)[a-z]{3,8}(?:[ \t]{1,4}[a-z]{3,8}){11,23}\2/gi, '$1$2[REDACTED]$2'],
  // clave secreta de AWS suelta (40 caracteres base64, mayúsculas y minúsculas) cerca de aws/secret/key.
  // Un SHA de git es hex de un solo caso: no entra. La palabra clave se busca hacia atrás (lookbehind)
  // solo desde candidatos de 40 caracteres: buscarla hacia delante desde cada «key» sería cuadrático.
  [
    /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=]))(?<=(?:aws|AWS|[Ss]ecret|SECRET|[Kk]ey|KEY)[^\n]{0,30})(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[0-9/+])[A-Za-z0-9/+]{40}/g,
    '[REDACTED:aws-secret]',
  ],
  // …o más lejos (hasta 300 caracteres, cruzando líneas) de una mención a AWS o de un AKIA ya tapado,
  // si además lleva `/` o `+`, como casi todas las claves secretas reales
  [
    /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=]))(?<=(?:aws|AWS|Aws)[\s\S]{0,300})(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[0-9])(?=[A-Za-z0-9/+]{0,39}[/+])[A-Za-z0-9/+]{40}/g,
    '[REDACTED:aws-secret]',
  ],
];

export interface RedactResult {
  text: string;
  count: number;
}

export function redact(input: string): RedactResult {
  let text = input;
  let count = 0;
  for (const [re, rep] of RULES) {
    if (typeof rep === 'string') {
      const n = text.match(re)?.length ?? 0;
      if (n) {
        count += n;
        text = text.replace(re, rep);
      }
    } else {
      text = text.replace(re, (m: string, ...g: string[]) => {
        const out = rep(m, ...g);
        if (out !== m) count++;
        return out;
      });
    }
  }
  return { text, count };
}

/** Margen tras el corte: más largo que cualquier secreto que una regla pueda reconocer. */
export const REDACT_MARGIN = 4096;

/**
 * Redacta lo justo para luego recortar a `n` caracteres: un prefijo de `n + margen`
 * y no el texto entero (que puede tener cientos de KB). Si las sustituciones
 * encogen tanto el prefijo que lo que queda tras el corte podría venir del borde
 * (donde una clave pudo quedar partida), se repite con el doble de ventana.
 */
export function redactPrefix(s: string, n: number): RedactResult {
  let win = n + REDACT_MARGIN;
  for (;;) {
    const r = redact(s.slice(0, win));
    if (win >= s.length || r.text.length >= n + REDACT_MARGIN / 2) return r;
    win *= 2;
  }
}

/** Archivos cuyo contenido nunca debe salir: .env, claves, credenciales. */
export function isSecretFile(path: string): boolean {
  return /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|p12|pfx)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i.test(
    path,
  );
}

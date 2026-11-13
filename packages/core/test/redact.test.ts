import { describe, expect, it } from 'vitest';
import { redact, redactPrefix } from '../src/redact.ts';

// Secretos falsos (con forma realista, ninguno es real).
const A = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
const SECRETS: Record<string, { text: string; secret: string }> = {
  aws_akid: { text: 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE', secret: 'AKIAIOSFODNN7EXAMPLE' },
  aws_akid_bare: { text: 'key is AKIAZ7Q2X4C6V8B0N1M3 ok', secret: 'AKIAZ7Q2X4C6V8B0N1M3' },
  aws_secret_ini: { text: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  aws_secret_bare: { text: 'the secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', secret: 'wJalrXUtnFEMI/K7MDENG' },
  ghp: { text: 'GH ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5', secret: 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5' },
  github_pat: { text: 'github_pat_11ABCDEFG0' + A + 'xYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456', secret: A },
  anthropic: { text: 'ANTHROPIC sk-ant-api03-' + A + '-' + A + 'AA', secret: A },
  openai_proj: { text: 'sk-proj-' + A + '_T3BlbkFJ' + A, secret: A },
  slack_xoxb: { text: 'xoxb-123456789012-1234567890123-' + 'AbCdEfGhIjKlMnOpQrStUvWx', secret: 'AbCdEfGhIjKlMnOpQrStUvWx' },
  slack_xapp: { text: 'xapp-1-A0123456789-1234567890123-' + 'abcdef0123456789abcdef0123456789', secret: 'abcdef0123456789abcdef0123456789' },
  stripe_live: { text: 'sk_live_' + '51H8xYzAbCdEfGhIjKlMnOpQr', secret: '51H8xYzAbCdEfGhIjKlMnOpQr' },
  stripe_whsec: { text: 'whsec_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', secret: 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' },
  pem_rsa: { text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----', secret: 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn' },
  pem_openssh: { text: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', secret: 'b3BlbnNzaC1rZXktdjEAAAAA' },
  pem_pgp: { text: '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF0n3kQBCADxyz123456\n-----END PGP PRIVATE KEY BLOCK-----', secret: 'lQOYBF0n3kQBCADxyz123456' },
  pem_json_escaped: { text: '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0\\n-----END PRIVATE KEY-----\\n"', secret: 'MIIEvQIBADANBgkqhkiG9w0' },
  jwt: { text: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', secret: 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
  env_password: { text: 'PASSWORD=hunter2hunter2', secret: 'hunter2hunter2' },
  env_db_pass: { text: 'DB_PASS=Sup3rS3cretValue', secret: 'Sup3rS3cretValue' },
  env_short_pw: { text: 'PASSWORD=abc12', secret: 'abc12' },
  yaml_password: { text: 'password: correct-horse-battery', secret: 'correct-horse-battery' },
  json_password: { text: '{"password": "correct-horse-battery"}', secret: 'correct-horse-battery' },
  url_userpass: { text: 'postgres://admin:s3cr3tP4ss@db.internal:5432/app', secret: 's3cr3tP4ss' },
  url_redis_nouser: { text: 'REDIS=redis://:s3cr3tP4ssw0rd@cache:6379', secret: 's3cr3tP4ssw0rd' },
  url_redis_nouser_bare: { text: 'connect to redis://:s3cr3tP4ssw0rd@cache:6379 now', secret: 's3cr3tP4ssw0rd' },
  url_pass_with_slash: { text: 'https://bob:pa/ss-w0rd-xyz@git.example.com/repo.git', secret: 'pa/ss-w0rd-xyz' },
  bearer: { text: 'Authorization: Bearer ' + A, secret: A },
  bearer_short: { text: 'Authorization: Bearer abc123def456', secret: 'abc123def456' },
  curl_user: { text: 'curl -u admin:Sup3rS3cretValue https://api.example.com', secret: 'Sup3rS3cretValue' },
  azure_conn: {
    text: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;',
    secret: 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq',
  },
  sendgrid: { text: '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', secret: 'TwL2iGABf9DHoTf-09kqeF8tAmbihYzrnopKc-1s5cr' },
  mysql_p: { text: 'mysql -u root -pSup3rS3cretValue', secret: 'Sup3rS3cretValue' },
  sshpass: { text: "sshpass -p 'Sup3rS3cretValue' ssh host", secret: 'Sup3rS3cretValue' },
  // AIza + 35 caracteres
  gcp_api: { text: 'AIzaSyD-' + 'abcdefghijklmnopqrstuvwxyz01234', secret: 'abcdefghijklmnopqrstuvwxyz01234' },
  npm_rc: { text: '//registry.npmjs.org/:_authToken=npm_' + A, secret: A },
  // ronda 2 (R2-3): formatos que sobrevivían
  env_quoted_spaces: { text: 'PASSWORD="correct horse battery staple"', secret: 'horse battery' },
  yaml_quoted_spaces: { text: "db_password: 'tr0ub4dor and 3'", secret: 'tr0ub4dor and 3' },
  password_flag_eq_quoted: { text: '--password="two words here"', secret: 'two words here' },
  netrc: { text: 'machine api.example.com login bob password Hunter2Hunter2', secret: 'Hunter2Hunter2' },
  netrc_multiline: { text: 'machine api.example.com\n  login bob\n  password Hunter2Hunter2\n', secret: 'Hunter2Hunter2' },
  docker_auth: { text: '{"auths":{"ghcr.io":{"auth":"Ym9iOlN1cDNyUzNjcmV0VmFsdWVYWVo="}}}', secret: 'Ym9iOlN1cDNyUzNjcmV0VmFsdWVYWVo=' },
  pypi: { text: 'pypi-AgEIcHlwaS5vcmcCJGE4ZjRkNmJjLTk4ZDYtNDQ0Yi05MDFmLWI3MDkwMjZmY2MyMQACKlszLCJ', secret: 'AgEIcHlwaS5vcmcCJGE4ZjRk' },
  google_oauth_access: { text: 'access ya29.a0AfH6SMBx3kQ9vZ-EXAMPLEexampleEXAMPLEexampleEXAMPLE1234', secret: 'a0AfH6SMBx3kQ9vZ' },
  google_client_secret: { text: 'client id ok, GOCSPX-1a2B3c4D5e6F7g8H9i0JkLmNoPq', secret: 'GOCSPX-1a2B3c4D5e6F7g8H9i0JkLmNoPq' },
  cookie: { text: 'Cookie: sessionid=9f8e7d6c5b4a39281706f5e4d3c2b1a0; csrftoken=abc', secret: '9f8e7d6c5b4a39281706f5e4d3c2b1a0' },
  cookie_curl: { text: `curl -H 'Cookie: sid=9f8e7d6c5b4a3928' https://x`, secret: '9f8e7d6c5b4a3928' },
  set_cookie: { text: 'Set-Cookie: __Host-sid=s%3AxYz123AbC456dEf789.gHi; Path=/', secret: 'xYz123AbC456dEf789' },
  url_token_user: { text: 'git clone https://f3a9c2b17e8d4c6a9b0e1f2d3c4b5a69@git.example.com/org/repo.git', secret: 'f3a9c2b17e8d4c6a9b0e1f2d3c4b5a69' },
  azure_sas: {
    text: 'https://acct.blob.core.windows.net/c/f?sv=2022-11-02&ss=b&sig=Zk9aT3V4S2xQd0VYQU1QTEVfc2lnbmF0dXJl%3D',
    secret: 'Zk9aT3V4S2xQd0VYQU1QTEVfc2lnbmF0dXJl',
  },
  twilio_sk: { text: 'twilio SK0123456789abcdef0123456789abcdef', secret: 'SK0123456789abcdef0123456789abcdef' },
  discord: { text: 'bot MTEyMzQ1Njc4OTAxMjM0NTY3OA.GhIjKl.abcdefghijklmnopqrstuvwxyz0123456789AB', secret: 'abcdefghijklmnopqrstuvwxyz0123456789AB' },
  putty: { text: 'PuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1\nAAAAIGd3ZXJ0eXVpb3Bhc2RmZ2hqa2w=\n', secret: 'AAAAIGd3ZXJ0eXVpb3Bhc2RmZ2hqa2w=' },
  pgpass: { text: 'db.internal:5432:app:admin:S3cr3tPgPass', secret: 'S3cr3tPgPass' },
  export_pw_space: { text: 'export MYSQL_PWD Sup3rS3cret', secret: 'Sup3rS3cret' },
  aws_secret_far: { text: 'AWS creds below\nAKIA... and then on next line: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', secret: 'wJalrXUtnFEMI/K7MDENG' },
  mnemonic: {
    text: 'seed phrase: abandon ability able about above absent absorb abstract absurd abuse access accident',
    secret: 'absorb abstract',
  },
  openai_admin: { text: 'sk-admin-' + 'A1b2C3d4E5f6G7h8I9j0K1l2', secret: 'A1b2C3d4E5f6G7h8I9j0K1l2' },
  mysql_long: { text: 'mysql --user=root --password=Sup3rS3cretValue db', secret: 'Sup3rS3cretValue' },
  psql_env_inline: { text: 'PGPASSWORD=s3cr3t psql -h db', secret: 's3cr3t' },
  mysql_pwd_env: { text: 'MYSQL_PWD=s3cr3tpw mysql -u root', secret: 's3cr3tpw' },
  x_api_key_hdr: { text: 'X-API-KEY: 0123456789abcdef', secret: '0123456789abcdef' },
  private_key_hex: { text: 'PRIVATE_KEY=0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', secret: '4c0883a69102937d6231471b5dbb6204' },
  // un PIN corto con nombre de contraseña se sigue tapando: no se distingue de uno real
  passcode_short: { text: 'passcode=1234', secret: '1234' },
};

/** Texto corriente que tiene que salir idéntico: código, SHAs, UUIDs, rutas, URLs y prosa. */
const BENIGN: Record<string, string> = {
  git_sha: 'commit 3f9a2b7c1d4e5f60718293a4b5c6d7e8f9012345 (HEAD -> main)',
  git_sha_key: 'the key commit is 3f9a2b7c1d4e5f60718293a4b5c6d7e8f9012345',
  git_short: 'revert a1b2c3d and cherry-pick 9e8f7a6',
  sha_upper_key: 'key fingerprint 2FD4E1C67A2D28FCED849EE1BB76E7391B93EB12',
  uuid: 'session 0e8f7a2c-3b4d-4e5f-8a9b-1c2d3e4f5a6b resumed',
  uuid_secret: 'secret id 0e8f7a2c-3b4d-4e5f-8a9b-1c2d3e4f5a6b',
  paths: 'edit /Users/dev/projects/app/src/index.ts and ~/Library/LaunchAgents/com.example.agent.plist',
  path_line: 'see packages/core/src/redact.ts:29 and src/auth/token-store.ts',
  urls: 'https://github.com/owner/repo/pull/42 · https://example.com:8443/api/v1/users?page=2',
  vite_url: 'GET http://localhost:5173/@vite/client 200',
  npm_scope_port: 'https://registry.example.com:443/@scope/pkg/-/pkg-1.0.0.tgz',
  git_ssh: 'git clone git@github.com:owner/repo.git',
  pg_nopass: 'DATABASE_URL=postgres://localhost:5432/app',
  ts_code:
    'export async function login(user: string, password: string): Promise<Session> {\n  const res = await fetch(url, { method: "POST" });\n  return res.json();\n}',
  ts_interface: 'interface Creds { user: string; password: string; token?: string | null }',
  max_tokens: 'const body = { model, max_tokens: 1024, temperature: 0 };',
  booleans: 'password: true\napi_key: null\nbypass=true\ncompass=north\npasses: 3',
  shell: 'npm install --save-dev vitest && git log --oneline -n 20',
  mysql_noflag: 'mysql -u root -P 3306 -h db.local app',
  curl_nopass: 'curl -u admin https://api.example.com/health',
  es_prose:
    'Arreglé el parsing del token y la contraseña ya no se guarda en claro. El objetivo es revisar la clave de la caché antes del viernes.',
  en_prose:
    'Fix token parsing when the password field is empty. Use Bearer authentication for the API; the Basic configuration and Token expiration are documented. The secret sauce is caching.',
  markdown: '## Hecho\n- Parser corregido\n- Tests: 144 passed (144)\n```ts\nconst x = 1;\n```',
  // ronda 2 (REG-2): variables de shell, el directorio de trabajo y asignaciones de código
  shell_pwd: 'PWD=/tmp\nOLDPWD=/Users/dev\ncd $PWD && ls',
  mysql_other_cmd: 'npm i mysql && npm run build -prod',
  bearer_word_digits: 'The Bearer token1234 pattern',
  curl_shell_vars: 'curl -u "$USER:$PASS" https://x',
  sshpass_shell_var: 'sshpass -p "$SSHPASS" ssh host',
  env_shell_var: 'API_TOKEN=$API_TOKEN\nexport DB_PASSWORD="${DB_PASSWORD}"',
  conn_str_call: 'connStr = buildConnectionString(cfg)',
  token_call: 'const token = getToken();',
  password_member: 'const password = form.password.value;',
  session_key_this: 'class SessionKeyManager { sessionKey = this.derive(); }',
  token_await: 'const token = await fetchToken(url);',
  url_query_at: 'see http://127.0.0.1:8080?next=@home and http://localhost:5173/@vite/client',
  password_prose_line: 'password reset\npassword manager',
  default_password_prose: 'the default password is set on first login',
  pgpass_like_log: 'src/app.ts:12:5: error: unexpected token',
  cookie_prose: 'The cookie banner is shown once.',
  ssh_url_user: 'ssh://git@github.com/owner/repo.git',
  export_prose: 'export TOKEN_COUNT\nexport the token data',
};

describe('redact: secretos', () => {
  for (const [name, { text, secret }] of Object.entries(SECRETS)) {
    it(`tapa ${name}`, () => {
      const r = redact(text);
      expect(r.text).not.toContain(secret);
      expect(r.text).toContain('[REDACTED');
      expect(r.count).toBeGreaterThan(0);
    });
  }

  it('es idempotente: redactar dos veces no cambia nada ni cuenta de nuevo', () => {
    for (const { text } of Object.values(SECRETS)) {
      const once = redact(text).text;
      const twice = redact(once);
      expect(twice.text).toBe(once);
      expect(twice.count).toBe(0);
    }
  });
});

describe('redact: entradas patológicas', () => {
  // R2-2: entradas de 200 KB que con reglas sin tope tardaban segundos (backtracking cuadrático)
  it('redacta 200 KB adversariales en tiempo lineal (< 200 ms por llamada)', () => {
    const N = 200_000;
    const fill = (t: string) => t.repeat(Math.ceil(N / t.length)).slice(0, N);
    const inputs = [
      fill('a.'), fill('a-'), fill('x_'), fill('a://'), fill('http://'), fill('eyJ-'), fill('secret.'), fill('token='),
      fill('Key '), fill('aws '), fill('Ab1/'), fill('Cookie: '), fill('Bearer a1'), fill('machine a '), fill('"token":"'),
      fill('password '), fill('curl -u a'), fill('mysql -'), fill('sshpass -a '), fill('SG.'), fill('Private-Lines: 1\n'),
      'secret ' + 'a.'.repeat(N / 2), 'key ' + 'Ab1/'.repeat(N / 4), 'https://' + 'a'.repeat(N), '-----BEGIN PRIVATE KEY-----' + 'A'.repeat(N),
    ];
    for (const s of inputs) {
      const t = performance.now();
      redact(s);
      expect(performance.now() - t, JSON.stringify(s.slice(0, 20))).toBeLessThan(200);
    }
  });

  it('redactPrefix solo redacta lo necesario para el corte y no deja trozos de clave en él', () => {
    const big = 'a.'.repeat(100_000);
    const t = performance.now();
    const r = redactPrefix(big, 1200);
    expect(performance.now() - t).toBeLessThan(50);
    expect(r.text.length).toBeLessThan(big.length);
    // muchas claves seguidas encogen el prefijo: la ventana crece hasta cubrir el corte
    const key = 'sk-ant-api03-' + A + A;
    const many = Array.from({ length: 400 }, () => key).join(' ');
    const r2 = redactPrefix(many, 1200);
    expect(r2.text.slice(0, 1200)).not.toContain('sk-ant-api03-A');
    expect(r2.text.length).toBeGreaterThan(1200);
  });

  it('no se atasca con textos largos y repetitivos (sin backtracking cuadrático)', () => {
    const inputs = ['http://'.repeat(30_000), 'curl '.repeat(50_000), 'mysql '.repeat(50_000), 'secret '.repeat(50_000), 'x_'.repeat(100_000) + '='];
    for (const s of inputs) {
      const t = performance.now();
      redact(s);
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });
});

describe('redact: falsos positivos', () => {
  for (const [name, text] of Object.entries(BENIGN)) {
    it(`deja intacto ${name}`, () => {
      const r = redact(text);
      expect(r.text).toBe(text);
      expect(r.count).toBe(0);
    });
  }
});

describe('redact: ronda 3', () => {
  it('JWT con payload grande (R3-1)', () => {
    const b64 = (n: number) => 'A'.repeat(n);
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJ${b64(12_000)}.${'s'.repeat(43)}`;
    const t0 = performance.now();
    const out = redact(`token: ${jwt} fin`).text;
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out).not.toContain('sssssss');
    expect(out).not.toContain(b64(100));
  });
  it('contraseña que empieza por $ (R3-2)', () => {
    expect(redact('PASSWORD=$Zq8vK2!pLm9').text).not.toContain('Zq8vK2');
  });
  it('referencias a variables de shell siguen intactas', () => {
    for (const t of ['PASSWORD=$PASS', 'PASSWORD="${DB_PASSWORD}"', 'export TOKEN=$GH_TOKEN; echo ok']) {
      expect(redact(t).text).toBe(t);
    }
  });
});

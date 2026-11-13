// Página local del popover cuando el daemon no responde. Solo ella tiene IPC.
const invoke = window.__TAURI__?.core?.invoke;
const btn = document.getElementById('start');
const msg = document.getElementById('msg');

const say = (text, error = false) => {
  msg.textContent = text;
  msg.className = error ? 'muted error' : 'muted';
};

async function waitUp(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await invoke('daemon_status')) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

btn.addEventListener('click', async () => {
  if (!invoke) return say('Esta página solo funciona dentro de la app.', true);
  btn.disabled = true;
  say('Arrancando…');
  try {
    await invoke('start_daemon');
    if (await waitUp(15000)) await invoke('open_panel');
    else say('launchd lo ha lanzado pero aún no responde. Mira ~/.claude-panel/logs/daemon.err.log', true);
  } catch (e) {
    say(String(e), true);
  } finally {
    btn.disabled = false;
  }
});

// si el daemon vuelve por su cuenta (KeepAlive), pasa solo al panel
setInterval(async () => {
  if (invoke && (await invoke('daemon_status'))) invoke('open_panel');
}, 3000);

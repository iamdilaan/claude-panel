import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { configPath } from './paths.ts';

/**
 * ~/.claude-panel/config.json (opcional). Todo tiene un valor por defecto
 * seguro; un archivo inválido se ignora con un aviso en lugar de romper el daemon.
 */
export const ConfigSchema = z.object({
  /** Borra copias locales de sesiones sin actividad en N días. null = nunca (por defecto). */
  archive_retention_days: z.number().int().positive().nullable().default(null),
  /** Guardar copia local filtrada y redactada de cada transcript (opción C). */
  archive_enabled: z.boolean().default(true),
  /**
   * Atajo global de la app de barra de menú (sintaxis de Tauri: Alt, Super/Cmd,
   * Shift, Ctrl + tecla). Lo lee la app al arrancar; si es inválido usa el de por defecto.
   */
  shortcut: z.string().min(1).max(60).default('Alt+Super+P'),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path = configPath()): { config: Config; error: string | null } {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { config: ConfigSchema.parse({}), error: `config.json ilegible: ${(e as Error).message}` };
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  return parsed.success
    ? { config: parsed.data, error: null }
    : { config: ConfigSchema.parse({}), error: `config.json inválido: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}` };
}

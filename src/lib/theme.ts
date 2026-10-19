import * as ipc from './ipc';

/**
 * Tema visual de la aplicacion.
 *
 * `system` sigue la preferencia del sistema operativo y se actualiza solo si el
 * usuario la cambia mientras la app esta abierta.
 *
 * La fuente de verdad es `settings.json` (Rust); `localStorage` guarda una copia
 * para pintar sin parpadeo antes de que responda el backend.
 */
export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'foxen.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function normalizeTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

function readCache(): Theme | null {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeCache(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Sin cache se pinta tras la respuesta del backend; no es fatal.
  }
}

/** Tema que se ve realmente, resolviendo `system`. */
export function resolveTheme(theme: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

/** Tema para el primer pintado (cache); el backend confirma despues. */
export function loadTheme(): Theme {
  return readCache() ?? 'system';
}

/**
 * Lee el tema persistido en Rust y migra la cache de versiones anteriores.
 * Devuelve `null` si el usuario nunca eligio tema.
 */
export async function loadStoredTheme(): Promise<Theme | null> {
  const legacy = readCache();
  try {
    const settings = await ipc.settingsLoad();
    const stored = normalizeTheme(settings.theme);
    if (!stored && legacy) {
      // Migracion unica: la preferencia del webview pasa al archivo.
      void ipc.settingsSaveTheme(legacy).catch(() => undefined);
      return legacy;
    }
    return stored;
  } catch {
    return legacy;
  }
}

/** Persiste el tema en Rust y actualiza la cache de arranque. */
export function saveTheme(theme: Theme): void {
  writeCache(theme);
  void ipc.settingsSaveTheme(theme).catch(() => undefined);
}

/** Aplica el tema al `<html>`; el CSS decide la paleta segun este atributo. */
export function applyTheme(theme: Theme): 'light' | 'dark' {
  const prefersDark = window.matchMedia(DARK_QUERY).matches;
  const resolved = resolveTheme(theme, prefersDark);
  document.documentElement.dataset.theme = resolved;
  // El tema efectivo se publica para que el CSS pueda afinar contrastes.
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

/** Avisa cuando cambia la preferencia del sistema, para el modo `system`. */
export function onSystemThemeChange(handler: (prefersDark: boolean) => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const listener = (e: MediaQueryListEvent) => handler(e.matches);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
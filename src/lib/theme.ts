/**
 * Tema visual de la aplicacion.
 *
 * `system` sigue la preferencia del sistema operativo y se actualiza solo si el
 * usuario la cambia mientras la app esta abierta.
 */
export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'foxen.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Tema que se ve realmente, resolviendo `system`. */
export function resolveTheme(theme: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

/** Lee el tema guardado; si no hay o es invalido, se sigue al sistema. */
export function loadTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage puede estar bloqueado (contenedor o modo privado).
  }
  return 'system';
}

export function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Sin persistencia la preferencia solo vive en esta sesion.
  }
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
/**
 * Ajustes de comportamiento de escritorio.
 *
 * Foxen corre dentro de un WebView, pero no es un navegador: hay que apagar los
 * atajos y el menú contextual que el WebView trae por defecto (recargar,
 * imprimir, zoom, ver código fuente, herramientas de desarrollo…), porque no
 * tienen sentido en una app de escritorio y pueden sacar al usuario del flujo
 * de trabajo.
 */

/**
 * `true` si el evento corresponde a un atajo de navegador que debe anularse.
 *
 * `isDev` permite testear ambas ramas: en desarrollo las devtools quedan
 * accesibles (F12, Ctrl/⌘+Shift+I/J/C) porque son herramientas de trabajo.
 */
export function isBrowserShortcut(
  event: KeyboardEvent,
  isDev: boolean = import.meta.env.DEV,
): boolean {
  const key = event.key.toLowerCase();

  // Teclas de función del navegador.
  if (key === 'f5' || key === 'f7') return true;

  if (key === 'f12') return !isDev;
  if (!isDev && event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key)) {
    return true;
  }

  if (!event.ctrlKey && !event.metaKey) return false;

  // Recargar, imprimir, ver código fuente, guardar página, abrir, ventana nueva.
  if (['r', 'p', 'u', 's', 'o', 'n'].includes(key)) return true;

  // Zoom del WebView: Ctrl/⌘ + «+», «-» o «0».
  if (['+', '-', '=', '0'].includes(key)) return true;

  return false;
}

/**
 * Deshabilita menú contextual, atajos y gestos de navegador.
 * Debe llamarse una sola vez, antes de montar la interfaz.
 */
export function disableBrowserFeatures(): void {
  // Menú contextual (clic derecho): en un WebView ofrece opciones de navegador.
  window.addEventListener('contextmenu', (event) => event.preventDefault());

  // Atajos de navegador. Se usa la fase de captura para adelantarse a la UI.
  window.addEventListener(
    'keydown',
    (event) => {
      if (isBrowserShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { capture: true },
  );

  // Ctrl/⌘ + rueda también hace zoom en el WebView.
  window.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    },
    { passive: false },
  );
}

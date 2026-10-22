import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Channel } from '@tauri-apps/api/core';
import * as ipc from '../lib/ipc';
import { errorMessage } from '../lib/ipc';
import { decodeBase64, encodeBase64 } from '../lib/b64';
import type { PtyOutput } from '../lib/types';
import { useStore } from '../store/useAppStore';
import { getLocale } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';

/** Altura por defecto del panel, en pixeles. */
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;

/**
 * Paleta de la terminal.
 *
 * Los colores son fijos y no salen de las variables CSS porque xterm pinta en
 * un `<canvas>`: no puede leer `var(--bg)`. Se replican aqui la paleta de
 * `styles.css` (`:root` = claro, `[data-theme='dark']` = oscuro).
 */
const TERMINAL_THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    selectionBackground: 'rgba(9, 105, 218, 0.30)',
    black: '#24292f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#7d4e00',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#1b7c83',
    brightWhite: '#8c959f',
  },
  dark: {
    background: '#0d1117',
    foreground: '#e6edf3',
    cursor: '#e6edf3',
    selectionBackground: 'rgba(88, 166, 255, 0.30)',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
};

const NOTICE_ES = '\r\n\x1b[2m[proceso terminado]\x1b[0m\r\n';
const NOTICE_EN = '\r\n\x1b[2m[process exited]\x1b[0m\r\n';

/** Terminal embebida: un shell del usuario corriendo en la PTY del repositorio. */
export function TerminalPanel() {
  const { t } = useI18n();
  const repoId = useStore((s) => s.repoId);
  const repositories = useStore((s) => s.repositories);
  const resolvedTheme = useStore((s) => s.resolvedTheme);
  const toggleTerminal = useStore((s) => s.toggleTerminal);
  const notify = useStore((s) => s.notify);

  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const repo = repositories.find((r) => r.id === repoId);
  const cwd = repo?.path ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !repoId || !cwd) return;

    const term = new Terminal({
      // El tema inicial se lee aqui y no como dependencia: cambiar de tema no
      // debe recrear la terminal (perderia el scrollback y el proceso).
      theme: TERMINAL_THEMES[useStore.getState().resolvedTheme],
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      // Copiar/pegar con Alt en lugar de Ctrl, que el shell se reserva.
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    const channel = new Channel<PtyOutput>((message) => {
      if (message.exited) {
        term.write(getLocale() === 'en' ? NOTICE_EN : NOTICE_ES);
        return;
      }
      if (message.data) term.write(decodeBase64(message.data));
    });

    let startPromise: Promise<void> | null = null;
    const start = () => {
      fit.fit();
      const { cols, rows } = term;
      // Se guarda la promesa de arranque: el cleanup espera a que termine antes
      // de parar, si no `stop_pty` puede llegar antes de que la sesion exista y
      // el shell queda huerfano.
      startPromise = ipc.startPty(repoId, cwd, cols, rows, channel).catch((error) => {
        notify('error', errorMessage(error));
      });
    };
    // `fit` necesita una medida real del DOM: se espera al primer layout.
    const frame = requestAnimationFrame(start);

    const dataDisposable = term.onData((data) => {
      // Si falla es que el shell ya murio; el aviso llega por el canal.
      void ipc.writePty(repoId, encodeBase64(data)).catch(() => undefined);
    });

    let lastSize = '';
    const observer = new ResizeObserver(() => {
      fit.fit();
      const size = `${term.cols}x${term.rows}`;
      if (size === lastSize) return;
      lastSize = size;
      void ipc.resizePty(repoId, term.cols, term.rows).catch(() => undefined);
    });
    observer.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataDisposable.dispose();
      // Solo se mata si llego a arrancar. Se espera a que la promesa de arranque
      // se resuelva para que `stopPty` no compita con `startPty`.
      if (startPromise) {
        void startPromise.finally(() => ipc.stopPty(repoId).catch(() => undefined));
      }
      term.dispose();
      termRef.current = null;
    };
  }, [repoId, cwd, notify]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = TERMINAL_THEMES[resolvedTheme];
  }, [resolvedTheme]);

  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: height };
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setHeight(Math.max(MIN_HEIGHT, drag.startHeight + (drag.startY - event.clientY)));
  };

  const onResizeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (!repoId || !cwd) return null;

  return (
    <section className="terminal-panel" style={{ height }}>
      <div
        className="terminal-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('Redimensionar terminal')}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />

      <header className="terminal-head">
        <span className="terminal-title">{t('Terminal')}</span>
        <code className="terminal-cwd">{cwd}</code>
        <div className="terminal-actions">
          <button
            type="button"
            className="link"
            onClick={() =>
              void ipc.openTerminal(repoId).then(
                (result) => notify('success', result.message),
                (error) => notify('error', errorMessage(error)),
              )
            }
          >
            {t('abrir en el sistema')}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={toggleTerminal}
            aria-label={t('Cerrar terminal')}
            title={t('Cerrar terminal')}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="terminal-host" ref={hostRef} />
    </section>
  );
}

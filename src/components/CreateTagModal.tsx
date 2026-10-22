import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';

/**
 * Dialogo que se ofrece tras fusionar una rama hacia la principal: propone
 * crear un tag anotado (release) sobre esa rama, con la version siguiente
 * sugerida a partir de los tags existentes.
 */
export function CreateTagModal() {
  const prompt = useStore((s) => s.tagPrompt);
  const close = useStore((s) => s.closeTagPrompt);
  const run = useStore((s) => s.run);
  const repoId = useStore((s) => s.repoId);
  const loading = useStore((s) => s.loading);

  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prompt) {
      setName(prompt.suggested);
      setMessage(`Release ${prompt.suggested}`);
    }
  }, [prompt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) close();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [close, loading]);

  if (!prompt || !repoId) return null;

  const trimmed = name.trim();
  const valid = trimmed.length > 0;

  const create = () => {
    if (!valid) return;
    void run(`Crear tag ${trimmed}`, async () => {
      const result = await ipc.createTag(
        repoId,
        trimmed,
        message.trim() ? message.trim() : null,
        prompt.branch,
        false,
      );
      close();
      return result;
    });
  };

  return (
    <div className="modal-overlay" onClick={() => !loading && close()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Crear etiqueta de version"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Crear etiqueta</h2>
        </header>

        <div className="modal-body">
          <p className="hint">
            Se fusionó hacia <strong>{prompt.branch}</strong>. Puedes marcar una
            versión en ese punto del historial.
            {prompt.latest && (
              <>
                {' '}
                Última versión detectada: <strong>{prompt.latest}</strong>.
              </>
            )}
          </p>

          <label className="field">
            <span>Nombre del tag</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="v0.1.0"
              autoFocus
            />
          </label>

          <label className="field">
            <span>Mensaje (tag anotado)</span>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={prompt.suggested ? `Release ${prompt.suggested}` : 'Release'}
            />
          </label>

          <p className="hint">
            Si dejas el mensaje vacío se creará un tag ligero. El tag apunta al
            commit actual de <strong>{prompt.branch}</strong>.
          </p>
        </div>

        <footer className="modal-footer">
          <button type="button" onClick={close} disabled={loading}>
            Ahora no
          </button>
          <button
            type="button"
            className="primary"
            onClick={create}
            disabled={loading || !valid}
          >
            Crear tag
          </button>
        </footer>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import { CommitDetailView } from './CommitDetail';
import { DiffPanel } from './ChangesPanel';

/**
 * Detalle del commit en un popup.
 *
 * Sustituye a la columna fija de la derecha: se abre desde el boton de cada
 * fila del grafo (o desde ramas/reflog) y deja libre ese espacio en pantalla.
 * Los archivos del commit se abren dentro del mismo popup.
 */
export function CommitDetailModal() {
  const selectedOid = useStore((s) => s.selectedOid);
  const detail = useStore((s) => s.selectedDetail);
  const selectedFile = useStore((s) => s.selectedFile);
  const selectedSide = useStore((s) => s.selectedSide);
  const selectedOldOid = useStore((s) => s.selectedOldOid);
  const diff = useStore((s) => s.diff);
  const closeDetail = useStore((s) => s.closeDetail);
  const [showFile, setShowFile] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Al cambiar de commit se vuelve al detalle, nunca al diff anterior.
  useEffect(() => setShowFile(false), [selectedOid]);

  // Escape cierra y el foco entra al dialogo al abrirlo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDetail]);

  const fileView =
    showFile &&
    selectedFile !== null &&
    selectedSide === 'commit' &&
    selectedOldOid === selectedOid;
  const diffReady =
    fileView && diff !== null && diff.files.some((file) => file.path === selectedFile);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDetail();
      }}
    >
      <div
        className="modal detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-modal-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id="detail-modal-title">
            {fileView ? 'Archivo del commit' : 'Detalle del commit'}
          </h2>
          <div className="detail-modal-actions">
            {fileView && (
              <button type="button" className="detail-back" onClick={() => setShowFile(false)}>
                ← Volver
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={closeDetail}
              aria-label="Cerrar detalle del commit"
            >
              ×
            </button>
          </div>
        </header>

        <div className="detail-modal-body">
          {!detail ? (
            <p className="empty">Cargando detalle…</p>
          ) : fileView ? (
            diffReady ? (
              <DiffPanel />
            ) : (
              <p className="empty">Cargando diff…</p>
            )
          ) : (
            <CommitDetailView onFileOpen={() => setShowFile(true)} />
          )}
        </div>
      </div>
    </div>
  );
}

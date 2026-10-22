import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import { useI18n } from '../lib/useI18n';
import {
  HELP_SECTIONS,
  helpSearchText,
  helpText,
  type Bilingual,
  type HelpBlock,
} from '../lib/help';

/** Convierte **negritas** y `código` en elementos de React. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return part;
      })}
    </>
  );
}

function HelpBlockView({
  block,
  locale,
  t,
}: {
  block: HelpBlock;
  locale: 'es' | 'en';
  t: (text: string, vars?: Record<string, string | number>) => string;
}) {
  const value = (text: Bilingual) => helpText(text, locale);
  switch (block.type) {
    case 'p':
      return (
        <p className="help-p">
          <RichText text={value(block.text)} />
        </p>
      );
    case 'steps':
      return (
        <ol className="help-steps">
          {block.items.map((item, index) => (
            <li key={index}>
              <RichText text={value(item)} />
            </li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul className="help-list">
          {block.items.map((item, index) => (
            <li key={index}>
              <RichText text={value(item)} />
            </li>
          ))}
        </ul>
      );
    case 'keys':
      return (
        <ul className="help-keys">
          {block.items.map((item, index) => (
            <li key={index}>
              <kbd>{item.keys}</kbd>
              <span>
                <RichText text={value(item.text)} />
              </span>
            </li>
          ))}
        </ul>
      );
    case 'tip':
      return (
        <div className="help-tip">
          <strong>{t('Consejo')}</strong>
          <p>
            <RichText text={value(block.text)} />
          </p>
        </div>
      );
  }
}

/** Manual de usuario modal, con buscador y navegacion por secciones. */
export function HelpPanel() {
  const { locale, t } = useI18n();
  const open = useStore((s) => s.helpOpen);
  const active = useStore((s) => s.helpSection);
  const setSection = useStore((s) => s.setHelpSection);
  const close = useStore((s) => s.closeHelp);
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return HELP_SECTIONS;
    return HELP_SECTIONS.filter((section) => helpSearchText(section).includes(needle));
  }, [query]);

  if (!open) return null;

  const current = HELP_SECTIONS.find((section) => section.id === active) ?? HELP_SECTIONS[0]!;

  return (
    <div
      className="modal-overlay help-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2 id="help-title">{t('Manual de Foxen')}</h2>
            <p className="help-subtitle">
              {t('Aprende a usar Foxen paso a paso. Busca un tema o navega por las secciones.')}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label={t('Cerrar ayuda')}
            title={t('Cerrar ayuda')}
          >
            ×
          </button>
        </header>

        <div className="help-body">
          <aside className="help-nav" aria-label={t('Contenido del manual')}>
            <label className="help-search">
              <span className="sr-only">{t('Buscar en el manual…')}</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('Buscar en el manual…')}
                autoFocus
              />
            </label>
            <nav className="help-sections">
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`help-section-link${section.id === current.id ? ' is-active' : ''}`}
                  aria-current={section.id === current.id ? 'page' : undefined}
                  onClick={() => setSection(section.id)}
                >
                  <strong>{helpText(section.title, locale)}</strong>
                  <small>{helpText(section.summary, locale)}</small>
                </button>
              ))}
              {sections.length === 0 && (
                <p className="help-empty">{t('No hay secciones que coincidan con la búsqueda.')}</p>
              )}
            </nav>
          </aside>

          <article className="help-content" aria-live="polite">
            <h3>{helpText(current.title, locale)}</h3>
            <p className="help-summary">{helpText(current.summary, locale)}</p>
            {current.blocks.map((block, index) => (
              <HelpBlockView key={index} block={block} locale={locale} t={t} />
            ))}
          </article>
        </div>

        <footer className="modal-footer help-footer">
          <span className="help-shortcut">
            <kbd>F1</kbd> <span>{t('o')}</span> <kbd>?</kbd> <span>{t('Abrir o cerrar la ayuda')}</span>
          </span>
          <button type="button" className="primary" onClick={close}>
            {t('Cerrar')}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Boton compacto reutilizable para abrir el manual en una seccion. */
export function HelpButton({
  section = 'intro',
  label,
  compact = false,
}: {
  section?: string;
  label?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const openHelp = useStore((s) => s.openHelp);
  const title = label ?? t('Ayuda');
  return (
    <button
      type="button"
      className={compact ? 'icon-button help-trigger' : 'help-link'}
      onClick={() => openHelp(section)}
      aria-label={title}
      title={title}
    >
      {compact ? '?' : `? ${title}`}
    </button>
  );
}

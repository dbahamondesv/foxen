import { useCallback } from 'react';
import { useStore } from '../store/useAppStore';
import { translate } from './i18n';

/** Hook de traduccion: `t('texto en español', { variable })`. */
export function useI18n() {
  const locale = useStore((s) => s.locale);
  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) => translate(text, vars, locale),
    [locale],
  );
  return { locale, t };
}

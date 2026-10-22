/**
 * Generador local de mensajes de commit (sin red ni IA).
 *
 * A partir de los archivos que estan en el indice se deduce un tipo
 * Conventional Commits (feat/fix/docs/test/refactor/perf/chore), un `scope`
 * si todos los cambios comparten un mismo directorio y un resumen breve en
 * espanol. El cuerpo enumera los archivos afectados.
 */

import { dirName, baseName } from './format';
import type { ChangeKind, FileStatus } from './types';

type CommitType = 'feat' | 'fix' | 'docs' | 'test' | 'refactor' | 'perf' | 'chore';

/** Etiqueta legible de cada tipo, para el resumen en espanol. */
const TYPE_LABEL: Record<CommitType, string> = {
  feat: 'anadir',
  fix: 'corregir',
  docs: 'actualizar la documentacion de',
  test: 'ampliar las pruebas de',
  refactor: 'reorganizar',
  perf: 'optimizar',
  chore: 'ajustar',
};

/** Extensiones que se consideran pruebas. */
const TEST_HINTS = ['.test.', '.spec.', '_test.', '/tests/', '/test/'];

/** Nombres frecuentes de documentacion. */
const DOC_NAMES = ['readme', 'changelog', 'licencia', 'license', 'contributing'];
const DOC_EXT = ['.md', '.mdx', '.rst', '.txt', '.adoc'];
const DOC_DIRS = ['doc/', 'docs/', 'documentacion/'];

function lower(path: string): string {
  return path.toLowerCase();
}

/** `true` si la ruta parece un archivo de pruebas. */
function isTestPath(path: string): boolean {
  const p = lower(path);
  return TEST_HINTS.some((hint) => p.includes(hint));
}

/** `true` si la ruta parece documentacion. */
function isDocPath(path: string): boolean {
  const p = lower(path);
  if (DOC_DIRS.some((dir) => p.startsWith(dir))) return true;
  const name = baseName(p);
  const stem = name.replace(/\.[^.]+$/, '');
  if (DOC_NAMES.includes(stem)) return true;
  return DOC_EXT.some((ext) => p.endsWith(ext));
}

/**
 * Deduce el tipo del commit a partir del conjunto de cambios.
 *
 * Reglas (de mas especifica a mas general):
 * 1. Solo documentacion -> `docs`.
 * 2. Solo pruebas -> `test`.
 * 3. Solo eliminaciones -> `chore` (limpieza).
 * 4. Hay archivos nuevos -> `feat`.
 * 5. Todo son correcciones de contenido -> `fix`.
 * 6. Resto -> `chore`.
 */
export function inferType(files: FileStatus[]): CommitType {
  if (files.length === 0) return 'chore';

  const allDocs = files.every((f) => isDocPath(f.path));
  if (allDocs) return 'docs';

  const allTests = files.every((f) => isTestPath(f.path));
  if (allTests) return 'test';

  const allDeleted = files.every((f) => f.kind === 'deleted');
  if (allDeleted) return 'chore';

  const hasAdded = files.some((f) => f.kind === 'added' || f.kind === 'untracked');
  if (hasAdded) return 'feat';

  const allModified = files.every(
    (f) => f.kind === 'modified' || f.kind === 'typeChanged',
  );
  if (allModified) return 'fix';

  return 'chore';
}

/**
 * Directorio comun de todos los archivos, si lo hay y aporta informacion.
 *
 * Devuelve el ultimo segmento del directorio comun (p. ej. `src/components`
 * -> `components`) o `null` si los archivos estan repartidos por varios
 * directorios de primer nivel.
 */
export function inferScope(files: FileStatus[]): string | null {
  if (files.length === 0) return null;
  const dirs = files.map((f) => dirName(f.path));
  const common = commonPathPrefix(dirs);
  if (!common) return null;
  const parts = common.split('/').filter(Boolean);
  // Con un solo archivo, el directorio entero es demasiado generico como scope;
  // se usa su ultimo segmento.
  const scope = parts[parts.length - 1];
  return scope && scope.length <= 20 ? scope : null;
}

/** Prefijo comun (por segmentos) de una lista de rutas. */
function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map((p) => p.split('/').filter(Boolean));
  const first = split[0] ?? [];
  const result: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const segment = first[i];
    if (segment === undefined) break;
    if (split.every((parts) => parts[i] === segment)) result.push(segment);
    else break;
  }
  return result.join('/');
}

/** Verbos en espanol para los distintos tipos de cambio. */
const VERB: Record<ChangeKind, (n: number) => string> = {
  added: (n) => (n === 1 ? 'anadir' : 'anadir'),
  untracked: () => 'anadir',
  modified: (n) => (n === 1 ? 'modificar' : 'modificar'),
  deleted: () => 'eliminar',
  renamed: () => 'renombrar',
  copied: () => 'copiar',
  typeChanged: () => 'cambiar el tipo de',
  ignored: () => 'ignorar',
  conflicted: () => 'resolver conflictos en',
};

/**
 * Construye el resumen (primera linea, tras `tipo(scope):`).
 *
 * Con un solo archivo se nombra; con varios se describe por categoria de
 * cambio (p. ej. "anadir 2 archivos y modificar 3").
 */
export function buildSummary(type: CommitType, files: FileStatus[]): string {
  if (files.length === 1) {
    const file = files[0];
    if (!file) return `${TYPE_LABEL[type]} 1 archivo`;
    const verb = VERB[file.kind] ?? TYPE_LABEL[type];
    return `${verb(1)} ${baseName(file.path)}`.trim();
  }

  const byKind = new Map<ChangeKind, number>();
  for (const file of files) {
    byKind.set(file.kind, (byKind.get(file.kind) ?? 0) + 1);
  }

  const order: ChangeKind[] = [
    'added',
    'untracked',
    'modified',
    'renamed',
    'copied',
    'typeChanged',
    'deleted',
    'conflicted',
    'ignored',
  ];

  const parts: string[] = [];
  for (const kind of order) {
    const count = byKind.get(kind);
    if (!count) continue;
    const noun = count === 1 ? 'archivo' : 'archivos';
    parts.push(`${VERB[kind](count)} ${count} ${noun}`);
  }

  if (parts.length === 0) return `${TYPE_LABEL[type]} ${files.length} archivos`;
  return parts.join(', ');
}

/**
 * Genera el mensaje completo (asunto + cuerpo con los archivos).
 *
 * El asunto sigue Conventional Commits: `tipo(scope): resumen`. El cuerpo
 * lista cada archivo con su marca de estado, para que el mensaje explique
 * brevemente que contiene el commit.
 */
export function generateCommitMessage(files: FileStatus[]): string {
  if (files.length === 0) return '';

  const type = inferType(files);
  const scope = inferScope(files);
  const summary = buildSummary(type, files);
  const header = scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`;

  const bullet = files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      const mark = markFor(file.kind);
      const rename = file.oldPath ? ` (antes ${file.oldPath})` : '';
      const stats =
        file.insertions > 0 || file.deletions > 0
          ? ` [+${file.insertions} −${file.deletions}]`
          : '';
      return `- ${mark} ${file.path}${rename}${stats}`;
    });

  return `${header}\n\n${bullet.join('\n')}`;
}

/** Marca corta de estado para el cuerpo del mensaje. */
function markFor(kind: ChangeKind): string {
  switch (kind) {
    case 'added':
    case 'untracked':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typeChanged':
      return 'T';
    case 'conflicted':
      return '!';
    default:
      return '?';
  }
}

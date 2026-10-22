/**
 * Generador local de mensajes de commit (sin red ni IA).
 *
 * A partir de los archivos que estan en el indice se deduce un tipo
 * Conventional Commits (feat/fix/docs/test/refactor/perf/chore), un `scope`
 * si todos los cambios comparten un mismo directorio y un resumen breve en
 * espanol. El cuerpo enumera los archivos afectados.
 */

import { dirName, baseName } from './format';
import type { ChangeKind, FileDiff, FileStatus } from './types';

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

/** Scopes demasiado genericos para aportar informacion. */
const GENERIC_SCOPES = new Set(['src', 'app', 'lib', 'source', 'core', 'web', 'main']);

/**
 * Directorio comun de todos los archivos, si lo hay y aporta informacion.
 *
 * Devuelve el ultimo segmento del directorio comun (p. ej. `src/components`
 * -> `components`) o `null` si los archivos estan repartidos por varios
 * directorios de primer nivel o el scope resultante es demasiado generico.
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
  if (!scope || scope.length > 20) return null;
  if (GENERIC_SCOPES.has(scope.toLowerCase())) return null;
  return scope;
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

// ---------------------------------------------------------------------------
// Analisis del contenido del diff
// ---------------------------------------------------------------------------

/** Senales semanticas extraidas de las lineas anadidas/eliminadas. */
export interface DiffSignals {
  /** Simbolos declarados nuevos (funciones, clases, componentes, tipos…). */
  addedSymbols: string[];
  /** Importaciones de modulos nuevas. */
  addedImports: string[];
  /** Dependencias nuevas detectadas en archivos de manifiesto. */
  addedDeps: string[];
  /** Literales de texto nuevos que parecen mensajes/labels de la interfaz. */
  addedTexts: string[];
  /** `true` si se eliminaron lineas de codigo. */
  hasRemovals: boolean;
  /** `true` si el cambio toca mayoritariamente rutas de interfaz. */
  touchesUi: boolean;
}

const SYMBOL_PATTERNS: RegExp[] = [
  // TS/JS: export function / const / class / interface / type / enum.
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  /(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  // Rust: fn / struct / enum / trait.
  /(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
  // Python: def / class.
  /def\s+([A-Za-z_]\w*)\s*\(/,
  /class\s+([A-Za-z_]\w*)/,
];

/** Extrae el contenido de una linea de diff quitando el origen (`+`/`-`). */
function lineBody(content: string): string {
  return content;
}

/** Detecta el nombre de un simbolo declarado en una linea. */
function symbolIn(line: string): string | null {
  for (const pattern of SYMBOL_PATTERNS) {
    const match = pattern.exec(line);
    if (match && match[1]) return match[1];
  }
  return null;
}

/** Extrae el modulo importado de una linea de import. */
function importIn(line: string): string | null {
  // ESM: import ... from 'modulo'  |  import 'modulo'
  const esm = /import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/.exec(line);
  if (esm && esm[1]) return esm[1];
  // Rust: use crate::modulo;
  const rust = /use\s+([A-Za-z_][\w:]*)/.exec(line);
  if (rust && rust[1]) return rust[1];
  return null;
}

/** Extrae un literal de texto "largo" (probable mensaje de interfaz). */
function textLiteralIn(line: string): string | null {
  const match = /['"`]([^'"`]{8,})['"`]/.exec(line);
  if (!match || !match[1]) return null;
  const text = match[1];
  // Descarta rutas, identificadores tecnicos y strings sin espacios.
  if (!/\s/.test(text)) return null;
  if (/^[./@]/.test(text)) return null;
  return text;
}

/** Extrae dependencias nuevas de lineas de package.json / Cargo.toml. */
function depIn(line: string): string | null {
  // package.json: "nombre": "version"
  const json = /"([^"]+)"\s*:\s*"[^"]+"/.exec(line);
  if (json && json[1]) return json[1];
  // Cargo.toml: nombre = "version" | nombre = { ... }
  const toml = /^\s*([a-zA-Z0-9_-]+)\s*=/.exec(line);
  if (toml && toml[1]) return toml[1];
  return null;
}

function isUiPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.endsWith('.tsx') ||
    p.endsWith('.jsx') ||
    p.endsWith('.vue') ||
    p.endsWith('.svelte') ||
    p.includes('/components/') ||
    p.includes('/ui/') ||
    p.endsWith('.css') ||
    p.endsWith('.scss')
  );
}

function isManifestPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.endsWith('package.json') ||
    p.endsWith('cargo.toml') ||
    p.endsWith('pyproject.toml') ||
    p.endsWith('requirements.txt') ||
    p.endsWith('go.mod')
  );
}

/**
 * Recorre los diffs staged y extrae senales semanticas de las lineas
 * anadidas (`+`). Se ignoran cabeceras de hunk y el marcador `+++`.
 */
export function extractSignals(diffs: FileDiff[]): DiffSignals {
  const addedSymbols = new Set<string>();
  const addedImports = new Set<string>();
  const addedDeps = new Set<string>();
  const addedTexts = new Set<string>();
  let hasRemovals = false;
  let touchesUi = false;

  for (const diff of diffs) {
    const manifest = isManifestPath(diff.path);
    if (isUiPath(diff.path)) touchesUi = true;

    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        const body = lineBody(line.content);
        if (line.origin === '-') {
          hasRemovals = true;
          continue;
        }
        if (line.origin !== '+') continue;
        if (body.startsWith('+++')) continue;

        if (manifest) {
          const dep = depIn(body);
          if (dep) addedDeps.add(dep);
          continue;
        }

        const imported = importIn(body);
        if (imported) addedImports.add(imported);

        const symbol = symbolIn(body);
        if (symbol) addedSymbols.add(symbol);

        const text = textLiteralIn(body);
        if (text) addedTexts.add(text);
      }
    }
  }

  return {
    addedSymbols: [...addedSymbols],
    addedImports: [...addedImports],
    addedDeps: [...addedDeps],
    addedTexts: [...addedTexts],
    hasRemovals,
    touchesUi,
  };
}

/** Convierte un nombre de simbolo/identificador en palabras legibles. */
function humanize(name: string): string {
  return name
    // camelCase y PascalCase -> palabras
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Recorta y capitaliza una lista de simbolos para el asunto. */
function joinSymbols(symbols: string[], max = 3): string {
  const names = symbols.slice(0, max).map(humanize).filter(Boolean);
  if (names.length === 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  const rest = symbols.length - max;
  const head = names.slice(0, max - 1).join(', ');
  const tail = names[max - 1];
  return rest > 0 ? `${head}, ${tail} y ${rest} más` : `${head} y ${tail}`;
}

/**
 * Redacta el resumen (primera linea) a partir del contenido real del diff.
 *
 * Prioriza simbolos declarados y dependencias; si no hay senales claras,
 * cae a la descripcion por estado de archivo.
 */
function summarizeContent(
  type: CommitType,
  files: FileStatus[],
  signals: DiffSignals,
): string {
  const hasSignals =
    signals.addedSymbols.length > 0 ||
    signals.addedDeps.length > 0 ||
    signals.addedImports.length > 0;

  if (!hasSignals) return buildSummary(type, files);

  const fragments: string[] = [];

  if (signals.addedSymbols.length > 0) {
    fragments.push(describeSymbols(type, signals.addedSymbols));
  }

  if (signals.addedDeps.length > 0) {
    fragments.push(`incorporar ${joinSymbols(signals.addedDeps, 3)}`);
  }

  // Los imports solo se mencionan si no hay simbolos (evita ruido).
  if (signals.addedSymbols.length === 0 && signals.addedDeps.length === 0) {
    fragments.push(`usar ${joinSymbols(signals.addedImports, 3)}`);
  }

  if (signals.hasRemovals && fragments.length === 1) {
    fragments.push('y limpiar codigo obsoleto');
  }

  return fragments.join(' y ');
}

/** Frase que describe los simbolos segun el tipo de commit. */
function describeSymbols(type: CommitType, symbols: string[]): string {
  const list = joinSymbols(symbols);
  switch (type) {
    case 'feat':
      return `anadir ${list}`;
    case 'fix':
      return `corregir ${list}`;
    case 'refactor':
      return `reorganizar ${list}`;
    case 'perf':
      return `optimizar ${list}`;
    case 'test':
      return `probar ${list}`;
    case 'docs':
      return `documentar ${list}`;
    default:
      return `ajustar ${list}`;
  }
}

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
 * Genera el mensaje completo (asunto + cuerpo).
 *
 * El asunto sigue Conventional Commits: `tipo(scope): resumen`, donde el
 * resumen describe lo que cambia leyendo el diff (`diffs`), no solo que
 * archivos se tocaron. El cuerpo lista los archivos y, cuando aporta,
 * detalles concretos (simbolos, dependencias, textos de interfaz).
 */
export function generateCommitMessage(files: FileStatus[], diffs: FileDiff[] = []): string {
  if (files.length === 0) return '';

  const type = inferType(files);
  const scope = inferScope(files);
  const signals = extractSignals(diffs);
  const summary = summarizeContent(type, files, signals);
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

  const details = buildDetails(signals);
  const body = details.length > 0 ? `${details.join('\n')}\n\n${bullet.join('\n')}` : bullet.join('\n');

  return `${header}\n\n${body}`;
}

/** Lineas opcionales de detalle (simbolos, dependencias) para el cuerpo. */
function buildDetails(signals: DiffSignals): string[] {
  const lines: string[] = [];
  if (signals.addedDeps.length > 0) {
    lines.push(`Dependencias: ${signals.addedDeps.join(', ')}`);
  }
  const extraSymbols = signals.addedSymbols.slice(8);
  if (extraSymbols.length > 0) {
    lines.push(`Nuevos simbolos: ${extraSymbols.map(humanize).join(', ')}`);
  }
  return lines;
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

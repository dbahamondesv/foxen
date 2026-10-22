import { describe, expect, it } from 'vitest';
import { buildSummary, generateCommitMessage, inferScope, inferType } from './commitMessage';
import type { ChangeKind, FileStatus } from './types';

function file(overrides: Partial<FileStatus>): FileStatus {
  return {
    path: 'src/a.ts',
    oldPath: null,
    indexStatus: '',
    worktreeStatus: '',
    staged: true,
    unstaged: false,
    untracked: false,
    ignored: false,
    conflicted: false,
    isBinary: false,
    insertions: 1,
    deletions: 0,
    kind: 'modified',
    ...overrides,
  };
}

function kinded(path: string, kind: ChangeKind): FileStatus {
  return file({ path, kind });
}

describe('inferType', () => {
  it('devuelve chore sin archivos', () => {
    expect(inferType([])).toBe('chore');
  });

  it('detecta feat cuando hay archivos nuevos', () => {
    expect(inferType([kinded('src/nuevo.ts', 'added')])).toBe('feat');
    expect(inferType([kinded('src/otro.ts', 'untracked')])).toBe('feat');
  });

  it('detecta docs y test por la ruta', () => {
    expect(inferType([kinded('README.md', 'modified')])).toBe('docs');
    expect(inferType([kinded('docs/guia.md', 'added')])).toBe('docs');
    expect(inferType([kinded('src/a.test.ts', 'modified')])).toBe('test');
  });

  it('detecta chore cuando todo se elimina', () => {
    expect(inferType([kinded('src/viejo.ts', 'deleted')])).toBe('chore');
  });

  it('detecta fix cuando todo es modificacion', () => {
    expect(
      inferType([kinded('src/a.ts', 'modified'), kinded('src/b.ts', 'modified')]),
    ).toBe('fix');
  });

  it('prioriza feat si conviven nuevas y modificadas', () => {
    expect(
      inferType([kinded('src/a.ts', 'added'), kinded('src/b.ts', 'modified')]),
    ).toBe('feat');
  });
});

describe('inferScope', () => {
  it('usa el ultimo segmento del directorio comun', () => {
    expect(inferScope([kinded('src/components/a.ts', 'modified')])).toBe('components');
  });

  it('null si no comparten directorio', () => {
    expect(
      inferScope([kinded('src/a.ts', 'modified'), kinded('tools/b.ts', 'modified')]),
    ).toBe(null);
  });

  it('null sin archivos', () => {
    expect(inferScope([])).toBe(null);
  });
});

describe('buildSummary', () => {
  it('nombra el archivo cuando hay uno solo', () => {
    expect(buildSummary('feat', [kinded('src/boton.ts', 'added')])).toContain('boton.ts');
  });

  it('resume varias categorias de cambio', () => {
    const summary = buildSummary('feat', [
      kinded('src/a.ts', 'added'),
      kinded('src/b.ts', 'added'),
      kinded('src/c.ts', 'modified'),
    ]);
    expect(summary).toContain('2 archivos');
    expect(summary).toContain('1 archivo');
  });
});

describe('generateCommitMessage', () => {
  it('genera la cabecera Conventional Commits con scope', () => {
    const message = generateCommitMessage([kinded('src/components/a.ts', 'modified')]);
    expect(message.split('\n')[0]).toBe('fix(components): modificar a.ts');
  });

  it('omite el scope si no aplica', () => {
    const message = generateCommitMessage([
      kinded('src/a.ts', 'modified'),
      kinded('tools/b.ts', 'modified'),
    ]);
    expect(message.split('\n')[0]?.startsWith('fix: ')).toBe(true);
  });

  it('incluye un cuerpo con la lista de archivos', () => {
    const message = generateCommitMessage([
      kinded('src/a.ts', 'added'),
      kinded('src/b.ts', 'deleted'),
    ]);
    const lines = message.split('\n');
    expect(lines[1]).toBe('');
    expect(message).toContain('- A src/a.ts');
    expect(message).toContain('- D src/b.ts');
  });

  it('marca renombrados con el path antiguo y estadisticas', () => {
    const message = generateCommitMessage([
      file({ path: 'src/nuevo.ts', oldPath: 'src/viejo.ts', kind: 'renamed', insertions: 2, deletions: 1 }),
    ]);
    expect(message).toContain('(antes src/viejo.ts)');
    expect(message).toContain('[+2 −1]');
  });

  it('devuelve cadena vacia sin archivos', () => {
    expect(generateCommitMessage([])).toBe('');
  });
});

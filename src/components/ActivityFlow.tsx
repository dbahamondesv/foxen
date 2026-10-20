import { useMemo } from 'react';
import { useStore } from '../store/useAppStore';
import { commitKind } from '../lib/format';

/**
 * Visualización dinámica del panel derecho.
 *
 * Representa de forma abstracta el flujo del repositorio: un pipeline temporal
 * entre etapas (working tree → index → ramas → remotos), los nodos de actividad
 * por tipo de commit y las relaciones entre ramas locales/remotas. No usa logos
 * ni marcas: los iconos son símbolos geométricos genéricos.
 */

/** Etapas del flujo técnico del repositorio. */
const STAGES = [
  { id: 'work', label: 'Working tree', glyph: '◇' },
  { id: 'index', label: 'Index', glyph: '◈' },
  { id: 'commit', label: 'Commits', glyph: '●' },
  { id: 'remote', label: 'Remotos', glyph: '◆' },
] as const;

/** Color de acento según el tipo de commit, coherente con el badge del listado. */
const KIND_TONE: Record<string, string> = {
  feature: 'var(--neon-blue)',
  fix: 'var(--neon-magenta)',
  docs: 'var(--neon-purple)',
  chore: 'var(--text-faint)',
  refactor: 'var(--neon-purple)',
  test: 'var(--added)',
  perf: 'var(--warning)',
};

export function ActivityFlow() {
  const status = useStore((s) => s.status);
  const branches = useStore((s) => s.branches);
  const stashes = useStore((s) => s.stashes);
  const graph = useStore((s) => s.graph);
  const remotes = useStore((s) => s.remotes);

  const staged = status?.files.filter((f) => f.staged).length ?? 0;
  const unstaged = status?.files.filter((f) => f.unstaged).length ?? 0;
  const conflicted = status?.conflictedCount ?? 0;

  const locals = branches?.branches.filter((b) => !b.isRemote) ?? [];
  const remoteBranches = branches?.branches.filter((b) => b.isRemote) ?? [];

  /** Distribución de tipos de commit en las primeras 60 filas del grafo. */
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of (graph?.nodes ?? []).slice(0, 60)) {
      const kind = commitKind(node.subject);
      counts.set(kind.kind, (counts.get(kind.kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  const maxCount = kindCounts.reduce((max, [, n]) => Math.max(max, n), 1);

  const stageValues: Record<string, string> = {
    work: String(unstaged),
    index: String(staged),
    commit: String(graph?.nodes.length ?? 0),
    remote: String(remoteBranches.length),
  };

  return (
    <div className="activity-flow">
      <header className="flow-section-head">
        <h3>Flujo de actividad</h3>
        <span className="flow-sub">{graph?.totalReachable ?? 0} commits alcanzables</span>
      </header>

      {/* Pipeline temporal abstracto entre etapas */}
      <div className="pipeline" role="img" aria-label="Pipeline del repositorio">
        {STAGES.map((stage, index) => (
          <div className="pipeline-stage" key={stage.id}>
            <div className="pipeline-node">
              <span className="pipeline-glyph">{stage.glyph}</span>
              <span className="pipeline-count">{stageValues[stage.id]}</span>
            </div>
            <span className="pipeline-label">{stage.label}</span>
            {index < STAGES.length - 1 && <span className="pipeline-connector" aria-hidden />}
          </div>
        ))}
      </div>

      {/* Relaciones de ramas: locales conectadas a su remoto */}
      <section className="flow-block">
        <header className="flow-block-head">
          <span className="flow-block-title">Relaciones</span>
          <span className="flow-block-meta">
            {locals.length} locales · {remoteBranches.length} remotas
          </span>
        </header>
        <ul className="flow-relations">
          {locals.slice(0, 6).map((branch) => {
            const tracking = remoteBranches.find(
              (r) => r.name === `origin/${branch.name}` || r.name.endsWith(`/${branch.name}`),
            );
            return (
              <li key={branch.fullName} className="flow-relation">
                <span className={`flow-dot${branch.isHead ? ' is-head' : ''}`} aria-hidden />
                <span className="flow-branch-name">{branch.name}</span>
                <span className="flow-relation-line" aria-hidden />
                <span className="flow-track" title={tracking?.name ?? 'sin upstream'}>
                  {tracking ? tracking.name.split('/')[0] : '—'}
                </span>
                {branch.ahead > 0 && <span className="badge badge-ahead">↑{branch.ahead}</span>}
                {branch.behind > 0 && <span className="badge badge-behind">↓{branch.behind}</span>}
              </li>
            );
          })}
          {locals.length === 0 && <li className="flow-empty">Sin ramas locales.</li>}
        </ul>
      </section>

      {/* Distribución por tipo de commit (badges tipográficos) */}
      <section className="flow-block">
        <header className="flow-block-head">
          <span className="flow-block-title">Composición reciente</span>
        </header>
        <ul className="flow-composition">
          {kindCounts.map(([kind, count]) => (
            <li key={kind} className="flow-comp-row">
              <span className={`commit-badge kind-${kind}`}>{kindBadge(kind)}</span>
              <span className="flow-comp-bar" aria-hidden>
                <span
                  className="flow-comp-fill"
                  style={{
                    width: `${(count / maxCount) * 100}%`,
                    background: KIND_TONE[kind] ?? 'var(--text-faint)',
                  }}
                />
              </span>
              <span className="flow-comp-count">{count}</span>
            </li>
          ))}
          {kindCounts.length === 0 && <li className="flow-empty">Sin historial.</li>}
        </ul>
      </section>

      {/* Métricas rápidas: contenedores simbólicos de estado */}
      <section className="flow-block">
        <header className="flow-block-head">
          <span className="flow-block-title">Estado del árbol</span>
        </header>
        <div className="flow-metrics">
          <MetricCard label="Stage" value={staged} tone="var(--added)" glyph="◈" />
          <MetricCard label="Sin añadir" value={unstaged} tone="var(--warning)" glyph="◇" />
          <MetricCard label="Conflictos" value={conflicted} tone="var(--deleted)" glyph="⬢" />
          <MetricCard label="Stashes" value={stashes.length} tone="var(--neon-purple)" glyph="▤" />
          <MetricCard label="Remotos" value={remotes?.length ?? 0} tone="var(--neon-blue)" glyph="◆" />
        </div>
      </section>
    </div>
  );
}

/** Etiqueta corta del badge para una categoría, reutilizando el mapeo del listado. */
function kindBadge(kind: string): string {
  switch (kind) {
    case 'feature':
      return 'F';
    case 'fix':
      return 'D';
    case 'docs':
      return 'docs';
    case 'refactor':
      return 'refactor';
    case 'test':
      return 'test';
    case 'perf':
      return 'perf';
    default:
      return 'chore';
  }
}

function MetricCard({
  label,
  value,
  tone,
  glyph,
}: {
  label: string;
  value: number;
  tone: string;
  glyph: string;
}) {
  return (
    <div className="metric-card" style={{ '--tone': tone } as React.CSSProperties}>
      <span className="metric-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import { authorColor, authorInitial, commitKind, laneColor, relativeTime } from '../lib/format';
import type { CommitNode, GraphEdge } from '../lib/types';

const ROW_HEIGHT = 32;
const LANE_WIDTH = 14;
const GRAPH_PAD = 12;

interface Props {
  nodes: CommitNode[];
  edges: GraphEdge[];
  laneCount: number;
  truncated: boolean;
  totalReachable: number;
}

export function CommitGraphView({ nodes, edges, laneCount, truncated, totalReachable }: Props) {
  const selectedOid = useStore((s) => s.selectedOid);
  const selectCommit = useStore((s) => s.selectCommit);
  const highlight = useStore((s) => s.graphHighlight);
  const branches = useStore((s) => s.branches);
  const notify = useStore((s) => s.notify);

  const [hover, setHover] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Al seleccionar desde otro panel, el commit debe quedar a la vista.
  useEffect(() => {
    if (!selectedOid || !scrollRef.current) return;
    const node = nodes.find((n) => n.oid === selectedOid);
    if (!node) return;
    const scroller = scrollRef.current.closest('.main');
    if (!scroller) return;
    const top = node.row * ROW_HEIGHT;
    const visibleTop = scroller.scrollTop;
    const visibleBottom = scroller.scrollTop + scroller.clientHeight;
    if (top < visibleTop || top + ROW_HEIGHT > visibleBottom) {
      scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2);
    }
  }, [selectedOid, nodes]);

  const laneX = useCallback((lane: number) => GRAPH_PAD + lane * LANE_WIDTH, []);

  /** Ancho de la columna del grafo SVG. */
  const graphWidth = GRAPH_PAD * 2 + Math.max(laneCount, 1) * LANE_WIDTH;

  /** Solo la selección atenúa el resto para mantener la legibilidad. */
  const activeLane = useMemo(() => {
    if (!selectedOid) return null;
    return nodes.find((n) => n.oid === selectedOid)?.lane ?? null;
  }, [selectedOid, nodes]);

  const edgeOpacity = (edge: GraphEdge) =>
    activeLane === null ? 1.0 : edge.fromLane === activeLane || edge.toLane === activeLane ? 1 : 0.28;

  /** Clases de estado de la fila */
  const rowClass = (node: CommitNode) => {
    const classes = ['graph-row'];
    if (node.oid === selectedOid) classes.push('is-selected');
    else if (node.oid === hover) classes.push('is-hover');
    if (node.isHead) classes.push('is-head');
    if (highlight && node.subject.toLowerCase().includes(highlight.toLowerCase())) {
      classes.push('is-highlight');
    }
    return classes.join(' ');
  };

  /** Banda que resalta el hover/selección en el SVG a la vez */
  const bandClass = (node: CommitNode) => {
    const classes = ['graph-band'];
    if (node.oid === selectedOid) classes.push('is-selected');
    else if (node.oid === hover) classes.push('is-hover');
    return classes.join(' ');
  };

  /**
   * Traza la arista de un commit a su padre siguiendo la estética geométrica limpia
   * de GitFiend (líneas verticales en el mismo carril y diagonales nítidas al bifurcar
   * o fusionar ramas).
   */
  const edgePath = (edge: GraphEdge) => {
    const x1 = laneX(edge.fromLane);
    const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = laneX(edge.toLane);
    const y2 = edge.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

    // Mismo carril: línea vertical pura continua
    if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;

    // Filas contiguas: diagonal directa limpia
    if (edge.toRow === edge.fromRow + 1) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }

    // Múltiples filas entre origen y destino:
    // Si es arista de merge (desde el commit merge hacia la rama que se integra):
    // Sale en diagonal hacia el carril de la rama en el primer tramo y desciende por él.
    if (edge.isMergeEdge) {
      const diagY = y1 + ROW_HEIGHT;
      return `M ${x1} ${y1} L ${x2} ${diagY} V ${y2}`;
    }

    // Si es bifurcación de rama normal:
    // Desciende verticalmente por su carril y converge diagonalmente hacia el nodo padre en la última fila.
    const diagY = y2 - ROW_HEIGHT;
    return `M ${x1} ${y1} V ${diagY} L ${x2} ${y2}`;
  };

  const totalHeight = nodes.length * ROW_HEIGHT;
  const separatorPath = nodes
    .map((node) => `M 0 ${node.row * ROW_HEIGHT + ROW_HEIGHT - 0.5} H ${graphWidth}`)
    .join(' ');
  const selectedNode = selectedOid ? nodes.find((n) => n.oid === selectedOid) : undefined;

  return (
    <div className="graph-view" ref={scrollRef}>
      {nodes.length === 0 ? (
        <p className="empty">Sin commits que mostrar.</p>
      ) : (
        <>
          <div className="graph-body">
            <svg
              className="graph-svg"
              width={graphWidth}
              height={totalHeight}
              role="img"
              aria-label="Grafo de commits"
            >
              {/* Bandas de fila sincronizadas con el listado */}
              {nodes.map((node) => (
                <rect
                  key={`band-${node.oid}`}
                  className={bandClass(node)}
                  x={0}
                  y={node.row * ROW_HEIGHT}
                  width={graphWidth}
                  height={ROW_HEIGHT}
                />
              ))}

              {/* Separadores sutiles de fila */}
              <path className="graph-sep" d={separatorPath} fill="none" />

              {/* Halo sutil de fondo para cruces limpios */}
              {[false, true].map((isMerge) =>
                edges
                  .filter((e) => e.isMergeEdge === isMerge)
                  .map((edge, i) => (
                    <path
                      key={`${isMerge ? 'm' : 'e'}h${i}`}
                      d={edgePath(edge)}
                      fill="none"
                      stroke="var(--bg)"
                      strokeWidth={2.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.35}
                      pointerEvents="none"
                    />
                  )),
              )}

              {/* Aristas coloreadas: esbeltas (1.8px) y nítidas */}
              {[false, true].map((isMerge) =>
                edges
                  .filter((e) => e.isMergeEdge === isMerge)
                  .map((edge, i) => (
                    <path
                      key={`${isMerge ? 'm' : 'e'}${i}`}
                      d={edgePath(edge)}
                      fill="none"
                      stroke={laneColor(edge.isMergeEdge ? edge.toLane : edge.fromLane)}
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={edgeOpacity(edge)}
                    />
                  )),
              )}

              {/* Nodos circulares sólidos estilo GitFiend */}
              {nodes.map((node) => {
                const cx = laneX(node.lane);
                const cy = node.row * ROW_HEIGHT + ROW_HEIGHT / 2;
                const color = laneColor(node.lane);
                const isSelected = node.oid === selectedOid;
                const isHead = node.isHead;
                const r = isHead ? 4.6 : 3.8;

                return (
                  <g
                    key={node.oid}
                    opacity={activeLane === null || node.lane === activeLane ? 1 : 0.28}
                  >
                    {/* Halo suave para commit seleccionado */}
                    {isSelected && (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={r + 3.6}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.6}
                        opacity={0.65}
                      />
                    )}
                    {/* Anillo exterior distintivo para HEAD */}
                    {isHead && !isSelected && (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={r + 2.6}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.3}
                        opacity={0.85}
                      />
                    )}
                    {/* Nodo circular sólido */}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill={color}
                      stroke="var(--bg)"
                      strokeWidth={1.2}
                    />
                  </g>
                );
              })}

              {/* Borde sutil entre el grafo y el listado de commits */}
              <line
                className="graph-split"
                x1={graphWidth - 0.5}
                y1={0}
                x2={graphWidth - 0.5}
                y2={totalHeight}
              />

              {/* Indicador de selección lateral */}
              {selectedNode && (
                <rect
                  className="graph-mark"
                  x={0}
                  y={selectedNode.row * ROW_HEIGHT}
                  width={3}
                  height={ROW_HEIGHT}
                />
              )}
            </svg>

            {/* Lista de commits fluida y limpia */}
            <div className="graph-rows" style={{ height: totalHeight }}>
              {nodes.map((node) => {
                const kind = commitKind(node.subject);
                return (
                <div
                  key={node.oid}
                  className={rowClass(node)}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => void selectCommit(node.oid === selectedOid ? null : node.oid)}
                  onMouseEnter={() => setHover(node.oid)}
                  onMouseLeave={() => setHover(null)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void selectCommit(node.oid === selectedOid ? null : node.oid);
                    }
                  }}
                >
                  {/* Pastillas de ramas y tags estilo GitFiend */}
                  {node.labels.length > 0 && (
                    <div className="graph-labels-wrap">
                      {node.labels.map((label) => {
                        const branchInfo = branches?.branches.find((b) => b.name === label.name);
                        const aheadCount = branchInfo?.ahead ?? 0;
                        const isTag = label.kind === 'tag';
                        const isHead = label.isHead;
                        return (
                          <span
                            key={label.fullName}
                            className={`ref-pill ref-${label.kind}${isHead ? ' is-head' : ''}`}
                            title={label.fullName}
                          >
                            {isHead && <span className="ref-check">✓</span>}
                            {isTag && <span className="ref-tag-icon">🏷️</span>}
                            <span className="ref-name">{label.name}</span>
                            {aheadCount > 0 && <span className="ref-ahead">+{aheadCount}</span>}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Badge tipografico del tipo de commit (F, D, chore…) */}
                  <span
                    className={`commit-badge kind-${kind.kind}`}
                    title={kind.label}
                  >
                    {kind.badge}
                  </span>

                  {/* Avatar con inicial y color armónico del autor */}
                  <span
                    className="graph-avatar"
                    style={{ backgroundColor: authorColor(node.authorName) }}
                    title={`${node.authorName} <${node.authorEmail}>`}
                  >
                    {authorInitial(node.authorName)}
                  </span>

                  {/* Asunto del commit */}
                  <span className="graph-subject" title={node.subject}>
                    {node.subject}
                  </span>

                  {/* Antigüedad relativa ("hace 3 meses") */}
                  <span className="graph-time" title={node.authorTimeIso}>
                    {relativeTime(node.authorTime)}
                  </span>

                  {/* Short SHA clicable para copiar */}
                  <span
                    className="graph-shortsha"
                    title={`SHA: ${node.oid} (clic para copiar)`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void navigator.clipboard.writeText(node.oid);
                      notify('info', `SHA ${node.shortOid} copiado al portapapeles`);
                    }}
                  >
                    {node.shortOid}
                  </span>
                </div>
                );
              })}
            </div>
          </div>

          {truncated && (
            <p className="graph-truncated">
              Mostrando {nodes.length} de {totalReachable} commits alcanzables.
            </p>
          )}
        </>
      )}
    </div>
  );
}

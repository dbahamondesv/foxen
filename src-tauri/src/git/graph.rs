//! Construcción del grafo de commits.
//!
//! Algoritmo en tres fases, equivalente al de `git log --graph --topo-order`:
//!
//! 1. **Recolección**: se camina desde las raices (refs) recolectando commits
//!    alcanzables, con límite de memoria.
//! 2. **Orden topológico**: Kahn con prioridad por timestamp descendente. Esto
//!    garantiza que un padre siempre aparece *después* que su hijo, incluso con
//!    relojes desincronizados.
//! 3. **Asignación de lanes y aristas**: simulación de "slots" (columnas),
//!    igual que GitKraken: el primer padre reutiliza la columna del hijo y los
//!    padres de merge buscan la columna libre más cercana.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};

use git2::{Oid, Repository};

use crate::error::AppResult;
use crate::git::util::{iso8601, short_oid};
use crate::types::{CommitGraph, CommitNode, GraphEdge, GraphQuery, RefKind, RefLabel};

/// Limite duro de commits recolectados, para evitar agotar memoria.
const MAX_COMMITS: usize = 200_000;

/// Commit completo con todos los datos necesarios para dibujar el grafo.
struct RawCommit {
    #[allow(dead_code)]
    oid: Oid,
    parents: Vec<Oid>,
    subject: String,
    body: Option<String>,
    author_name: String,
    author_email: String,
    author_time: i64,
    commit_time: i64,
    merge: bool,
}

/// Clave de ordenacion para el heap de Kahn: timestamp descendente.
#[derive(PartialEq, Eq)]
struct HeapItem {
    time: i64,
    /// Desempate estable por oid para obtener un orden determinista.
    oid: String,
}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.time
            .cmp(&other.time)
            .then_with(|| self.oid.cmp(&other.oid))
    }
}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

pub fn build_graph(repo: &Repository, query: &GraphQuery) -> AppResult<CommitGraph> {
    let limit = query.limit.clamp(1, MAX_COMMITS);
    let labels = collect_labels(repo)?;

    let roots = resolve_roots(repo, query, &labels)?;
    if roots.is_empty() {
        return Ok(CommitGraph {
            nodes: Vec::new(),
            edges: Vec::new(),
            lane_count: 0,
            truncated: false,
            total_reachable: 0,
        });
    }

    let (commits, truncated, total) = collect_commits(repo, &roots, limit)?;
    let order = topological_order(&commits);

    let head_oid = repo.head().ok().and_then(|h| h.target());

    Ok(assemble(
        &commits,
        &order,
        &labels,
        head_oid,
        truncated,
        total,
    ))
}

// ---------------------------------------------------------------------------
// Fase 1: recoleccion
// ---------------------------------------------------------------------------

fn collect_commits(
    repo: &Repository,
    roots: &[Oid],
    limit: usize,
) -> AppResult<(HashMap<Oid, RawCommit>, bool, usize)> {
    let mut seen: HashSet<Oid> = HashSet::new();
    let mut queue: VecDeque<Oid> = VecDeque::new();
    for root in roots {
        if seen.insert(*root) {
            queue.push_back(*root);
        }
    }

    // Primera pasada: descubrir el subgrafo alcanzable acotado por `limit`.
    while let Some(oid) = queue.pop_front() {
        if seen.len() >= limit {
            break;
        }
        if let Ok(commit) = repo.find_commit(oid) {
            for parent in commit.parent_ids() {
                if seen.insert(parent) {
                    queue.push_back(parent);
                }
            }
        }
    }
    let total = seen.len();
    let truncated = total >= limit;

    // Segunda pasada: cargar los datos completos de cada commit.
    let mut commits = HashMap::with_capacity(seen.len());
    for oid in seen {
        if let Some(raw) = load_commit(repo, oid) {
            commits.insert(oid, raw);
        }
    }

    Ok((commits, truncated, total))
}

fn load_commit(repo: &Repository, oid: Oid) -> Option<RawCommit> {
    let commit = repo.find_commit(oid).ok()?;
    let author = commit.author();
    let subject = commit.summary().unwrap_or("").to_string();
    let body = commit.body().map(|b| b.to_string()).filter(|b| !b.trim().is_empty());
    let parents: Vec<Oid> = commit.parent_ids().collect();
    let merge = parents.len() > 1;

    Some(RawCommit {
        oid,
        parents,
        subject,
        body,
        author_name: author.name().unwrap_or("Desconocido").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        author_time: author.when().seconds(),
        commit_time: commit.time().seconds(),
        merge,
    })
}

// ---------------------------------------------------------------------------
// Fase 2: orden topologico (Kahn con prioridad por tiempo)
// ---------------------------------------------------------------------------

fn topological_order(commits: &HashMap<Oid, RawCommit>) -> Vec<Oid> {
    // Grado de entrada = numero de hijos dentro del subgrafo.
    let mut in_degree: HashMap<Oid, usize> = HashMap::with_capacity(commits.len());
    for oid in commits.keys() {
        in_degree.entry(*oid).or_insert(0);
    }
    for commit in commits.values() {
        for parent in &commit.parents {
            if commits.contains_key(parent) {
                *in_degree.entry(*parent).or_insert(0) += 1;
            }
        }
    }

    let mut heap: BinaryHeap<Reverse<HeapItem>> = BinaryHeap::new();
    for (oid, degree) in &in_degree {
        if *degree == 0 {
            if let Some(c) = commits.get(oid) {
                heap.push(Reverse(HeapItem {
                    time: c.author_time,
                    oid: oid.to_string(),
                }));
            }
        }
    }

    let mut order = Vec::with_capacity(commits.len());
    let mut emitted: HashSet<Oid> = HashSet::with_capacity(commits.len());

    while let Some(Reverse(item)) = heap.pop() {
        let Ok(oid) = Oid::from_str(&item.oid) else {
            continue;
        };
        if !emitted.insert(oid) {
            continue;
        }
        order.push(oid);

        if let Some(commit) = commits.get(&oid) {
            for parent in &commit.parents {
                if let Some(degree) = in_degree.get_mut(parent) {
                    *degree = degree.saturating_sub(1);
                    if *degree == 0 {
                        if let Some(p) = commits.get(parent) {
                            heap.push(Reverse(HeapItem {
                                time: p.author_time,
                                oid: parent.to_string(),
                            }));
                        }
                    }
                }
            }
        }
    }

    // Red de seguridad: ciclos patologicos (historial corrupto).
    if order.len() < commits.len() {
        let mut remaining: Vec<(i64, Oid)> = commits
            .keys()
            .filter(|oid| !emitted.contains(*oid))
            .map(|oid| (commits[oid].author_time, *oid))
            .collect();
        remaining.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_string().cmp(&b.1.to_string())));
        order.extend(remaining.into_iter().map(|(_, oid)| oid));
    }

    order
}

// ---------------------------------------------------------------------------
// Fase 3: lanes y aristas
// ---------------------------------------------------------------------------

fn assemble(
    commits: &HashMap<Oid, RawCommit>,
    order: &[Oid],
    labels: &HashMap<Oid, Vec<RefLabel>>,
    head_oid: Option<Oid>,
    truncated: bool,
    total_reachable: usize,
) -> CommitGraph {
    // Columnas activas. `None` = hueco; `Some(oid)` = commit en curso en esa columna.
    let mut slots: Vec<Option<Oid>> = Vec::new();
    let mut lane_of: HashMap<Oid, usize> = HashMap::with_capacity(order.len());
    let mut row_of: HashMap<Oid, usize> = HashMap::with_capacity(order.len());
    // Aristas pendientes: (commit, padre, lane_origen, lane_destino).
    let mut pending: Vec<(Oid, Oid, usize, usize, bool)> = Vec::new();
    let mut lane_count = 0usize;

    for (row, oid) in order.iter().enumerate() {
        let Some(commit) = commits.get(oid) else {
            continue;
        };

        // Localizar la columna del commit. Debe estar en `slots`, salvo que ya
        // se haya colocado antes (padre compartido alcanzado por otra rama).
        let lane = match slots.iter().position(|s| *s == Some(*oid)) {
            Some(lane) => {
                slots[lane] = None;
                lane
            }
            None => lane_of.get(oid).copied().unwrap_or_else(|| {
                let lane = slots.len();
                slots.push(None);
                lane
            }),
        };

        lane_of.insert(*oid, lane);
        row_of.insert(*oid, row);
        lane_count = lane_count.max(lane + 1);

        // Asignar columna a cada padre visible.
        for (index, parent) in commit.parents.iter().enumerate() {
            if !commits.contains_key(parent) {
                continue;
            }
            let is_merge_edge = index > 0;

            let target = if let Some(existing) = lane_of.get(parent).copied() {
                // El padre ya fue colocado: reutilizamos su columna y
                // reintroducimos el oid para que siga dibujandose la linea.
                if slots.len() <= existing {
                    slots.resize(existing + 1, None);
                }
                slots[existing] = Some(*parent);
                existing
            } else if index == 0 {
                // Primer padre: hereda la columna del hijo (ya liberada).
                lane
            } else {
                let free = find_free_slot(&slots, lane);
                if slots.len() <= free {
                    slots.resize(free + 1, None);
                }
                lane_count = lane_count.max(free + 1);
                free
            };

            pending.push((*oid, *parent, lane, target, is_merge_edge));
        }
    }

    let mut nodes = Vec::with_capacity(order.len());
    for (row, oid) in order.iter().enumerate() {
        let Some(commit) = commits.get(oid) else {
            continue;
        };
        let commit_labels = labels.get(oid).cloned().unwrap_or_default();
        let is_head = head_oid == Some(*oid);
        nodes.push(CommitNode {
            oid: oid.to_string(),
            short_oid: short_oid(oid),
            row,
            lane: lane_of.get(oid).copied().unwrap_or(0),
            parents: commit.parents.iter().map(|p| p.to_string()).collect(),
            subject: commit.subject.clone(),
            body: commit.body.clone(),
            author_name: commit.author_name.clone(),
            author_email: commit.author_email.clone(),
            author_time: commit.author_time,
            author_time_iso: iso8601(commit.author_time),
            commit_time_iso: iso8601(commit.commit_time),
            labels: commit_labels,
            is_merge: commit.merge,
            is_head,
            is_root: commit.parents.is_empty(),
        });
    }

    let mut edges = Vec::with_capacity(pending.len());
    for (from, to, from_lane, to_lane, is_merge_edge) in pending {
        let (Some(&from_row), Some(&to_row)) = (row_of.get(&from), row_of.get(&to)) else {
            continue;
        };
        if from_row >= to_row {
            continue;
        }
        edges.push(GraphEdge {
            from_row,
            from_lane,
            to_row,
            to_lane,
            is_merge_edge,
        });
    }

    CommitGraph {
        nodes,
        edges,
        lane_count,
        truncated,
        total_reachable,
    }
}

/// Busca la columna libre mas cercana a `origin`, prefiriendo la derecha.
/// Asi es como GitKraken coloca las ramas de merge: hacia afuera desde el padre.
fn find_free_slot(slots: &[Option<Oid>], origin: usize) -> usize {
    let mut right = origin + 1;
    while right < slots.len() {
        if slots[right].is_none() {
            return right;
        }
        right += 1;
    }
    let mut left = origin;
    while left > 0 {
        left -= 1;
        if slots[left].is_none() {
            return left;
        }
    }
    slots.len()
}

// ---------------------------------------------------------------------------
// Raices y etiquetas
// ---------------------------------------------------------------------------

fn collect_labels(repo: &Repository) -> AppResult<HashMap<Oid, Vec<RefLabel>>> {
    let mut labels: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
    let head_full = repo.head().ok().and_then(|h| h.name().map(|n| n.to_string()));
    let head_target = repo.head().ok().and_then(|h| h.target());

    // `full` es SIEMPRE el nombre completo de la referencia. Antes se pasaba el
    // nombre corto ("main") y se comparaba contra `repo.head().name()`, que es
    // "refs/heads/main": la comparacion nunca cuadra y `is_head` salia siempre
    // false, dejando la rama actual sin marcar en el grafo.
    let push = |full: String, kind: RefKind, oid: Oid, labels: &mut HashMap<Oid, Vec<RefLabel>>| {
        let is_head = head_full.as_deref() == Some(full.as_str()) || (head_target == Some(oid) && head_full.is_none());
        let entry = labels.entry(oid).or_default();
        if !entry.iter().any(|l| l.full_name == full) {
            entry.push(RefLabel {
                name: crate::git::util::shorten_ref(&full),
                full_name: full,
                kind,
                is_head,
                is_detached: head_full.is_none() && head_target == Some(oid),
            });
        }
    };

    // `Branch::name` devuelve `Result<Option<&str>>` en git2 0.20.
    let branches = repo.branches(Some(git2::BranchType::Local))?;
    for (branch, _) in branches.flatten() {
        let name = branch.name().ok().flatten().map(|n| n.to_string());
        let oid = branch.get().target();
        if let (Some(name), Some(oid)) = (name, oid) {
            push(format!("refs/heads/{name}"), RefKind::Branch, oid, &mut labels);
        }
    }

    let remotes = repo.branches(Some(git2::BranchType::Remote))?;
    for (branch, _) in remotes.flatten() {
        let name = branch.name().ok().flatten().map(|n| n.to_string());
        let oid = branch.get().target();
        if let (Some(name), Some(oid)) = (name, oid) {
            push(
                format!("refs/remotes/{name}"),
                RefKind::RemoteBranch,
                oid,
                &mut labels,
            );
        }
    }

    let tags = repo.references_glob("refs/tags/*")?;
    for reference in tags.flatten() {
        if let Some(name) = reference.name() {
            // Los tags anotados apuntan a un tag object; resolver al commit.
            let oid = reference
                .peel_to_commit()
                .ok()
                .map(|c| c.id())
                .or_else(|| reference.target());
            if let Some(oid) = oid {
                push(name.to_string(), RefKind::Tag, oid, &mut labels);
            }
        }
    }

    Ok(labels)
}

fn resolve_roots(
    repo: &Repository,
    query: &GraphQuery,
    labels: &HashMap<Oid, Vec<RefLabel>>,
) -> AppResult<Vec<Oid>> {
    let mut roots: Vec<Oid> = Vec::new();
    let push_oid = |oid: Oid, roots: &mut Vec<Oid>| {
        if !roots.contains(&oid) {
            roots.push(oid);
        }
    };

    // Raices explicitas de la consulta.
    for head in &query.heads {
        let candidates = [
            format!("refs/heads/{head}"),
            format!("refs/remotes/{head}"),
            format!("refs/tags/{head}"),
            head.clone(),
        ];
        let mut found = false;
        for candidate in candidates {
            if let Ok(object) = repo.revparse_single(&candidate) {
                if let Ok(commit) = object.peel_to_commit() {
                    push_oid(commit.id(), &mut roots);
                    found = true;
                    break;
                }
            }
        }
        if !found {
            if let Ok(oid) = crate::git::util::oid_from_str(head) {
                if repo.find_commit(oid).is_ok() {
                    push_oid(oid, &mut roots);
                }
            }
        }
    }

    if roots.is_empty() {
        if query.current_only {
            if let Some(head) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
                push_oid(head.id(), &mut roots);
            }
        } else {
            // Todos los refs decorados como grafo inicial.
            for oid in labels.keys() {
                push_oid(*oid, &mut roots);
            }
        }
    }

    // Anadir HEAD para que la rama actual siempre sea visible.
    if let Some(head) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        push_oid(head.id(), &mut roots);
    }

    Ok(roots)
}
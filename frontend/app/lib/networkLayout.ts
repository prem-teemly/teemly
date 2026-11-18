// Layout of the referral network (pure: no React, no DOM, so it can be tested on its own).
//
// A radial tree: the owner in the middle, people known directly on the first ring, the people they
// introduced on the next, and so on. Each person gets a share of the circle that follows how many
// people sit under them. Rings grow with the number of people on them (never crowded), and a crowded
// ring alternates between two radii so names do not sit on each other. Someone who introduced many
// people shows them as one "+N" bubble until opened. The canvas grows with the network; the view
// zooms and pans over it.

import type { NetNode } from "./network";

export const GROUP_AT = 8; // more introductions than this: shown as a "+N" bubble until opened
const RING_GAP = 120; // between rings
const FIRST_RING = 150;
const SLOT = 64; // room along a ring for one circle and its name
const STAGGER = 74; // second radius of a crowded ring (a circle, its name and a gap)

export type Placed = { id: string; x: number; y: number; r: number; parent: string | null; depth: number; group?: { of: string; count: number; ids: string[] } };
export type Layout = { nodes: Placed[]; byId: Map<string, Placed>; width: number; height: number; cx: number; cy: number };

export const radiusOf = (n: Pick<NetNode, "introduced">) => 13 + Math.min(13, n.introduced * 2.2);
export const groupId = (parent: string) => `group:${parent}`;

/**
 * Place `nodes` (already filtered). `open`: people whose introductions are shown one by one even when
 * there are many; `keep`: people that must be visible (selected, searched, on a path).
 */
export function layoutNetwork(nodes: NetNode[], { open = new Set<string>(), keep = new Set<string>() }: { open?: Set<string>; keep?: Set<string> } = {}): Layout {
  const ids = new Set(nodes.map((n) => n.id));
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = (n: NetNode) => (n.introduced_by && ids.has(n.introduced_by) && n.introduced_by !== n.id ? n.introduced_by : null);
  const kids = new Map<string | null, NetNode[]>();
  for (const n of nodes) kids.set(parentOf(n), [...(kids.get(parentOf(n)) ?? []), n]);

  // People who must stay visible keep their introducers open too.
  const mustOpen = new Set(open);
  for (const id of keep) {
    let p = byNode.get(id);
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      const up = parentOf(p);
      if (up) mustOpen.add(up);
      p = up ? byNode.get(up) : undefined;
    }
  }

  // The tree as drawn: children, or one "+N" bubble for a big group that is not open.
  type T = { id: string; parent: string | null; r: number; children: T[]; group?: Placed["group"] };
  const seen = new Set<string>();
  const build = (id: string | null, parent: string | null): T[] => {
    const ch = (kids.get(id) ?? []).filter((c) => !seen.has(c.id));
    for (const c of ch) seen.add(c.id);
    if (id !== null && ch.length > GROUP_AT && !mustOpen.has(id)) {
      // Keep the ones that introduced others (they lead somewhere); bubble the rest.
      const lead = ch.filter((c) => (kids.get(c.id) ?? []).length > 0);
      const rest = ch.filter((c) => !lead.includes(c));
      const out: T[] = lead.map((c) => ({ id: c.id, parent, r: radiusOf(c), children: build(c.id, c.id) }));
      if (rest.length) out.push({ id: groupId(id), parent, r: 16 + Math.min(10, rest.length), children: [], group: { of: id, count: rest.length, ids: rest.map((c) => c.id) } });
      return out;
    }
    return ch
      .sort((a, b) => b.introduced - a.introduced || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, parent, r: radiusOf(c), children: build(c.id, c.id) }));
  };
  const roots = build(null, null);

  // Leaves under each drawn node: its share of the circle.
  const leaves = new Map<string, number>();
  const count = (t: T): number => {
    const v = t.children.length ? t.children.reduce((s, c) => s + count(c), 0) : t.group ? Math.min(3, 1 + t.group.count / 6) : 1;
    leaves.set(t.id, v);
    return v;
  };
  roots.forEach(count);

  // 1) Angles: each drawn node in the middle of its share.
  type A = { t: T; angle: number; depth: number };
  const angled: A[] = [];
  const angles = (ts: T[], a0: number, a1: number, d: number) => {
    const total = ts.reduce((s, t) => s + (leaves.get(t.id) ?? 1), 0) || 1;
    let a = a0;
    for (const t of ts) {
      const span = ((a1 - a0) * (leaves.get(t.id) ?? 1)) / total;
      angled.push({ t, angle: a + span / 2, depth: d });
      angles(t.children, a, a + span, d + 1);
      a += span;
    }
  };
  angles(roots, -Math.PI / 2, (3 * Math.PI) / 2, 1);

  // 2) Rings: wide enough that the two closest neighbours on a ring do not touch. A crowded ring
  //    alternates between two radii (neighbours then sit apart in depth), so each radius needs half.
  const depths = Math.max(0, ...angled.map((a) => a.depth));
  const ringR: number[] = [0];
  const staggered: boolean[] = [false];
  const parity = new Map<string, number>();
  for (let d = 1; d <= depths; d++) {
    const on = angled.filter((a) => a.depth === d).sort((x, y) => x.angle - y.angle);
    on.forEach((a, i) => parity.set(a.t.id, i % 2));
    let gap = 2 * Math.PI;
    for (let i = 0; i < on.length && on.length > 1; i++) {
      const next = i + 1 < on.length ? on[i + 1].angle : on[0].angle + 2 * Math.PI;
      gap = Math.min(gap, next - on[i].angle);
    }
    const base = d === 1 ? FIRST_RING : ringR[d - 1] + RING_GAP + (staggered[d - 1] ? STAGGER : 0);
    const needed = on.length > 1 ? SLOT / gap : 0;
    const stagger = on.length > 3 && needed > base * 1.2;
    ringR[d] = Math.max(base, stagger ? needed / 2 : needed);
    staggered[d] = stagger;
  }

  // 3) Positions.
  const placed: Placed[] = angled.map(({ t, angle, depth: d }) => {
    const r = ringR[d] + (staggered[d] && parity.get(t.id) === 1 ? STAGGER : 0);
    return { id: t.id, x: r * Math.cos(angle), y: r * Math.sin(angle), r: t.r, parent: t.parent, depth: d, group: t.group };
  });

  // Canvas: everything plus room for names, the owner at the centre.
  const extent = Math.max(260, ...placed.map((p) => Math.hypot(p.x, p.y) + p.r + 40));
  const size = extent * 2;
  for (const p of placed) {
    p.x += extent;
    p.y += extent;
  }
  return { nodes: placed, byId: new Map(placed.map((p) => [p.id, p])), width: size, height: size, cx: extent, cy: extent };
}

export const LABEL_PX = 11; // names stay this size on screen at any zoom
const CHAR_PX = 6.3;
const MAX_CHARS = 14;
export const labelText = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s);

/**
 * Which names to show at a zoom (`scale` = screen pixels per canvas unit) so that no two overlap:
 * the most important first (`priority`, higher first), then any that still fit.
 */
export function pickLabels(placed: Placed[], textOf: (p: Placed) => string, scale: number, priority: (p: Placed) => number): Set<string> {
  const shown = new Set<string>();
  const cell = 120 / scale; // bucket grid (canvas units) for quick overlap checks
  const grid = new Map<string, { x0: number; x1: number; y0: number; y1: number }[]>();
  const boxOf = (p: Placed) => {
    const w = (labelText(textOf(p)).length * CHAR_PX + 6) / scale;
    const top = p.y + p.r + 2 / scale;
    return { x0: p.x - w / 2, x1: p.x + w / 2, y0: top, y1: top + (LABEL_PX + 4) / scale };
  };
  const keys = (b: { x0: number; x1: number; y0: number; y1: number }) => {
    const out: string[] = [];
    for (let gx = Math.floor(b.x0 / cell); gx <= Math.floor(b.x1 / cell); gx++) for (let gy = Math.floor(b.y0 / cell); gy <= Math.floor(b.y1 / cell); gy++) out.push(`${gx}:${gy}`);
    return out;
  };
  for (const p of [...placed].sort((a, b) => priority(b) - priority(a))) {
    const b = boxOf(p);
    const ks = keys(b);
    const hit = ks.some((k) => (grid.get(k) ?? []).some((o) => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1));
    if (hit) continue;
    shown.add(p.id);
    for (const k of ks) grid.set(k, [...(grid.get(k) ?? []), b]);
  }
  return shown;
}

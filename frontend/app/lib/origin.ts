"use client";

import { useSearchParams } from "next/navigation";
import { useDepartments } from "./departments";

// Where a person (or a call) was opened from, so the breadcrumb and "back" lead there instead of
// always to People. Links from the Departments panel add ?from=departments; links from one
// department's page add ?from=dept:<slug>. Anything else (or nothing) means People.

export type Crumb = { label: string; href: string };
// "person": an opportunity opened from its person's page or one of their calls (the opportunity page
// then leads back to that person).
export type From = "departments" | "panel" | "today" | "person" | "network" | `dept:${string}` | null;

/** Only the known forms are accepted (the value comes from the URL). */
export function parseFrom(raw: string | null | undefined): From {
  if (raw === "departments" || raw === "panel" || raw === "today" || raw === "person" || raw === "network") return raw;
  if (raw && /^dept:[a-z0-9-]{1,60}$/.test(raw)) return raw as `dept:${string}`;
  return null;
}

/** The sidebar item to highlight for an origin ("people" when there is none). */
export const sidebarFor = (from: From): string => (from === "panel" ? "opportunity-panel" : from === "network" ? "network-map" : from === "person" || !from ? "people" : from);

/** Add ?from=… to a link (kept as it is when there is no origin). */
export function withFrom(href: string, from: From): string {
  if (!from) return href;
  return `${href}${href.includes("?") ? "&" : "?"}from=${encodeURIComponent(from)}`;
}

/** The origin of the current page and the breadcrumb trail that leads back to it. */
export function useOrigin(): { from: From; crumbs: Crumb[] } {
  const params = useSearchParams();
  const from = parseFrom(params.get("from"));
  const { departments } = useDepartments();
  if (from === "departments") return { from, crumbs: [{ label: "Departments", href: "/departments" }] };
  if (from === "panel") return { from, crumbs: [{ label: "Opportunity panel", href: "/opportunity-panel" }] };
  if (from === "today") return { from, crumbs: [{ label: "Today", href: "/today" }] };
  if (from === "person") return { from, crumbs: [{ label: "People", href: "/people" }] };
  if (from === "network") return { from, crumbs: [{ label: "Network map", href: "/network-map" }] };
  if (from?.startsWith("dept:")) {
    const slug = from.slice(5);
    const d = departments.find((x) => x.slug === slug);
    return {
      from,
      crumbs: [
        { label: "Departments", href: "/departments" },
        { label: d?.name ?? slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()), href: `/departments/${slug}` },
      ],
    };
  }
  return { from: null, crumbs: [{ label: "People", href: "/people" }] };
}

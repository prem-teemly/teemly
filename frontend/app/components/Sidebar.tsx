import Link from "next/link";
import { SidebarUser } from "./AuthGate";
import InboxBadge from "./InboxBadge";
import SidebarDepts from "./SidebarDepts";
import { HomeIcon, InboxIcon, LayersIcon, MapIcon, MessageIcon, PanelIcon, SettingsIcon, ShareIcon, TargetIcon, UsersIcon } from "./Icons";

/** Sidebar sections. "people" opens the People list; the call screen ("/") is reached from a person or Upload. */
export const SECTIONS = [
  { slug: "today", label: "Today", icon: <HomeIcon size={18} /> },
  { slug: "opportunity-panel", label: "Opportunity panel", icon: <PanelIcon size={18} /> },
  { slug: "departments", label: "Departments", icon: <LayersIcon size={18} /> },
  { slug: "people", label: "People", icon: <UsersIcon size={18} /> },
  { slug: "network-map", label: "Network map", icon: <ShareIcon size={18} /> },
  { slug: "expert-finder", label: "Expert finder", icon: <TargetIcon size={18} /> },
  { slug: "hni-map", label: "HNI map", icon: <MapIcon size={18} /> },
  { slug: "ask-ai", label: "Ask AI", icon: <MessageIcon size={18} /> },
  { slug: "inbox", label: "Inbox", icon: <InboxIcon size={18} /> },
  { slug: "settings", label: "Settings", icon: <SettingsIcon size={18} /> },
] as const;

export const sectionHref = (slug: string) => `/${slug}`;
/** Sections not built yet (their page says "In development"). */
const SOON = new Set<string>(["expert-finder", "hni-map", "ask-ai"]);

/**
 * Left navigation of the Opportunity Room. Every item is a link to its page; `active` is the slug of
 * the current section, or "dept:<slug>" for a department.
 */
export default function Sidebar({ active }: { active: string }) {
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <Link href="/" className="sb-brand">
        <span className="sb-logo" aria-hidden="true">
          <ShareIcon size={18} strokeWidth={2} />
        </span>
        <span className="sb-brand-name">Opportunity Room</span>
      </Link>

      <nav className="sb-nav">
        {SECTIONS.map((n) => (
          <Link
            key={n.slug}
            href={sectionHref(n.slug)}
            className={`sb-item ${active === n.slug ? "sb-item-active" : ""}`}
            aria-current={active === n.slug ? "page" : undefined}
          >
            <span className="sb-icon">{n.icon}</span>
            <span className="sb-label">{n.label}</span>
            {n.slug === "inbox" && <InboxBadge />}
            {SOON.has(n.slug) && <span className="sb-soon">Soon</span>}
          </Link>
        ))}
      </nav>

      <p className="sb-section">Departments</p>
      <SidebarDepts active={active} />

      <SidebarUser />
    </aside>
  );
}

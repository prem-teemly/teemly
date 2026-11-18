"use client";

import Link from "next/link";
import { useDepartments } from "../lib/departments";

/** Sidebar: every department (built-in and added in Settings) with how many people are in it. */
export default function SidebarDepts({ active }: { active: string }) {
  const { departments, loaded } = useDepartments();
  return (
    <ul className="sb-depts">
      {departments.map((d) => {
        const on = active === `dept:${d.slug}`;
        return (
          <li key={d.slug}>
            <Link href={`/departments/${d.slug}`} className={`sb-dept ${on ? "sb-dept-active" : ""}`} aria-current={on ? "page" : undefined}>
              <span className="sb-dot" style={{ background: d.color }} aria-hidden="true" />
              <span className="sb-label">{d.name}</span>
              {loaded && <span className="sb-count">{d.people}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

"use client";

import Link from "next/link";
import { deptStyle, useDepartments } from "../lib/departments";
import type { Department } from "../lib/people";
import { interestOf, interestTitle } from "../lib/people";

/**
 * A department tag in that department's colour (one colour per department everywhere). With `link`,
 * it opens the department's page.
 */
export function DeptTag({ dept, link = false }: { dept: Department; link?: boolean }) {
  const { departments } = useDepartments();
  const d = departments.find((x) => x.name === dept);
  if (link && d) {
    return (
      <Link href={`/departments/${d.slug}`} className="dept-tag dept-tag-link" style={deptStyle(d.color)} onClick={(e) => e.stopPropagation()}>
        {dept}
      </Link>
    );
  }
  return (
    <span className="dept-tag" style={deptStyle(d?.color)}>
      {dept}
    </span>
  );
}

/**
 * How interested someone is, in words: Very interested (green), Interested (teal), Slightly interested
 * (amber), Not interested (red), Not clear yet (grey). The number it comes from is in the tooltip.
 */
export function ScorePill({ score, calls }: { score: number | null; calls?: number }) {
  const { level, label } = interestOf(score);
  const title = interestTitle(score, calls);
  return (
    <span className={`score-pill interest-${level}`} title={title} aria-label={`${label}. ${title}`}>
      {label}
    </span>
  );
}

const AVATAR_TONES = ["av-green", "av-pink", "av-blue", "av-rose", "av-sand", "av-indigo", "av-teal", "av-violet"];

/** Initials avatar with a stable soft colour per name. */
export function PersonAvatar({ name, initials, size = "sm" }: { name: string; initials: string; size?: "sm" | "lg" }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`person-av person-av-${size} ${AVATAR_TONES[h % AVATAR_TONES.length]}`} aria-hidden="true">
      {initials}
    </span>
  );
}

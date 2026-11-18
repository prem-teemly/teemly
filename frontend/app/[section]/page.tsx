import { notFound } from "next/navigation";
import { Suspense } from "react";
import ComingSoon from "../components/ComingSoon";
import { SECTIONS } from "../components/Sidebar";

// Every sidebar section except those with their own folder: People, Departments, Inbox, Settings and
// the Opportunity panel.
const OWN_FOLDER = new Set<string>(["today", "people", "departments", "inbox", "settings", "opportunity-panel", "network-map"]);
const PAGES = SECTIONS.filter((s) => !OWN_FOLDER.has(s.slug));

export function generateStaticParams() {
  return PAGES.map((s) => ({ section: s.slug }));
}

async function Section({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const page = PAGES.find((s) => s.slug === section);
  if (!page) notFound();
  return <ComingSoon active={page.slug} title={page.label} />;
}

export default function Page({ params }: { params: Promise<{ section: string }> }) {
  return (
    <Suspense fallback={null}>
      <Section params={params} />
    </Suspense>
  );
}

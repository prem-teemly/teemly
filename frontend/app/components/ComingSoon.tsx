import Link from "next/link";
import { ChevronRightIcon } from "./Icons";
import Sidebar from "./Sidebar";

/** A section that is not built yet: same shell and sidebar, with a clear "in development" notice. */
export default function ComingSoon({ active, title, parent }: { active: string; title: string; parent?: { label: string; href: string } }) {
  return (
    <div className="shell">
      <Sidebar active={active} />
      <div className="app">
        <header className="topbar topbar-simple">
          <h1 className="page-title">{title}</h1>
        </header>
        <main className="content">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            {parent && (
              <>
                <Link href={parent.href} className="crumb">
                  {parent.label}
                </Link>
                <ChevronRightIcon size={14} className="crumb-sep" />
              </>
            )}
            <span className="crumb crumb-current" aria-current="page">
              {title}
            </span>
          </nav>
          <section className="card dev-card">
            <span className="dev-badge">In development</span>
            <h2 className="dev-title">{title} is currently in development</h2>
            <p className="dev-text">This page is being built and will be available soon.</p>
            <Link href="/" className="tb-btn tb-btn-primary dev-back">
              Go to People
            </Link>
          </section>
        </main>
      </div>
    </div>
  );
}

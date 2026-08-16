/**
 * The owner's operations console: the shell the judge-facing screens render in.
 *
 * WHAT THIS IS
 * ------------
 * `(owner)` is a route group. It groups the four screens the company's operator
 * looks at and gives them a shared shell, and because the folder name is
 * parenthesised it contributes nothing to any URL. `/`, `/log`, `/dashboard` and
 * `/opportunities/[id]` are unchanged.
 *
 * WHY IT IS NOT THE ROOT LAYOUT
 * -----------------------------
 * It used to be. The root layout wraps every route in the application, including
 * the subscriber's screens under `/app` and the public screens at `/sample` and
 * `/study/thanks`, so the console's navigation appeared above surfaces that
 * belong to different people: a contractor reading their leads was offered
 * "Decision log", and a member of the public who answered a research question was
 * offered "Operations". Moving the chrome down here means the console's
 * navigation exists on exactly the screens the console owns, and the contractor
 * stylesheet no longer has to hide it after the fact.
 *
 * TWO JOBS, THE SAME TWO AS BEFORE
 * --------------------------------
 * 1. Navigate between the screens, so a judge can move from the operating view to
 *    a single opportunity to the full log to the company numbers without anyone
 *    typing a URL.
 * 2. State the provenance of everything on screen, once, in the footer. Every
 *    record in this application comes from two named public datasets, and saying
 *    so in the chrome means no individual screen has to argue for its own
 *    credibility.
 *
 * The three elements are returned as siblings rather than inside a new wrapper,
 * so the console's markup and therefore its layout are exactly what they were
 * when this code lived one level up. The dark ground stays on `body` in
 * `globals.css`: it is the application's default surface, and the light surfaces
 * paint over it rather than the console painting itself.
 *
 * The registry read here is a pure in-process lookup of static descriptors, not a
 * store query. Nothing in this file can take a screen down.
 */
import type { ReactNode } from 'react';

import SurfaceSwitch from '@/app/components/SurfaceSwitch';
import { getSource } from '@/lib/adapters/sources/registry';

/** Screens, in the order a demo walks them. */
const NAV: readonly { href: string; label: string }[] = [
  { href: '/', label: 'Operations' },
  { href: '/log', label: 'Decision log' },
  { href: '/dashboard', label: 'Company' },
];

export default function OwnerLayout({ children }: { children: ReactNode }) {
  const permits = getSource('datasf.building_permits');
  const contacts = getSource('datasf.building_permit_contacts');

  return (
    <>
      <SurfaceSwitch active="operations" />

      <header className="site-header">
        <div className="site-header-inner">
          <a href="/" className="brand">
            Lead<span className="brand-mark">Velocity</span>
            <span className="brand-tag">From permit to pipeline</span>
          </a>
          <nav className="site-nav" aria-label="Primary">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="nav-link">
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="site-main">{children}</main>

      <footer className="site-footer">
        <p>
          Records on every screen come from {permits.agency}: {permits.name} (dataset{' '}
          {permits.datasetId}) and {contacts.name} (dataset {contacts.datasetId}). Nothing here is
          sample data.
        </p>
      </footer>
    </>
  );
}

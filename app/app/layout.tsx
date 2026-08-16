/**
 * The contractor app shell.
 *
 * WHAT THIS IS
 * ------------
 * Everything under `/app` is the half of LeadVelocity the SUBSCRIBER sees: their
 * leads, and the profile that decides which leads they get. The owner's
 * operations console lives at `/`, `/log` and `/dashboard` and shares nothing
 * with this surface except the company name.
 *
 * The two are kept apart by route and by stylesheet. The console's chrome is in
 * its own route group, `app/(owner)/`, so it is not merely hidden here, it is
 * never rendered here. `contractor.css` is imported by this layout and only by
 * this layout, its tokens are prefixed `--lv-` and scoped to `.lv-app`, and it
 * redefines nothing from `globals.css`. The dark console cannot be repainted by
 * anything in this tree.
 *
 * WHY IT IS 390 PIXELS WIDE
 * -------------------------
 * The prototype frames the contractor screens in a 390px phone and that is not a
 * mock-up affectation. The subscriber is a commercial electrician reading this
 * between jobs, one handed, outdoors. On a phone the column is the whole screen;
 * on a desktop it is centred on the page, which is also how a demo is watched.
 *
 * THE SHELL READS ONE THING
 * -------------------------
 * The subscriber's business name, so the screens can be addressed to somebody.
 * The root layout deliberately reads nothing, on the grounds that a layout which
 * queries the store makes every screen fail together. That reasoning is honoured
 * here rather than ignored: the read is wrapped, an unconfigured or unreachable
 * store renders the shell with the account slot saying so, and the screen inside
 * still renders its own state. Nothing in this file can take a page down.
 *
 * There is no sign-in and none is planned for this build. `getPrimaryCustomer()`
 * IS the signed-in subscriber, which is honest for a single-subscriber demo and
 * is stated in the kickoff rather than smuggled in here.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import SurfaceSwitch from '@/app/components/SurfaceSwitch';
import { getPrimaryCustomer, isStoreReady } from '@/lib/store';

import './contractor.css';

/** The subscriber's own leads. Never cached between requests. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'LeadVelocity',
  description:
    'Commercial projects in your territory, scored and sent to you. From permit to pipeline.',
};

/** Bottom tabs, in the prototype's order. */
const TABS: readonly { id: string; href: string; label: string }[] = [
  { id: 'leads', href: '/app/leads', label: 'Leads' },
  { id: 'profile', href: '/app/profile', label: 'Profile' },
];

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

/** The prototype's inbox tray. */
function LeadsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

/** The prototype's person glyph. */
function ProfileIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The business name for the header, or `null` when it cannot be read.
 *
 * Swallowing the error is correct here and only here: the account chip is
 * chrome. A store that is down is reported loudly by the screen inside the
 * shell, which is the component that actually has something to say about it.
 */
async function subscriberName(): Promise<string | null> {
  if (!isStoreReady()) return null;
  try {
    const customer = await getPrimaryCustomer();
    return customer === null ? null : customer.businessName;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

export default async function ContractorLayout({ children }: { children: ReactNode }) {
  const businessName = await subscriberName();

  return (
    <>
      {/*
       * Outside `.lv-app`, not inside it. The shell is a centred, padded column
       * and the switch is a full-width strip pinned to the top of the window, so
       * nesting it would mean fighting the column's padding and its centring.
       * `contractor.css` shortens the shell by the switch's height through the
       * sibling selector this ordering makes available.
       */}
      <SurfaceSwitch active="customer" />

      <div className="lv-app">
        <div className="lv-frame">
          <header className="lv-appbar">
            <div>
              <div className="lv-wordmark">
                Lead<span className="lv-wordmark-mark">Velocity</span>
              </div>
              <span className="lv-tagline">From permit to pipeline</span>
            </div>
            {businessName === null ? (
              <span className="lv-account lv-account--absent">Account not on file</span>
            ) : (
              <span className="lv-account">{businessName}</span>
            )}
          </header>

          <div className="lv-screen">{children}</div>

          <nav className="lv-tabbar" aria-label="Sections">
            {TABS.map((tab) => (
              <Link key={tab.id} className="lv-tab" data-lv-tab={tab.id} href={tab.href}>
                {tab.id === 'leads' ? <LeadsIcon /> : <ProfileIcon />}
                {tab.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </>
  );
}

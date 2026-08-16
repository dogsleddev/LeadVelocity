/**
 * Root layout: the document, and nothing else.
 *
 * WHY THIS FILE IS ALMOST EMPTY
 * ----------------------------
 * LeadVelocity has three audiences and they must never see each other's chrome:
 *
 *   /            /log  /dashboard  /opportunities  the OWNER's operations console
 *   /app/*                                         the SUBSCRIBER's own leads
 *   /sample  /study/thanks                         the PUBLIC, with no account
 *
 * A root layout is the one place in the App Router that wraps all three, so
 * anything rendered here is rendered for everybody. The owner's navigation used
 * to live in this file, which meant a contractor opening their inbox and a study
 * participant landing on a thank-you page were both served links to
 * "Operations / Decision log / Company". Each surface now owns its own chrome:
 * the console's lives in `app/(owner)/layout.tsx`, the subscriber's in
 * `app/app/layout.tsx`, and the public screens carry theirs on the page.
 *
 * `(owner)` is a route group, so it does not appear in any URL. `/log` is still
 * `/log`.
 *
 * WHAT REMAINS HERE
 * -----------------
 * The stylesheet, and the document element. `globals.css` holds the reset and the
 * two palettes that must be defined exactly once (four agents, four evidence
 * labels), so it is loaded once, here. It no longer paints the body: the console's
 * dark ground is a property of the console, and it moved with the console.
 *
 * No data is read here. A layout that queried the store would make every screen
 * fail together when Supabase is unconfigured, and the requirement is the
 * opposite: each screen degrades on its own, with an honest empty state.
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'LeadVelocity',
  description:
    'From permit to pipeline. Real San Francisco permit records, scored and delivered to one commercial electrical contractor.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

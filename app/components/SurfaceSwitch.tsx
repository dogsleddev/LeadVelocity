/**
 * The demo switch: one control, always in the same place, for the two people
 * this product has.
 *
 * WHY THIS EXISTS
 * ---------------
 * LeadVelocity is two interfaces for two different readers. Mike, the commercial
 * electrician, opens `/app/leads` and sees the jobs he is paying for. The
 * operator opens `/`, `/log` and `/dashboard` and sees the company running. The
 * two are separated by route and by stylesheet on purpose, and they used to be
 * separated so completely that **nothing in the application linked to the
 * customer side at all**: the only way to reach Mike's inbox was to know the URL
 * and type it. That is fine for a product with a login and useless for a demo.
 *
 * This is the one control that crosses the line, deliberately and visibly. It is
 * not the owner's navigation leaking into the customer's screens (see the note in
 * `app/(owner)/layout.tsx` about why that mattered); it is a two-item switch that
 * says which of the two surfaces you are looking at and lets you change your
 * mind.
 *
 * WHERE IT IS RENDERED, AND WHERE IT IS NOT
 * -----------------------------------------
 *   app/(owner)/layout.tsx    active="operations"
 *   app/app/layout.tsx        active="customer"
 *
 * It is NOT on `/sample` or `/study/thanks`. Those are read by prospects and by
 * members of the public who answered a research question, and neither of them
 * should be offered a door into the company's operations console.
 *
 * WHY IT TAKES A PROP INSTEAD OF READING THE PATH
 * -----------------------------------------------
 * A server component cannot read the current pathname, and turning either shell
 * into a client component for one highlight would be a poor trade. It does not
 * need to: each layout knows statically which surface it is. The same reasoning
 * the contractor stylesheet already uses for its tab highlight.
 *
 * The links are plain `<a>` rather than `next/link`. Crossing between two
 * surfaces with different stylesheets is exactly the case where a full document
 * load is wanted: it guarantees the destination's CSS is the CSS in force, with
 * no chance of the previous surface's sheet still being resident.
 *
 * STYLES live in `app/globals.css` under "Surface switch". That stylesheet is
 * loaded by the root layout, so it is in force on both surfaces; `contractor.css`
 * does not define or override anything the switch uses.
 */

/** Which surface the reader is currently on. */
export type Surface = 'customer' | 'operations';

interface Door {
  surface: Surface;
  href: string;
  label: string;
  hint: string;
}

/**
 * The two doors, customer first.
 *
 * Customer leads because it is the interface that carries the product. The
 * operations console is the proof behind it, and proof comes second.
 */
const DOORS: readonly Door[] = [
  {
    surface: 'customer',
    href: '/app/leads',
    label: "Mike's Electric",
    hint: 'What the subscriber sees',
  },
  {
    surface: 'operations',
    href: '/',
    label: 'Operations',
    hint: 'What the company is doing',
  },
];

export default function SurfaceSwitch({ active }: { active: Surface }) {
  return (
    <div className="surface-switch">
      <nav className="surface-switch-inner" aria-label="Choose a view">
        <span className="surface-switch-caption">Viewing as</span>
        <div className="surface-switch-track">
          {DOORS.map((door) => {
            const current = door.surface === active;
            return (
              <a
                key={door.surface}
                className="surface-switch-door"
                href={door.href}
                title={door.hint}
                data-current={current ? 'true' : 'false'}
                aria-current={current ? 'page' : undefined}
              >
                {door.label}
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

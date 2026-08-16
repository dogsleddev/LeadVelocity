/**
 * Landing page for Terac study participants.
 *
 * The Terac API requires every opportunity to carry at least one task with a
 * URL. The study itself is carried by the screening questions, so this page is
 * where the nominal "activity" task points. It exists so participants land
 * somewhere real and legible rather than a dead link.
 *
 * Customer-facing copy rules apply here (CLAUDE.md rule 9): this is read by
 * members of the public, so no AI/agent/autonomous language and no em dashes.
 */
export const metadata = {
  title: 'Thanks for your help',
};

export default function StudyThanksPage() {
  return (
    <main className="study-thanks">
      <h1>Thanks, that is all we needed.</h1>
      <p>
        Your answers help a small contracting business figure out how to introduce itself without
        wasting anyone&apos;s time. That is the whole study.
      </p>
      <p className="study-thanks__meta">You can close this window.</p>
    </main>
  );
}

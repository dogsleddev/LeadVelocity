/**
 * `/app` has no screen of its own.
 *
 * The contractor opens this product to see what came in, so the root of the
 * subscriber surface is the inbox. Redirecting rather than rendering the list
 * here keeps one canonical URL for it: `/app/leads` is what the tab bar links
 * to, what a delivered text message can point at, and what the browser shows
 * afterwards.
 */
import { redirect } from 'next/navigation';

export default function ContractorHome(): never {
  redirect('/app/leads');
}

/**
 * `npm run linq:sync` - reconcile Linq's chat list into `inbound_contacts`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `inbound_contacts` is normally written by the webhook at `/api/linq/inbound`
 * when someone texts the company's number. That webhook needs a public URL, so
 * between getting a Linq key and deploying there is a window where a handle has
 * genuinely messaged us, Linq knows it, and our database does not. In that
 * window the Sales Agent correctly refuses to send, because as far as the gate
 * can tell nobody has made contact.
 *
 * This closes that window by asking Linq who it already has chats with and
 * recording exactly those handles. It is reconciliation, not invention: every
 * row written corresponds to a real chat Linq returned, and nothing is created
 * for a handle Linq does not know.
 *
 * It is NOT a replacement for the webhook. It cannot see opt-outs, it cannot
 * capture message text for feedback, and it only runs when you run it. Wire the
 * webhook as soon as there is a public URL.
 *
 *   npm run linq:sync            record every handle Linq has a chat with
 *   npm run linq:sync -- --dry   show what would be recorded, write nothing
 */
import { hasCapability, missingKeys, envOr, requireEnv } from '@/lib/config/deployment-env';

interface LinqHandle {
  handle?: unknown;
  is_me?: unknown;
}

interface LinqChat {
  id?: unknown;
  created_at?: unknown;
  handles?: unknown;
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');

  if (!hasCapability('linq')) {
    console.error(`Linq is not configured. Missing: ${missingKeys('linq').join(', ')}`);
    process.exit(1);
  }
  if (!dry && !hasCapability('supabase')) {
    console.error(`Supabase is not configured. Missing: ${missingKeys('supabase').join(', ')}`);
    process.exit(1);
  }

  const base = envOr('LINQ_API_V3_BASE_URL', 'https://api.linqapp.com/api/partner').replace(/\/+$/, '');
  const response = await fetch(`${base}/v3/chats`, {
    headers: {
      authorization: `Bearer ${requireEnv('LINQ_API_V3_API_KEY')}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    console.error(`Linq returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    process.exit(1);
  }

  const payload = (await response.json()) as { chats?: unknown; data?: unknown };
  const raw = Array.isArray(payload.chats) ? payload.chats : Array.isArray(payload.data) ? payload.data : [];
  const chats = raw as LinqChat[];

  // A chat's participants include our own line; only the others are contacts.
  const contacts: Array<{ handle: string; chatId: string | null }> = [];
  for (const chat of chats) {
    const chatId = typeof chat.id === 'string' ? chat.id : null;
    const handles = Array.isArray(chat.handles) ? (chat.handles as LinqHandle[]) : [];
    for (const entry of handles) {
      if (entry.is_me === true) continue;
      const handle = typeof entry.handle === 'string' ? entry.handle.trim() : '';
      if (handle === '') continue;
      if (!contacts.some((c) => c.handle === handle)) contacts.push({ handle, chatId });
    }
  }

  console.log(`Linq reports ${chats.length} chat(s), ${contacts.length} distinct contact handle(s).`);
  if (contacts.length === 0) {
    console.log('Nobody has messaged the number yet, so there is nothing to record.');
    console.log('On the sandbox the company cannot message a handle until it texts first.');
    return;
  }

  for (const contact of contacts) {
    console.log(`  ${contact.handle}${contact.chatId === null ? '' : `  chat ${contact.chatId.slice(0, 8)}...`}`);
  }

  if (dry) {
    console.log('\n--dry: nothing written.');
    return;
  }

  const { recordInboundContact, isReachable } = await import('@/lib/store/inbound');
  const { logEvent } = await import('@/lib/store/events');

  let recorded = 0;
  for (const contact of contacts) {
    await recordInboundContact({ handle: contact.handle, channel: 'linq', chatId: contact.chatId });
    recorded += 1;
  }

  await logEvent({
    agent: 'sales',
    decision: 'inbound.reconciled',
    summary: `Reconciled ${recorded} contact handle(s) from the messaging provider's chat list, so outreach can proceed to people who have already made contact.`,
    refs: { source: 'linq:/v3/chats', count: String(recorded) },
  });

  console.log(`\nRecorded ${recorded} contact(s).`);
  for (const contact of contacts) {
    console.log(`  ${contact.handle} reachable: ${await isReachable(contact.handle)}`);
  }
}

main().catch((err: unknown) => {
  console.error('linq:sync failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

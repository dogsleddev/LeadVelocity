/**
 * Copy policy tests.
 *
 * CLAUDE.md hard rule #9 is the one rule in this codebase that fails silently.
 * A broken score throws or looks wrong; a message that says "our AI agent found
 * this lead" sends perfectly and only fails in front of a judge. So it gets a
 * test, and the test is adversarial rather than decorative.
 *
 * Three things are checked:
 *
 * 1. The guard actually catches things. Positive controls run first, because a
 *    regex that matches nothing would make every other assertion here pass.
 * 2. Every string the templates can emit is clean, under the SMS limit, and free
 *    of leaked nulls.
 * 3. The three study variants are genuinely different arguments, not three
 *    paraphrases. Ranking paraphrases would produce a real panel number attached
 *    to a meaningless question.
 *
 * The fixture is the real hero permit read out of the committed extract, not an
 * invented one (hard rule #5, and the kickoff's "never invent fixtures").
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BANNED_LANGUAGE_PATTERN,
  EM_DASH_PATTERN,
  SMS_CHARACTER_LIMIT,
  assertCustomerSafe,
  checkoutInviteSms,
  findCopyViolations,
  formatIssuedRecency,
  formatProjectValue,
  isCustomerSafe,
  opportunitySms,
  sampleOutreachVariants,
  type OpportunityCopyContext,
  type OutreachCopyContext,
} from '@/lib/copy/templates';

/* -------------------------------------------------------------------------- */
/* Fixture: the real hero permit                                              */
/* -------------------------------------------------------------------------- */

const HERO_PERMIT_NUMBER = '202603238106';
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

interface RawPermit {
  permit_number?: string;
  street_number?: string;
  street_name?: string;
  street_suffix?: string;
  neighborhoods_analysis_boundaries?: string;
  estimated_cost?: string;
  revised_cost?: string;
  description?: string;
}

interface RawContact {
  permit_number?: string;
  role?: string;
  firm_name?: string;
  first_name?: string;
  last_name?: string;
}

function loadJson<T>(file: string): T[] {
  return JSON.parse(readFileSync(path.join(dataDir, file), 'utf8')) as T[];
}

const permits = loadJson<RawPermit>('permits.json');
const contacts = loadJson<RawContact>('contacts.json');

const heroPermit = permits.find((p) => p.permit_number === HERO_PERMIT_NUMBER);
const heroContractor = contacts.find(
  (c) => c.permit_number === HERO_PERMIT_NUMBER && c.role === 'contractor',
);

/** Socrata sends every value as a string, including money. Coerce explicitly. */
function toNumber(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function heroContext(): OpportunityCopyContext {
  if (heroPermit === undefined) {
    throw new Error(`hero permit ${HERO_PERMIT_NUMBER} missing from data/permits.json`);
  }
  const address = [heroPermit.street_number, heroPermit.street_name, heroPermit.street_suffix]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' ');

  return {
    contactFirstName: 'Mike',
    projectAddress: address,
    neighborhood: heroPermit.neighborhoods_analysis_boundaries ?? null,
    /* Project valuation is max(revised_cost, estimated_cost) after coercion. */
    valuationUsd: Math.max(toNumber(heroPermit.revised_cost), toNumber(heroPermit.estimated_cost)),
    scopeSummary: '31st floor office remodel, new lighting, power and communications',
    generalContractor: heroContractor?.firm_name ?? null,
    contactName:
      heroContractor !== undefined
        ? [heroContractor.first_name, heroContractor.last_name].filter(Boolean).join(' ')
        : null,
    openingReason: 'no electrical contractor is on the permit yet',
    daysSinceIssued: 4,
    detailUrl: 'https://leadvelocity.app/o/202603238106',
  };
}

function heroOutreach(): OutreachCopyContext {
  return {
    contactFirstName: 'Mike',
    territoryLabel: 'San Francisco',
    opportunity: heroContext(),
    priceMonthlyUsd: 149,
    minProjectValueUsd: 100_000,
    actionUrl: 'https://leadvelocity.app/s/mikes-commercial-electric',
  };
}

/** Every string the copy layer can emit, for the blanket policy sweep. */
function everyGeneratedString(): { label: string; text: string }[] {
  const out = [
    { label: 'opportunitySms', text: opportunitySms(heroContext()) },
    { label: 'checkoutInviteSms', text: checkoutInviteSms(heroOutreach()) },
  ];
  for (const variant of sampleOutreachVariants(heroOutreach())) {
    out.push({ label: `variant:${variant.id}`, text: variant.text });
  }
  return out;
}

/* -------------------------------------------------------------------------- */

describe('the fixture is real', () => {
  it('reads the hero permit out of the committed extract', () => {
    expect(heroPermit).toBeDefined();
    expect(heroContractor?.firm_name).toBe('Skyline Construction');
    expect(heroContext().valuationUsd).toBe(8_285_917);
  });
});

describe('policy guard (positive controls)', () => {
  const mustBeCaught: [string, string][] = [
    ['bare AI', 'Our AI found this job for you.'],
    ['dotted A.I.', 'Powered by A.I. research.'],
    ['agent', 'Your sales agent picked this one.'],
    ['agents plural', 'Four agents run the company.'],
    ['autonomous', 'A fully autonomous pipeline.'],
    ['automated', 'This is an automated message.'],
    ['automation', 'Permit automation for contractors.'],
    ['LLM', 'The LLM read the permit description.'],
    ['GPT', 'GPT wrote this text.'],
    ['artificial intelligence', 'Artificial intelligence sorts your leads.'],
    ['vendor name', 'Built with Claude.'],
    ['em dash', 'A big job at 555 California St — worth a call.'],
  ];

  for (const [name, text] of mustBeCaught) {
    it(`rejects ${name}`, () => {
      expect(isCustomerSafe(text)).toBe(false);
      expect(findCopyViolations(text).length).toBeGreaterThan(0);
      expect(() => assertCustomerSafe(text, name)).toThrow(/Customer-facing copy check failed/);
    });
  }

  it('does not fire on innocent words that merely contain a banned substring', () => {
    const innocent =
      'A 31st floor remodel in San Francisco. The model office plan is done, ' +
      'the management team is set, and the paint is automotive grade.';
    expect(findCopyViolations(innocent)).toEqual([]);
  });

  it('leaves en dashes and hyphens alone', () => {
    expect(isCustomerSafe('Work runs 2026-03-23 to 2026-04-10, floors 5–6.')).toBe(true);
  });

  it('reports where the violation is', () => {
    const violations = findCopyViolations('Nice job. Our agent called it.');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('banned-language');
    expect(violations[0]?.match.toLowerCase()).toBe('agent');
  });
});

describe('every generated string is safe to send', () => {
  for (const { label, text } of everyGeneratedString()) {
    describe(label, () => {
      it('carries no banned language', () => {
        expect(BANNED_LANGUAGE_PATTERN.test(text)).toBe(false);
      });

      it('carries no em dash', () => {
        expect(EM_DASH_PATTERN.test(text)).toBe(false);
      });

      it('passes the combined guard', () => {
        expect(findCopyViolations(text)).toEqual([]);
      });

      it(`fits inside ${SMS_CHARACTER_LIMIT} characters`, () => {
        expect(text.length).toBeGreaterThan(40);
        expect(text.length).toBeLessThanOrEqual(SMS_CHARACTER_LIMIT);
      });

      it('leaks no placeholder or unresolved value', () => {
        expect(text).not.toMatch(/\b(?:null|undefined|NaN|\[object Object\])\b/);
        expect(text).not.toMatch(/\$\{|\{\{/);
      });

      it('ends with a working link', () => {
        expect(text).toMatch(/https:\/\/\S+$/);
      });

      it('starts as a sentence', () => {
        expect(text).toMatch(/^[A-Z]/);
      });
    });
  }
});

describe('reduction never strands a sentence', () => {
  /*
   * Clauses are authored lowercase because they follow the greeting. Cutting the
   * greeting therefore has to promote the next clause, and cutting the clause
   * behind the greeting must never happen first. This is the regression guard:
   * an over-long link forces reductions and the result still reads as English.
   */
  const longUrl = `https://leadvelocity.app/s/${'x'.repeat(90)}`;

  it('drops the greeting before the clause that follows it', () => {
    const text = checkoutInviteSms({ ...heroOutreach(), actionUrl: longUrl });
    expect(text).toMatch(/^[A-Z]/);
    expect(text).not.toMatch(/,\s+You get/);
    expect(text).toContain('Reply STOP to opt out.');
    expect(text.length).toBeLessThanOrEqual(SMS_CHARACTER_LIMIT);
  });

  it('capitalizes the opening clause when there is no name to greet', () => {
    const text = opportunitySms({ ...heroContext(), contactFirstName: null });
    expect(text.startsWith('New permit at 555 California St')).toBe(true);
    expect(findCopyViolations(text)).toEqual([]);
  });

  it('keeps every variant grammatical under a forced reduction', () => {
    for (const variant of sampleOutreachVariants({ ...heroOutreach(), actionUrl: longUrl })) {
      expect(variant.text, variant.id).toMatch(/^[A-Z]/);
      expect(variant.text.length, variant.id).toBeLessThanOrEqual(SMS_CHARACTER_LIMIT);
      expect(findCopyViolations(variant.text)).toEqual([]);
    }
  });
});

describe('opportunitySms', () => {
  it('leads with the address and the scope, and names the way in', () => {
    const text = opportunitySms(heroContext());
    expect(text).toContain('555 California St');
    expect(text).toContain('Skyline Construction');
    expect(text).toContain('$8.3M');
    expect(text.toLowerCase()).toContain('no electrical contractor');
    expect(text).toContain('https://leadvelocity.app/o/202603238106');
  });

  it('is pure: the same context renders the same string', () => {
    expect(opportunitySms(heroContext())).toBe(opportunitySms(heroContext()));
  });

  it('omits unknown facts rather than guessing at them', () => {
    const sparse: OpportunityCopyContext = {
      ...heroContext(),
      valuationUsd: null,
      generalContractor: null,
      contactName: null,
      neighborhood: null,
      openingReason: null,
      daysSinceIssued: null,
    };
    const text = opportunitySms(sparse);
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/ago|today|yesterday/);
    expect(findCopyViolations(text)).toEqual([]);
    expect(text.length).toBeLessThanOrEqual(SMS_CHARACTER_LIMIT);
  });

  it('stays inside the limit when every field is oversized, and keeps the link', () => {
    const bloated: OpportunityCopyContext = {
      ...heroContext(),
      projectAddress: '1234567 Extraordinarily Long Boulevard Of Considerable Consequence',
      neighborhood: 'A Neighbourhood With An Unreasonably Long Analysis Boundary Name',
      scopeSummary:
        'complete gut renovation of floors one through fifty two including new lighting, ' +
        'power distribution, communications rough in, fire alarm, low voltage, and the ' +
        'replacement of every panel, feeder and switchboard in the building core',
      generalContractor: 'An Extremely Long General Contractor Company Name Incorporated',
      contactName: 'Bartholomew Fitzwilliam Montgomery',
      openingReason: 'no electrical contractor of any description appears anywhere on this permit yet',
    };
    const text = opportunitySms(bloated);
    expect(text.length).toBeLessThanOrEqual(SMS_CHARACTER_LIMIT);
    expect(text.endsWith('https://leadvelocity.app/o/202603238106')).toBe(true);
    expect(findCopyViolations(text)).toEqual([]);
  });
});

describe('checkoutInviteSms', () => {
  it('states the price, the floor, and the opt out', () => {
    const text = checkoutInviteSms(heroOutreach());
    expect(text).toContain('$149 a month');
    expect(text).toContain('$100k');
    expect(text).toContain('Reply STOP');
    expect(text).toContain('https://leadvelocity.app/s/mikes-commercial-electric');
  });
});

describe('sampleOutreachVariants', () => {
  const variants = sampleOutreachVariants(heroOutreach());

  it('returns exactly three, with stable distinct ids', () => {
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.id)).toEqual(['a', 'b', 'c']);
    expect(new Set(variants.map((v) => v.angle)).size).toBe(3);
  });

  it('produces three different strings', () => {
    expect(new Set(variants.map((v) => v.text)).size).toBe(3);
  });

  it('makes three different arguments, not three paraphrases', () => {
    /*
     * Jaccard similarity over word sets. Anything above 0.45 means two variants
     * are saying the same thing in different words, which would make the panel
     * ranking meaningless. Shared proper nouns (the address, the firm) keep the
     * floor above zero, so the bar is set where a real rewrite lands, not at 0.
     */
    const words = (text: string): Set<string> =>
      new Set(
        text
          .toLowerCase()
          .replace(/https:\/\/\S+/g, '')
          .split(/[^a-z0-9$]+/)
          .filter((w) => w.length > 2),
      );

    const sets = variants.map((v) => words(v.text));
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        const a = sets[i];
        const b = sets[j];
        if (a === undefined || b === undefined) throw new Error('variant word set missing');
        const shared = [...a].filter((w) => b.has(w)).length;
        const union = new Set([...a, ...b]).size;
        const jaccard = shared / union;
        expect(
          jaccard,
          `variants ${variants[i]?.id} and ${variants[j]?.id} overlap at ${jaccard.toFixed(2)}`,
        ).toBeLessThan(0.45);
      }
    }
  });

  it('is pure: the same context renders the same variants', () => {
    expect(sampleOutreachVariants(heroOutreach())).toEqual(variants);
  });
});

describe('formatters', () => {
  it('renders money the way a contractor says it', () => {
    expect(formatProjectValue(8_285_917)).toBe('$8.3M');
    expect(formatProjectValue(14_150_000)).toBe('$14.2M');
    expect(formatProjectValue(100_000)).toBe('$100k');
    expect(formatProjectValue(950)).toBe('$950');
  });

  it('declines to render a value it does not have', () => {
    expect(formatProjectValue(null)).toBeNull();
    expect(formatProjectValue(0)).toBeNull();
    expect(formatProjectValue(Number.NaN)).toBeNull();
  });

  it('phrases recency for a person, and refuses nonsense', () => {
    expect(formatIssuedRecency(0)).toBe('issued today');
    expect(formatIssuedRecency(1)).toBe('issued yesterday');
    expect(formatIssuedRecency(4)).toBe('issued 4 days ago');
    expect(formatIssuedRecency(null)).toBeNull();
    expect(formatIssuedRecency(-3)).toBeNull();
    expect(formatIssuedRecency(400)).toBeNull();
  });
});

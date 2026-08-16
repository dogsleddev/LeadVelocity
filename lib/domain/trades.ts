/**
 * Trade definitions: the one place the engine knows what a trade is.
 *
 * LeadVelocity is not an electrical product. It is a permit-to-pipeline engine
 * for commercial contractors, and electrical is the trade it is configured for
 * first. The pitch says this out loud ("today one trade in one city; the engine
 * does not change for the next trade or the next city"), so the code has to be
 * able to back that claim up rather than have `electrical` welded into it.
 *
 * Everything trade-specific lives in `TRADE_PROFILES` below. Scoring, filtering,
 * and copy read the profile for `customer.trade` and contain no trade vocabulary
 * of their own. Adding a trade is adding an entry here, which is the point.
 *
 * SCOPE NOTE: the kickoff's not-building list says "no second trade unless
 * electrical is rock solid". That still holds for the DEMO. This file does not
 * enable a second trade; the seeded subscriber is electrical and nothing else is
 * sold. It removes the type-level lock so the generality is demonstrable, and it
 * is covered by a test that scores the same real permit for two trades and gets
 * different answers.
 */
import { z } from 'zod';

/**
 * Trades the engine can be configured for, keyed to their CSLB classification.
 *
 * Deliberately limited to classifications that do meaningful COMMERCIAL work, so
 * the permit trigger model holds. A trade whose work never appears on a
 * commercial building permit does not belong here.
 */
export const tradeSchema = z.enum([
  'electrical',
  'plumbing',
  'hvac',
  'roofing',
  'fire_protection',
  'glazing',
  'general_building',
]);
export type Trade = z.infer<typeof tradeSchema>;

/** The trade the demo subscriber is configured for. */
export const DEFAULT_TRADE: Trade = 'electrical';

/**
 * What the engine needs to know about a trade.
 *
 * `core` terms mean the trade's own scope is named in the permit description.
 * `adjacent` terms mean scope that reliably CARRIES this trade behind it: a
 * tenant improvement always buys electrical, a reroof always buys roofing.
 * `negations` are phrases stripped before keyword scanning, because the agency
 * writes the negative inline and a naive match would invent a lead out of it.
 */
export interface TradeProfile {
  /** How a contractor in this trade would say it. Used in customer-facing copy. */
  readonly label: string;
  /** CSLB classification, for prospect qualification and licence verification. */
  readonly cslbClassification: string;
  readonly core: readonly string[];
  readonly adjacent: readonly string[];
  readonly negations: readonly RegExp[];
}

export const TRADE_PROFILES: Readonly<Record<Trade, TradeProfile>> = Object.freeze({
  electrical: {
    label: 'electrical',
    cslbClassification: 'C-10',
    core: [
      'electrical', 'electric', 'lighting', 'light fixture', 'power', 'panel',
      'panelboard', 'switchgear', 'service upgrade', 'transformer', 'generator',
      'ev charger', 'feeder', 'conduit', 'wiring', 'circuit', 'mep', 'low voltage',
    ],
    adjacent: [
      'tenant improvement', 'ti', 't.i.', 'build-out', 'buildout', 'remodel',
      'alteration', 'office space', 'hvac', 'mechanical', 'fire alarm',
      'communication', 'data', 'kitchen', 'elevator', 'sign',
    ],
    negations: [
      /\bnon[\s-]?electric(?:al)?\b/g,
      /\bno\s+electric(?:al)?\s+work\b/g,
      /\bnon[\s-]?illuminated\b/g,
    ],
  },
  plumbing: {
    label: 'plumbing',
    cslbClassification: 'C-36',
    core: [
      'plumbing', 'plumb', 'water heater', 'restroom', 'lavatory', 'water line',
      'sewer', 'drain', 'waste line', 'gas line', 'backflow', 'grease interceptor',
      'fixture', 'mep',
    ],
    adjacent: [
      'tenant improvement', 'ti', 't.i.', 'build-out', 'buildout', 'remodel',
      'alteration', 'kitchen', 'commercial kitchen', 'mechanical', 'hvac', 'toilet',
    ],
    negations: [/\bno\s+plumbing\s+work\b/g, /\bnon[\s-]?potable\b/g],
  },
  hvac: {
    label: 'heating and air',
    cslbClassification: 'C-20',
    core: [
      'hvac', 'mechanical', 'air distribution', 'ductwork', 'duct', 'rooftop unit',
      'rtu', 'air handler', 'condenser', 'chiller', 'boiler', 'furnace',
      'ventilation', 'exhaust', 'mep',
    ],
    adjacent: [
      'tenant improvement', 'ti', 't.i.', 'build-out', 'buildout', 'remodel',
      'alteration', 'office space', 'kitchen', 'hood', 'electrical',
    ],
    negations: [/\bno\s+mechanical\s+work\b/g],
  },
  roofing: {
    label: 'roofing',
    cslbClassification: 'C-39',
    core: ['roof', 'reroof', 're-roofing', 'roofing', 'roof deck', 'membrane', 'parapet', 'skylight'],
    adjacent: ['waterproofing', 'gutter', 'drainage', 'alteration', 'envelope', 'solar'],
    negations: [/\bno\s+roof(?:ing)?\s+work\b/g],
  },
  fire_protection: {
    label: 'fire protection',
    cslbClassification: 'C-16',
    core: ['fire sprinkler', 'sprinkler', 'fire alarm', 'standpipe', 'fire pump', 'smoke detector', 'strobe', 'fire suppression'],
    adjacent: ['tenant improvement', 'ti', 't.i.', 'build-out', 'alteration', 'kitchen', 'hood', 'mep'],
    negations: [/\bno\s+fire\s+(?:alarm|sprinkler)\s+work\b/g],
  },
  glazing: {
    label: 'glass and glazing',
    cslbClassification: 'C-17',
    core: ['glazing', 'storefront', 'curtain wall', 'window', 'glass', 'skylight', 'glazed'],
    adjacent: ['facade', 'envelope', 'alteration', 'partition', 'tenant improvement'],
    negations: [/\bno\s+window\s+work\b/g],
  },
  general_building: {
    label: 'general building',
    cslbClassification: 'B',
    core: ['tenant improvement', 'ti', 't.i.', 'build-out', 'buildout', 'new construction', 'addition', 'alteration', 'remodel'],
    adjacent: ['partition', 'millwork', 'ceiling', 'finishes', 'demolition', 'structural', 'mep'],
    negations: [],
  },
});

/** Profile for a trade. Total over the enum, so this cannot return undefined. */
export function tradeProfile(trade: Trade): TradeProfile {
  return TRADE_PROFILES[trade];
}

/** Every trade the engine is configured to serve. */
export function allTrades(): Trade[] {
  return Object.keys(TRADE_PROFILES) as Trade[];
}

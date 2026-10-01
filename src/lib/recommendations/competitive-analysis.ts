import type { CompetitorSpec } from '~/lib/websearch/extract-competitor-spec';
import type { ChemistryClass } from '~/lib/recommendations/recommendation-gate';

/**
 * REC-6 — Competitive-analysis output template.
 *
 * Deterministically renders the agent's two deliverables: the recommendation (a linked Betco
 * product) and the head-to-head analysis that defends it. Every cell traces to a supplied,
 * grounded value — unknown fields render as "Not established" rather than being invented
 * (the BNC-15 failure fabricated competitor SKUs/specs). Also carries REC-3's output-side:
 * when both EPA registrations share a registrant prefix, that is cited as supporting evidence.
 */

const NOT_ESTABLISHED = 'Not established';

export type ProductSide = {
  chemistryClass?: ChemistryClass | null;
  epaRegistration?: string | null;
  contactTimeSeconds?: number | null;
  dilutionOzPerGal?: number | null;
};

export type CompetitiveAnalysisInput = {
  competitor: {
    brand?: string | null;
    productName: string;
    spec: CompetitorSpec;
    citations?: string[];
  };
  recommended: {
    name: string;
    url?: string | null;
  } & ProductSide;
};

function formatChemistry(value: ChemistryClass | null | undefined): string {
  return value ?? NOT_ESTABLISHED;
}

function formatEpa(value: string | null | undefined): string {
  return value ? `EPA Reg. ${value}` : NOT_ESTABLISHED;
}

function formatContactTime(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return NOT_ESTABLISHED;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} min`;
  }
  return `${seconds} sec`;
}

function formatDilution(oz: number | null | undefined): string {
  if (typeof oz !== 'number' || !Number.isFinite(oz) || oz <= 0) {
    return NOT_ESTABLISHED;
  }
  return `${oz} oz/gal`;
}

/** EPA registrant = the prefix before the first hyphen (e.g. 6836-348 → 6836). */
export function epaRegistrant(reg: string | null | undefined): string | null {
  if (!reg) return null;
  const prefix = reg.trim().split('-')[0]?.trim();
  return prefix ? prefix : null;
}

export function sharedEpaRegistrant(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const ra = epaRegistrant(a);
  const rb = epaRegistrant(b);
  return ra && rb && ra === rb ? ra : null;
}

function costInUseLine(competitorOz?: number | null, recommendedOz?: number | null): string {
  const comp = typeof competitorOz === 'number' && competitorOz > 0 ? competitorOz : null;
  const rec = typeof recommendedOz === 'number' && recommendedOz > 0 ? recommendedOz : null;

  if (comp && rec) {
    if (rec < comp) {
      const factor = Math.round((comp / rec) * 10) / 10;
      return `**Cost-in-use:** the Betco product dilutes at ${rec} oz/gal vs ${comp} oz/gal — about ${factor}× more dilute, i.e. lower cost-in-use.`;
    }
    if (rec > comp) {
      return `**Cost-in-use:** the Betco product dilutes at ${rec} oz/gal vs ${comp} oz/gal — more concentrated per gallon; confirm the use rate for the application.`;
    }
    return `**Cost-in-use:** both dilute at ${rec} oz/gal — comparable cost-in-use.`;
  }
  if (rec) {
    return `**Cost-in-use:** Betco dilution is ${rec} oz/gal; competitor dilution ${NOT_ESTABLISHED.toLowerCase()}.`;
  }
  return `**Cost-in-use:** comparison unavailable (dilution not established for both products).`;
}

export function formatCompetitiveAnalysis(input: CompetitiveAnalysisInput): string {
  const { competitor, recommended } = input;
  const competitorLabel = [competitor.brand, competitor.productName]
    .filter((part) => part && part.trim())
    .join(' ')
    .trim();
  const recommendedLead = recommended.url
    ? `Comparable Betco product: [${recommended.name}](${recommended.url})`
    : `Comparable Betco product: ${recommended.name}`;

  const rows: Array<[string, string, string]> = [
    [
      'Product type',
      formatChemistry(competitor.spec.chemistryClass),
      formatChemistry(recommended.chemistryClass),
    ],
    [
      'EPA registration',
      formatEpa(competitor.spec.epaRegistration),
      formatEpa(recommended.epaRegistration),
    ],
    [
      'Contact time',
      formatContactTime(competitor.spec.contactTimeSeconds),
      formatContactTime(recommended.contactTimeSeconds),
    ],
    [
      'Dilution',
      formatDilution(competitor.spec.dilutionOzPerGal),
      formatDilution(recommended.dilutionOzPerGal),
    ],
  ];

  const table = [
    `| Attribute | ${competitorLabel || 'Competitor'} | ${recommended.name} |`,
    '| --- | --- | --- |',
    ...rows.map(([attr, comp, rec]) => `| ${attr} | ${comp} | ${rec} |`),
  ].join('\n');

  const shared = sharedEpaRegistrant(
    competitor.spec.epaRegistration,
    recommended.epaRegistration,
  );
  const evidenceLines: string[] = [];
  if (shared) {
    evidenceLines.push(
      `- Same EPA registrant (${shared}): ${competitor.spec.epaRegistration} ↔ ${recommended.epaRegistration} — strong equivalence signal.`,
    );
  }
  if (
    competitor.spec.chemistryClass &&
    recommended.chemistryClass &&
    competitor.spec.chemistryClass === recommended.chemistryClass
  ) {
    evidenceLines.push(
      `- Same chemistry class (${recommended.chemistryClass}): like-for-like replacement.`,
    );
  }

  const citations =
    competitor.citations && competitor.citations.length > 0
      ? [
          '',
          '**Sources (competitor facts)**',
          ...competitor.citations.map((c) => `- ${c}`),
        ]
      : [];

  return [
    recommendedLead,
    '',
    '**Head-to-head**',
    '',
    table,
    ...(evidenceLines.length > 0 ? ['', '**Supporting evidence**', ...evidenceLines] : []),
    '',
    costInUseLine(
      competitor.spec.dilutionOzPerGal,
      recommended.dilutionOzPerGal,
    ),
    '',
    '**So what for sales:** lead with the shared registrant and matched chemistry to justify the swap, and use the cost-in-use delta to close. Confirm specifics with a Betco sales representative.',
    ...citations,
  ].join('\n');
}

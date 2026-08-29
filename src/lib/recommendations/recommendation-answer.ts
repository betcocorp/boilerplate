/**
 * REC-6 (live) — Deterministic competitive-recommendation answer for a curated cross-reference
 * match. Assembles the recommendation + a grounded "why" + a head-to-head + up to two alternatives
 * from facts we already hold (the curated override row + the recommended product's rag attributes),
 * so the output never depends on the model choosing the product or inventing specifics.
 */

const NOT_ESTABLISHED = 'Not established';

function registrant(epa: string | null | undefined): string | null {
  if (!epa) return null;
  const prefix = epa.trim().split('-')[0]?.trim();
  return prefix ? prefix : null;
}

export type CompetitiveRecommendationInput = {
  competitorLabel: string;
  recommendedTitle: string;
  recommendedUrl?: string | null;
  chemistryClass?: string | null;
  competitorEpa?: string | null;
  betcoEpa?: string | null;
  rationale?: string | null;
  /** Other same-chemistry Betco disinfectants; shown only when at least two are available. */
  alternatives?: { name: string }[];
};

export function buildCompetitiveRecommendationAnswer(
  input: CompetitiveRecommendationInput,
): string {
  const chem = input.chemistryClass?.trim() || null;
  const typeLabel = chem ? `${chem} one-step disinfectant` : 'one-step disinfectant';
  const lead = input.recommendedUrl?.trim()
    ? `Comparable Betco product: [${input.recommendedTitle}](${input.recommendedUrl})`
    : `Comparable Betco product: **${input.recommendedTitle}**`;

  const compReg = registrant(input.competitorEpa);
  const betReg = registrant(input.betcoEpa);
  const shared = compReg && betReg && compReg === betReg ? compReg : null;

  const table = [
    `| Attribute | ${input.competitorLabel || 'Competitor'} | ${input.recommendedTitle} |`,
    '| --- | --- | --- |',
    `| Product type | ${typeLabel} | ${typeLabel} |`,
    `| EPA registration | ${input.competitorEpa ?? NOT_ESTABLISHED} | ${input.betcoEpa ?? NOT_ESTABLISHED} |`,
  ];
  if (shared) {
    table.push(`| EPA registrant | ${compReg} | ${betReg} (shared) |`);
  }

  const why =
    input.rationale?.trim() ||
    `Both are ${chem ?? 'the same'}-chemistry one-step disinfectants${
      shared ? `, and they share EPA registrant ${shared}` : ''
    }.`;

  const parts: string[] = [
    lead,
    '',
    '**Why this is the match**',
    why,
    '',
    '**Head-to-head**',
    '',
    table.join('\n'),
  ];

  // Only surface alternatives when there are at least two.
  const alts = (input.alternatives ?? []).filter((a) => a.name?.trim()).slice(0, 2);
  if (alts.length >= 2) {
    parts.push(
      '',
      '**Other Betco options**',
      ...alts.map(
        (a) =>
          `- ${a.name.trim()}${chem ? ` — same ${chem} disinfectant chemistry` : ''}`,
      ),
    );
  }

  /**
   * B0-760 — the head-to-head table puts two EPA registrations side by side, which on its own
   * reads as "these kill the same things". They do not: organism claims attach to a specific
   * registration and label, and neither matching chemistry nor a shared registrant carries them
   * across. This block is unconditional because every answer this composer builds is a
   * disinfectant substitution, which is exactly where an assumed claim transfer does harm.
   */
  const competitorLabel = input.competitorLabel?.trim() || 'the competitor product';
  parts.push(
    '',
    '**Kill claims do not transfer**',
    `Organism claims are specific to each product's own EPA registration and label. ${input.recommendedTitle} covers only the organisms listed on its own label and efficacy data — a matching chemistry${
      shared ? ', or a shared registrant,' : ''
    } does not carry ${competitorLabel}'s claims across. Confirm every organism you need against ${input.recommendedTitle}'s label before substituting.`,
  );

  parts.push(
    '',
    'This is a recommendation for verification — confirm exact dilution, contact time, and safety on the product label or with a Betco sales representative.',
  );
  return parts.join('\n');
}

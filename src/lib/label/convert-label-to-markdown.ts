/**
 * B0-260: Label-to-Markdown conversion utility
 *
 * Converts HTML/PDF labels to structured markdown format for RAG ingestion.
 * Output format: # Product Name\n## Section Headers\n... [sections]
 *
 * This is a reusable, Bex-agnostic utility that can be imported by any service
 * needing to convert label data to structured markdown.
 */

export interface LabelConversionOptions {
  /** Product SKU or key for metadata */
  productKey?: string;
  /** Product title/name */
  productTitle?: string;
  /** Brand identifier: 'betco', '1950', 'basic_coatings', 'envirozyme' */
  brand?: string;
  /** EPA registration number (exact, no rounding) */
  epaRegNo?: string;
  /** Canadian DIN number (exact format) */
  dinNo?: string;
  /** Active ingredient concentration percentages (exact values) */
  activeIngredients?: Array<{
    name: string;
    casNumber?: string;
    concentration?: string; // e.g. "15.0%", "2.5 oz/gal"
  }>;
  /** Contact time in seconds (exact) */
  contactTimeSeconds?: number;
  /** Dilution ratio (exact: "oz/gal", "mL/L", "%", etc.) */
  dilutionRatio?: string;
  /** Photo URLs to reference in metadata */
  photoUrls?: string[];
}

export interface ConvertedLabel {
  markdown: string;
  metadata: {
    productKey?: string;
    productTitle?: string;
    brand?: string;
    epaRegNo?: string;
    dinNo?: string;
    photoUrls?: string[];
    activeIngredientsCount?: number;
    sections?: string[];
  };
}

/**
 * B0-876 — trademark marks (U+2122 ™, U+00AE ®, U+2120 ℠, and the ASCII "(TM)"/"(R)"/"(SM)"
 * spellings) are STRIPPED from an emitted product title, never mapped to a letter. The live corpus
 * carries a transliteration artefact from an upstream source ("Fight BacT RTU", "GREEN EARTHr") that
 * a letter-mapped symbol would reproduce; the H1 this converter emits is what downstream title and
 * alias tooling reads, so the guard sits at the point of emission. Only the marks are removed —
 * surrounding text, spacing and regulated values are untouched.
 */
const TRADEMARK_MARK_PATTERN = /[™®℠]|\((?:tm|r|sm)\)/gi;

export function stripTrademarkSymbols(value: string): string {
  return value.replace(TRADEMARK_MARK_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Convert label HTML/text to structured markdown.
 *
 * @param content HTML or text content of the label
 * @param options Metadata and conversion options
 * @returns Converted markdown with metadata
 */
export function convertLabelToMarkdown(
  content: string,
  options: LabelConversionOptions = {},
): ConvertedLabel {
  const sections: string[] = [];
  const markdown: string[] = [];

  // Add product name as H1 (trademark marks stripped — see `stripTrademarkSymbols`).
  const productTitle = options.productTitle ? stripTrademarkSymbols(options.productTitle) : undefined;
  if (productTitle) {
    markdown.push(`# ${productTitle}\n`);
    sections.push('Product Name');
  }

  // Add product identifiers as metadata block
  const identifiers: string[] = [];
  if (options.productKey) {
    identifiers.push(`- **Product Key:** ${options.productKey}`);
  }
  if (options.brand) {
    identifiers.push(`- **Brand:** ${options.brand}`);
  }
  if (options.epaRegNo) {
    identifiers.push(`- **EPA Registration:** ${options.epaRegNo}`);
  }
  if (options.dinNo) {
    identifiers.push(`- **DIN Number:** ${options.dinNo}`);
  }

  if (identifiers.length > 0) {
    markdown.push('## Product Information\n');
    markdown.push(identifiers.join('\n'));
    markdown.push('\n');
    sections.push('Product Information');
  }

  // Add active ingredients section
  if (options.activeIngredients && options.activeIngredients.length > 0) {
    markdown.push('## Active Ingredients\n');
    options.activeIngredients.forEach((ing) => {
      let line = `- **${ing.name}**`;
      if (ing.casNumber) {
        line += ` (CAS ${ing.casNumber})`;
      }
      if (ing.concentration) {
        line += `: ${ing.concentration}`;
      }
      markdown.push(line);
    });
    markdown.push('\n');
    sections.push('Active Ingredients');
  }

  // Add directions for use (if dilution or contact time present)
  const directionsLines: string[] = [];
  if (options.dilutionRatio) {
    directionsLines.push(`- **Dilution Ratio:** ${options.dilutionRatio}`);
  }
  if (options.contactTimeSeconds !== undefined && options.contactTimeSeconds > 0) {
    directionsLines.push(`- **Contact Time:** ${options.contactTimeSeconds} seconds`);
  }

  if (directionsLines.length > 0) {
    markdown.push('## Directions for Use\n');
    markdown.push(directionsLines.join('\n'));
    markdown.push('\n');
    sections.push('Directions for Use');
  }

  // Parse and extract sections from content (simple heuristic)
  // Look for common label section headers in the content
  const commonSections = [
    { pattern: /(?:HAZARD|WARNING|CAUTION|DANGER)S?\s*:?/i, header: '## Hazard Information' },
    { pattern: /(?:FIRST\s+)?AID\s+MEASURES/i, header: '## First Aid Measures' },
    { pattern: /EMERGENCY\s+(?:CONTACT|PHONE)/i, header: '## Emergency Contact' },
    { pattern: /DISPOSAL/i, header: '## Disposal' },
    { pattern: /STORAGE|HANDLING/i, header: '## Storage & Handling' },
    { pattern: /PRECAUTIONS|SAFE(?:TY)?/i, header: '## Safety Precautions' },
  ];

  // Extract common sections from content
  for (const { pattern, header } of commonSections) {
    const match = content.match(pattern);
    if (match) {
      sections.push(header.replace(/^## /, ''));
      markdown.push(`${header}\n`);

      // Find content until next section or end
      const startIdx = match.index! + match[0].length;
      const nextMatch = content.slice(startIdx).match(/(?:HAZARD|WARNING|CAUTION|DANGER|FIRST\s+AID|EMERGENCY|DISPOSAL|STORAGE|HANDLING|PRECAUTIONS|SAFE)/i);
      const endIdx = nextMatch ? startIdx + nextMatch.index! : content.length;

      let sectionContent = content.slice(startIdx, endIdx).trim();
      // Clean up common artifacts
      sectionContent = sectionContent
        .split('\n')
        .filter((line) => line.trim() && !line.match(/^\s*[-•]\s*$/))
        .join('\n')
        .slice(0, 500); // Limit section content

      if (sectionContent) {
        markdown.push(`${sectionContent}\n`);
      }
    }
  }

  // Add raw content if no sections extracted
  if (markdown.length === 0) {
    markdown.push(`## Label Content\n\n${content.slice(0, 1000)}\n`);
    sections.push('Label Content');
  }

  return {
    markdown: markdown.join(''),
    metadata: {
      productKey: options.productKey,
      productTitle,
      brand: options.brand,
      epaRegNo: options.epaRegNo,
      dinNo: options.dinNo,
      photoUrls: options.photoUrls,
      activeIngredientsCount: options.activeIngredients?.length,
      sections,
    },
  };
}

/**
 * Convert HTML label to markdown by stripping tags and preserving structure.
 *
 * @param htmlContent HTML string
 * @param options Conversion options
 * @returns Converted markdown
 */
export function convertHtmlLabelToMarkdown(
  htmlContent: string,
  options: LabelConversionOptions = {},
): ConvertedLabel {
  // Simple HTML tag stripping (production would use a proper HTML parser)
  const textContent = htmlContent
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article)>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n\s*\n\s*\n/g, '\n\n');

  return convertLabelToMarkdown(textContent, options);
}

/**
 * Convert PDF label text (as extracted via OCR or text extraction) to markdown.
 *
 * @param pdfText Text extracted from PDF
 * @param options Conversion options
 * @returns Converted markdown
 */
export function convertPdfLabelToMarkdown(
  pdfText: string,
  options: LabelConversionOptions = {},
): ConvertedLabel {
  // PDF text usually needs normalization (extra spaces, line breaks)
  const normalized = pdfText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return convertLabelToMarkdown(normalized, options);
}

/**
 * Helper: Extract active ingredients from label text (simple pattern matching).
 *
 * @param labelText Full label text
 * @returns Array of detected ingredients with CAS if found
 */
export function extractActiveIngredients(labelText: string): LabelConversionOptions['activeIngredients'] {
  const ingredients: LabelConversionOptions['activeIngredients'] = [];

  // Pattern: "Name ... CAS 12345-67-8 ... concentration"
  const casPattern = /(?:(?<!d)\d{4,}-\d{2}-\d)/g;
  const matches = labelText.matchAll(casPattern);

  for (const match of matches) {
    const casNumber = match[0];
    const context = labelText.slice(Math.max(0, match.index! - 100), match.index! + 100);

    // Try to extract ingredient name (word before CAS)
    const escapedCas = casNumber.replace(/[-]/g, '[\\-]');
    const nameMatch = context.match(
      new RegExp(`\\b([\\w\\s\\-]+?)\\s+(?:\\()?(?:CAS\\s+)?${escapedCas}`)
    );
    if (nameMatch) {
      ingredients.push({
        name: nameMatch[1]?.trim() || 'Unknown',
        casNumber,
      });
    }
  }

  return ingredients.length > 0 ? ingredients : [];
}

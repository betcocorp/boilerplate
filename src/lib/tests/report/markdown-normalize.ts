/**
 * Fixes a specific malformed pattern seen in raw agent responses (B0-613): a bare ordered-list
 * marker ("1.") on its own line immediately followed by a bold label on the next line. CommonMark
 * requires the marker and its content on one line, so renderers instead show the number alone
 * with the label and any following bullets breaking out of the list underneath it. Joins the
 * marker back onto its label's line and indents any immediately-following bullet lines so they
 * nest under the item instead of breaking out of the ordered list.
 */
export function normalizeAgentMarkdownLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const bareMarker = /^(\d+)\.\s*$/.exec(lines[i]!);
    const nextLine = lines[i + 1];
    if (bareMarker && nextLine?.trim()) {
      out.push(`${bareMarker[1]}. ${nextLine.trim()}`);
      let j = i + 2;
      while (j < lines.length && /^[-*]\s/.test(lines[j]!)) {
        out.push(`   ${lines[j]}`);
        j += 1;
      }
      i = j - 1;
      continue;
    }
    out.push(lines[i]!);
  }

  return out.join('\n');
}

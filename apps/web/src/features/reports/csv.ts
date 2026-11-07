/**
 * Escapes a CSV cell and neutralizes spreadsheet formulas in untrusted text.
 * Numeric report values remain unchanged.
 */
export function csvCell(value: string | number): string {
  const text = String(value);
  // Formula triggers (OWASP): = + - @, also after spaces, and a leading tab or carriage return.
  const safeText =
    typeof value === 'string' && /^(\s*[=+\-@]|[\t\r])/.test(text) ? `'${text}` : text;

  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

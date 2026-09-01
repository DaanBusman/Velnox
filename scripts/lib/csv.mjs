/**
 * Minimal RFC 4180 CSV reader.
 *
 * Written rather than pulled in as a dependency: the glossary is the one file a
 * non-developer translator edits by hand in a spreadsheet, so its parser needs
 * to behave exactly like a spreadsheet's — quoted fields, doubled quotes, commas
 * and newlines inside quotes — and nothing more.
 */

/**
 * @param {string} text
 * @returns {string[][]} rows of raw cell values
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM: Excel writes one, and it would corrupt the first header.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // handled by the \n branch
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }

  if (inQuotes) {
    throw new Error('Unterminated quoted field: the file ends inside a quoted value.');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * @param {string} text
 * @returns {{ header: string[], rows: Record<string,string>[], lineOf: (i:number)=>number }}
 */
export function parseCsvObjects(text) {
  const raw = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (raw.length === 0) throw new Error('File is empty.');
  const header = raw[0];
  const rows = raw.slice(1).map((cells) => {
    /** @type {Record<string,string>} */
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = cells[idx] ?? '';
    });
    obj.__cellCount = String(cells.length);
    return obj;
  });
  return { header, rows, lineOf: (i) => i + 2 };
}

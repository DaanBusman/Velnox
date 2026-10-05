import { describe, expect, it } from 'vitest';
import { csvCell } from './audit-query.service';

describe('csvCell', () => {
  it('leaves plain text alone and empties null', () => {
    expect(csvCell('auth.login.succeeded')).toBe('auth.login.succeeded');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('never lets a value become a spreadsheet formula', () => {
    // An actor label or resource name is chosen by whoever created it.
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('writes objects as JSON', () => {
    expect(csvCell({ permission: 'audit.read' })).toBe('"{""permission"":""audit.read""}"');
  });
});

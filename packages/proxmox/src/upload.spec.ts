import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { multipartEnvelope, multipartStream } from './upload';

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe('the upload envelope', () => {
  const file = Buffer.from('CD001-pretend-this-is-an-iso');

  const envelope = multipartEnvelope({
    fields: { content: 'iso', 'checksum-algorithm': 'sha256', checksum: 'ab'.repeat(32) },
    fileField: 'filename',
    filename: 'Win11_25H2_Dutch_x64.iso',
    fileSize: file.length,
    boundary: 'BOUNDARY',
  });

  it('states exactly the number of bytes it sends', async () => {
    // pveproxy refuses an upload it cannot size, and a Content-Length that is
    // off by one hangs the request until the idle timeout.
    const body = await collect(multipartStream(envelope, Readable.from([file])));
    expect(body.length).toBe(envelope.length);
  });

  it('puts every field before the file, which pveproxy reads as it arrives', async () => {
    const body = (await collect(multipartStream(envelope, Readable.from([file])))).toString('utf8');
    const fileAt = body.indexOf('name="filename"');
    for (const field of ['name="content"', 'name="checksum-algorithm"', 'name="checksum"']) {
      expect(body.indexOf(field)).toBeGreaterThan(-1);
      expect(body.indexOf(field)).toBeLessThan(fileAt);
    }
    expect(body).toContain('filename="Win11_25H2_Dutch_x64.iso"');
    expect(body.endsWith('\r\n--BOUNDARY--\r\n')).toBe(true);
  });

  it('carries the file byte for byte, however it is chunked', async () => {
    const chunked = Readable.from([file.subarray(0, 3), file.subarray(3, 10), file.subarray(10)]);
    const body = await collect(multipartStream(envelope, chunked));
    const start = envelope.head.length;
    expect(body.subarray(start, start + file.length).equals(file)).toBe(true);
  });

  it('reports file bytes only, so progress reaches the size and not beyond', async () => {
    const seen: number[] = [];
    await collect(
      multipartStream(envelope, Readable.from([file.subarray(0, 5), file.subarray(5)]), (n) =>
        seen.push(n),
      ),
    );
    expect(seen).toEqual([5, file.length]);
  });

  it('still produces a well-formed body for an empty file', async () => {
    const empty = multipartEnvelope({
      fields: { content: 'iso' },
      fileField: 'filename',
      filename: 'e.iso',
      fileSize: 0,
    });
    const body = await collect(multipartStream(empty, Readable.from([])));
    expect(body.length).toBe(empty.length);
  });

  it.each([
    ['a quote in the filename', { filename: 'a".iso' }],
    ['a newline in the filename', { filename: 'a\r\nX-Evil: 1.iso' }],
    ['a newline in a field', { fields: { content: 'iso\r\n--x' } }],
  ])('refuses %s rather than escaping it', (_why, override) => {
    expect(() =>
      multipartEnvelope({
        fields: { content: 'iso' },
        fileField: 'filename',
        filename: 'a.iso',
        fileSize: 1,
        ...override,
      }),
    ).toThrow();
  });

  it('passes a read error through instead of sending a short file', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('disk went away'));
      },
    });
    await expect(collect(multipartStream(envelope, broken))).rejects.toThrow('disk went away');
  });
});

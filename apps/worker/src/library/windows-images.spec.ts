import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWimXml, readWindowsImages } from './windows-images';

/*
 * The UDF walk is proven against ISOs built by genisoimage around WIMs built by
 * wimlib — see scripts/verify-provisioning.sh — because a fixture ISO is too
 * large to keep in the repository. Here: the XML, and the refusals.
 */

const XML = `<WIM><TOTALBYTES>123</TOTALBYTES>
<IMAGE INDEX="2"><NAME>Windows 11 Pro</NAME><DISPLAYNAME>Windows 11 Pro</DISPLAYNAME>
<WINDOWS><ARCH>9</ARCH><EDITIONID>Professional</EDITIONID><LANGUAGES><LANGUAGE>nl-NL</LANGUAGE><DEFAULT>nl-NL</DEFAULT></LANGUAGES></WINDOWS></IMAGE>
<IMAGE INDEX="1"><NAME>Windows 11 Home</NAME><WINDOWS><ARCH>9</ARCH><EDITIONID>Core</EDITIONID><LANGUAGES><LANGUAGE>nl-NL</LANGUAGE></LANGUAGES></WINDOWS></IMAGE>
<IMAGE INDEX="3"><NAME>Windows Server 2025 Standard (Desktop Experience) &amp; more</NAME><WINDOWS><ARCH>12</ARCH></WINDOWS></IMAGE>
<IMAGE INDEX="4"><DESCRIPTION>no name</DESCRIPTION></IMAGE>
</WIM>`;

describe('parseWimXml', () => {
  const images = parseWimXml(XML);

  it('lists named images in index order', () => {
    expect(images.map((i) => i.index)).toEqual([1, 2, 3]);
  });

  it('reads name, edition, architecture and languages', () => {
    expect(images[1]).toEqual({
      index: 2,
      name: 'Windows 11 Pro',
      displayName: 'Windows 11 Pro',
      editionId: 'Professional',
      architecture: 'x64',
      languages: ['nl-NL'],
    });
    expect(images[2]!.architecture).toBe('arm64');
  });

  it('decodes entities, so the name matches what Setup compares', () => {
    expect(images[2]!.name).toBe('Windows Server 2025 Standard (Desktop Experience) & more');
  });
});

describe('readWindowsImages', () => {
  it('gives null for a file that is not a UDF disc, rather than a guess', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velnox-win-'));
    try {
      const path = join(dir, 'x.iso');
      await writeFile(path, Buffer.alloc(600 * 1024));
      expect(await readWindowsImages(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

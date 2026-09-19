import { describe, it } from 'node:test';
import assert from 'node:assert';
import CustomHelp, { BANNER } from '../help.js';

describe('Custom Help & ASCII Art (src/help.ts)', () => {
  it('defines an ASCII banner containing eB-CLI representation', () => {
    assert.ok(BANNER);
    assert.ok(BANNER.includes('____'));
    assert.ok(BANNER.includes('| |'));
  });

  it('prepends ASCII art banner to formatRoot', () => {
    const mockConfig: any = {
      bin: 'eb',
      userAgent: 'eb-cli/0.1.0-alpha.43',
      pjson: {
        oclif: {},
      },
    };

    const help = new CustomHelp(mockConfig);
    const output = help.formatRoot();

    assert.ok(output.startsWith(BANNER));
    assert.ok(output.includes('USAGE'));
    assert.ok(output.includes('$ eb [COMMAND]'));
  });
});

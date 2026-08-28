import { describe, it } from 'node:test';
import assert from 'node:assert';
import defaultUpdateChannel from '../hooks/preparse/default-update-channel.js';

describe('Preparse Hooks (src/hooks/preparse/default-update-channel.ts)', () => {
  const updateFlags = {
    autoupdate: {},
    available: {},
    interactive: {},
    version: {},
  };

  it('returns argv unchanged for non-update commands', async () => {
    const context: any = {
      argv: ['session', 'list', '--json'],
      config: { channel: 'alpha' },
      options: { flags: { username: {} } },
    };

    const result = await defaultUpdateChannel.call({} as any, context);
    assert.deepStrictEqual(result, ['session', 'list', '--json']);
  });

  it('returns argv unchanged when options.flags is missing or incomplete', async () => {
    const context: any = {
      argv: ['some', 'command'],
      config: { channel: 'stable' },
      options: {},
    };

    const result = await defaultUpdateChannel.call({} as any, context);
    assert.deepStrictEqual(result, ['some', 'command']);
  });

  it('respects explicit channel positional argument if already provided', async () => {
    const context: any = {
      argv: ['beta', '--available'],
      config: { channel: 'alpha' },
      options: { flags: updateFlags },
    };

    const result = await defaultUpdateChannel.call({} as any, context);
    assert.deepStrictEqual(result, ['beta', '--available']);
  });

  it('defaults to config.channel when update command is invoked without positional channel', async () => {
    const context: any = {
      argv: ['--interactive', '--version'],
      config: { channel: 'alpha' },
      options: { flags: updateFlags },
    };

    const result = await defaultUpdateChannel.call({} as any, context);
    assert.deepStrictEqual(result, ['alpha', '--interactive', '--version']);
  });

  it('prepends channel when argv is empty for update command', async () => {
    const context: any = {
      argv: [],
      config: { channel: 'stable' },
      options: { flags: updateFlags },
    };

    const result = await defaultUpdateChannel.call({} as any, context);
    assert.deepStrictEqual(result, ['stable']);
  });
});

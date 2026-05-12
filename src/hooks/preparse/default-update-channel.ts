import type { Hook } from '@oclif/core';

const defaultUpdateChannel: Hook.Preparse = async function ({ argv, config, options }) {
  // Detect the plugin-update command by its unique hidden/public flag set.
  const flags = options.flags ?? {};
  const isUpdateCommand =
    'autoupdate' in flags && 'available' in flags && 'interactive' in flags && 'version' in flags;

  if (!isUpdateCommand) {
    return argv;
  }

  // Respect explicit channel argument if already provided.
  const firstPositional = argv.find((arg) => !arg.startsWith('-'));
  if (firstPositional) {
    return argv;
  }

  // Default to the build channel derived by oclif from the installed version.
  // Example: 1.2.3-alpha.4 => alpha, 1.2.3-beta.1 => beta, 1.2.3 => stable.
  return [config.channel, ...argv];
};

export default defaultUpdateChannel;

import { Help } from '@oclif/core';

export const BANNER = [
  '       ____           ____ _     ___ ',
  '  ___ | __ )         / ___| |   |_ _|',
  ' / _ \\|  _ \\  _____ | |   | |    | | ',
  '|  __/| |_) ||_____|| |___| |___ | | ',
  ' \\___||____/         \\____|_____|___|',
].join('\n');

export default class CustomHelp extends Help {
  override formatRoot(): string {
    const root = super.formatRoot();
    return `${BANNER}\n\n${root}`;
  }
}

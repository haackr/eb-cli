import { Args, Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import * as fs from 'node:fs';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { processSchemaToMarkdown } from '../../lib/eb-puppetmaster/process-schema-doc.js';
import {
  compactProcessSchema,
  fetchProcessSchema,
  getCachedProcessSchema,
  type CompactProcessSchema,
  type ProcessSchema,
} from '../../lib/eb-puppetmaster/process-schema.js';

export default class ProcessInspect extends BaseSessionCommand {
  static override description =
    'inspect and project compact, token-efficient schema of an e-Builder process (fields, workflow, layout matrix)';
  static override examples = [
    '<%= config.bin %> <%= command.id %> "Commitment Change Order" --json',
    '<%= config.bin %> <%= command.id %> "Invoice" --refresh --json',
    '<%= config.bin %> <%= command.id %> "Submittal" --compact',
    '<%= config.bin %> <%= command.id %> "Submittal" --markdown -o submittal.md',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['process:schema'];

  static override args = {
    process: Args.string({
      description: 'Name of the e-Builder Process Type (e.g. "Commitment Change Order")',
      required: true,
    }),
  };

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    cached: Flags.boolean({
      description: 'use locally cached schema from SQLite if available (default: true)',
      default: true,
      allowNo: true,
    }),
    refresh: Flags.boolean({
      description: 'force live refresh from e-Builder and update cache',
      default: false,
    }),
    compact: Flags.boolean({
      description: 'output ultra-compact field and step summary',
      default: false,
      exclusive: ['markdown'],
    }),
    markdown: Flags.boolean({
      char: 'm',
      description:
        'output human-readable Markdown documentation: workflow diagram (Mermaid), steps with actions and field assignments, data fields, and field access by layout',
      default: false,
      exclusive: ['compact'],
    }),
    'output-file': Flags.string({
      char: 'o',
      description: 'write the output to this file instead of stdout',
    }),
  };

  public async run(): Promise<
    ProcessSchema | CompactProcessSchema | { markdown: string; outputFile?: string } | void
  > {
    const { args, flags } = await this.parse(ProcessInspect);

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const useCache = flags.cached && !flags.refresh;

    const emit = (schema: ProcessSchema) => {
      if (flags.markdown) {
        const markdown = processSchemaToMarkdown(schema);
        if (flags['output-file']) {
          fs.writeFileSync(flags['output-file'], markdown);
          if (!this.jsonEnabled()) this.log(`Wrote ${flags['output-file']}`);
          return { markdown, outputFile: flags['output-file'] };
        }
        if (!this.jsonEnabled()) this.log(markdown);
        return { markdown };
      }
      const out = flags.compact ? compactProcessSchema(schema) : schema;
      const text = JSON.stringify(out, null, 2);
      if (flags['output-file']) {
        fs.writeFileSync(flags['output-file'], text + '\n');
        if (!this.jsonEnabled()) this.log(`Wrote ${flags['output-file']}`);
      } else if (!this.jsonEnabled()) {
        this.log(text);
      }
      return out;
    };

    if (useCache) {
      const cached = getCachedProcessSchema(session.environment, session.account, args.process);
      if (cached) {
        const out = emit(cached);
        return this.jsonEnabled() ? out : undefined;
      }
    }

    const headless = !flags['show-browser'];
    try {
      const schema = await this.withSessionCookies(session.id, headless, (cookies) =>
        fetchProcessSchema({
          env,
          cookies,
          processName: args.process,
          account: session.account,
          useCache: false,
        }),
      );
      const out = emit(schema);
      return this.jsonEnabled() ? out : undefined;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}

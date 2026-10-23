import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import * as db from '../../lib/db.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

function parseArgValue(rawArg?: string): unknown {
  if (rawArg === undefined) return undefined;
  try {
    return JSON.parse(rawArg);
  } catch {
    return rawArg;
  }
}

export default class SessionExec extends BaseSessionCommand {
  static override summary =
    'Execute JavaScript or Puppeteer automation in an authenticated e-Builder session';
  static override description =
    'Navigate to an e-Builder path or URL using a stored session (headless by default) and evaluate a DOM or Puppeteer script. Automatically resolves environment URLs and refreshes session cookies.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> /da2/Processes/ProcessesView.aspx --eval "document.title" --json',
    '<%= config.bin %> <%= command.id %> /da2/Setup/Processes/ProcessTypesView.aspx --script-file extract-types.js --json',
    '<%= config.bin %> <%= command.id %> /da2/Processes/ImportProcesses/ImportProcesses.aspx --puppeteer --script-file inspect-step2.js --arg \'{"file":"./dummy.xlsx"}\' --json',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['session:exec', 'exec'];

  static override args = {
    url: Args.string({
      description:
        'e-Builder relative path (e.g. /da2/Processes/ProcessesView.aspx) or full URL (defaults to Home)',
      required: false,
    }),
  };

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    eval: Flags.string({
      char: 'e',
      description: 'JavaScript snippet or function to evaluate',
      exclusive: ['script-file'],
    }),
    'script-file': Flags.string({
      char: 'f',
      description: 'Path to a JavaScript file to evaluate',
      exclusive: ['eval'],
    }),
    puppeteer: Flags.boolean({
      char: 'p',
      description:
        'Run script in Node Puppeteer context ({ page, browser, context, env, origin, url, arg, settle }) instead of browser DOM context',
      default: false,
    }),
    arg: Flags.string({
      char: 'a',
      description: 'JSON (or string) argument passed to the evaluated script function',
    }),
    'wait-for': Flags.string({
      char: 'w',
      description: 'CSS selector to wait for (in main document or #contentFrame) before evaluating',
    }),
    screenshot: Flags.string({
      description: 'Save a full-page PNG screenshot to this file path after execution',
    }),
    'screenshot-on-failure': Flags.boolean({
      description: 'Capture screenshot on execution or wait-for error (default: true)',
      default: true,
      allowNo: true,
    }),
    inspect: Flags.boolean({
      char: 'i',
      description:
        'Inspect and extract page structure (forms, fields, buttons, tables) into structured JSON AST',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SessionExec);

    let session: any;
    let env: eb.Environment | undefined;

    try {
      let scriptContent: string | undefined = flags.eval;
      if (flags['script-file']) {
        if (!fs.existsSync(flags['script-file'])) {
          this.error(`Script file not found: ${flags['script-file']}`);
        }
        scriptContent = fs.readFileSync(flags['script-file'], 'utf8');
      }

      const headless = !flags['show-browser'];
      session = await this.getSession(flags);
      env = eb.getEnvironment(session.environment);
      const cookies = await this.getSessionCookies(session.id, headless);
      const parsedArg = parseArgValue(flags.arg);

      const execResult = await eb.executeInSession({
        env,
        cookies,
        headless,
        url: args.url,
        waitForSelector: flags['wait-for'],
        script: scriptContent,
        mode: flags.puppeteer ? 'puppeteer' : 'dom',
        arg: parsedArg,
        screenshotPath: flags.screenshot,
        screenshotOnFailure: flags['screenshot-on-failure'],
        inspect: flags.inspect,
      });

      if (execResult.cookies && execResult.cookies.length > 0) {
        db.updateSessionCookies(session.id, JSON.stringify(execResult.cookies));
      }

      const payload = {
        success: true,
        session: {
          id: session.id,
          username: session.username,
          environment: session.environment,
          origin: `https://${env}.${eb.baseurl}`,
          account: session.account,
        },
        url: execResult.url,
        title: execResult.title,
        frameUrl: execResult.frameUrl,
        screenshotPath: execResult.screenshotPath,
        inspection: execResult.inspection,
        result: execResult.result,
      };

      if (this.jsonEnabled()) {
        return payload;
      }

      if (flags.inspect && execResult.inspection) {
        this.log(JSON.stringify(execResult.inspection, null, 2));
      } else if (typeof execResult.result === 'string') {
        this.log(execResult.result);
      } else {
        this.log(JSON.stringify(execResult.result, null, 2));
      }

      return payload;
    } catch (err: any) {
      if (this.jsonEnabled()) {
        return {
          success: false,
          error: {
            code: err.code || err.name || 'EXECUTION_FAILED',
            message: err.message || 'Execution in session failed',
            stack: err.stack,
          },
          session: session
            ? {
                id: session.id,
                username: session.username,
                environment: session.environment,
                origin: env ? `https://${env}.${eb.baseurl}` : undefined,
                account: session.account,
              }
            : undefined,
          url: err.url || (args.url && env ? eb.resolveSessionUrl(env, args.url) : undefined),
          title: err.title || '',
          frameUrl: err.frameUrl || null,
          screenshotPath: err.screenshotPath || null,
        };
      }
      throw err;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}

import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import * as db from '../../lib/db.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

function isLocalScriptPath(value: string): boolean {
  return /\.(m?js|cjs|ts)$/i.test(value) && !/^https?:\/\//i.test(value) && fs.existsSync(value);
}

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
    'Navigate to an e-Builder path or URL using a stored session (headless by default) and evaluate a DOM or Puppeteer script. Automatically resolves environment URLs, verifies the session on the target navigation, and saves refreshed cookies. Errors report a typed code (SessionExpiredError, NetworkError, NavigationTimeoutError) so network problems are not mistaken for logouts.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> /da2/Processes/ProcessesMain.aspx --eval "document.title" --json',
    '<%= config.bin %> <%= command.id %> --account prod --url /da2/Home/index2.aspx --file ./script.js --json',
    '<%= config.bin %> <%= command.id %> ./script.js --account uat --json',
    '<%= config.bin %> <%= command.id %> /da2/Setup/Processes/ProcessTypesView.aspx --script-file extract-types.js --json',
    '<%= config.bin %> <%= command.id %> /da2/Processes/ImportProcesses/ImportProcesses.aspx --puppeteer --script-file inspect-step2.js --arg \'{"file":"./dummy.xlsx"}\' --json',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['session:exec', 'exec'];

  static override args = {
    url: Args.string({
      description:
        'e-Builder relative path (e.g. /da2/Processes/ProcessesMain.aspx) or full URL (defaults to Home)',
      required: false,
    }),
  };

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    eval: Flags.string({
      char: 'e',
      aliases: ['script'],
      description: 'JavaScript snippet or function to evaluate (alias: --script)',
      exclusive: ['script-file'],
    }),
    'script-file': Flags.string({
      char: 'f',
      aliases: ['file'],
      description:
        'Path to a JavaScript file to evaluate (alias: --file). `export default` / `module.exports =` wrappers are accepted.',
      exclusive: ['eval'],
    }),
    url: Flags.string({
      description:
        'e-Builder relative path or full URL (alternative to the positional URL argument)',
    }),
    puppeteer: Flags.boolean({
      char: 'p',
      description:
        'Run script in Node Puppeteer context ({ page, browser, context, env, origin, url, arg, args, fs, path, os, eb, settle, inspect }). Auto-detected when omitted; use --no-puppeteer to force DOM mode.',
      allowNo: true,
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
    'dialog-policy': Flags.string({
      description:
        'How to answer alert/confirm/prompt dialogs. "manual" leaves them to your script; a Puppeteer script with its own page.on("dialog") listener always takes precedence.',
      options: ['dismiss', 'accept', 'manual'],
      default: 'dismiss',
    }),
    inspect: Flags.boolean({
      description:
        'Inspect and extract page structure (forms, fields, buttons, tables) into structured JSON AST',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SessionExec);

    let session: any;
    let env: eb.Environment | undefined;
    let resolvedUrl: string | undefined = flags.url ?? args.url;

    try {
      if (flags.url && args.url && flags.url !== args.url && !isLocalScriptPath(args.url)) {
        this.error(`Conflicting URLs: positional "${args.url}" and --url "${flags.url}".`);
      }
      let targetUrl: string | undefined = flags.url ?? args.url;
      let scriptFile = flags['script-file'];

      // `eb exec /tmp/script.js` — treat a positional local script path as --script-file.
      if (args.url && isLocalScriptPath(args.url) && !scriptFile && flags.eval === undefined) {
        scriptFile = args.url;
        targetUrl = flags.url;
      }
      resolvedUrl = targetUrl;

      let scriptContent: string | undefined = flags.eval;
      if (scriptFile) {
        if (!fs.existsSync(scriptFile)) {
          this.error(`Script file not found: ${scriptFile}`);
        }
        scriptContent = fs.readFileSync(scriptFile, 'utf8');
      }

      let mode: eb.ExecuteInSessionMode = flags.puppeteer ? 'puppeteer' : 'dom';
      if (
        flags.puppeteer === undefined &&
        scriptContent &&
        eb.looksLikePuppeteerScript(scriptContent)
      ) {
        mode = 'puppeteer';
        process.stderr.write(
          'eb exec: script uses the Puppeteer context ({ page, eb, fs, ... } or page.*); running with --puppeteer. Pass --no-puppeteer to force DOM mode.\n',
        );
      }

      const headless = !flags['show-browser'];
      session = await this.getSession(flags);
      env = eb.getEnvironment(session.environment);
      // No pre-flight browser check: executeInSession verifies auth on the target navigation
      // itself and returns refreshed cookies, saving a full extra page load per invocation.
      const storedCookies = await this.getSessionCookies(session.id, headless, {
        skipRefresh: true,
      });
      const parsedArg = parseArgValue(flags.arg);

      const runExec = (cookies: any[]) =>
        eb.executeInSession({
          env: env!,
          cookies,
          headless,
          url: targetUrl,
          waitForSelector: flags['wait-for'],
          script: scriptContent,
          mode,
          dialogPolicy: flags['dialog-policy'] as eb.DialogPolicy,
          arg: parsedArg,
          screenshotPath: flags.screenshot,
          screenshotOnFailure: flags['screenshot-on-failure'],
          inspect: flags.inspect,
        });

      let execResult: eb.ExecuteInSessionResult;
      try {
        execResult = await runExec(storedCookies);
      } catch (err: any) {
        if (err?.reason !== 'redirected_to_login') throw err;
        // Cookies were rejected: try an autonomous re-login (1Password/Bitwarden) once.
        const relogged = await this.reloginWithCredentialProvider(session.id, headless);
        if (!relogged) throw err;
        execResult = await runExec(relogged);
      }

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
        httpStatus: execResult.httpStatus,
        dialogs: execResult.dialogs,
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
            reason: err.reason,
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
          url: err.url || (resolvedUrl && env ? eb.resolveSessionUrl(env, resolvedUrl) : undefined),
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

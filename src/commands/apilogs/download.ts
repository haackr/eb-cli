import { Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';

type JsonlLogRecord = {
  summary: {
    page: number;
    rowOnPage: number;
    userName: string;
    supportId: string;
    requestTimeUtc: string;
    responseTimeUtc: string;
    success: boolean;
    detailsId: string;
  };
  detail: {
    userName: string | null;
    machineName: string | null;
    supportId: string | null;
    userIp: string | null;
    requestUri: string | null;
    requestMethod: string | null;
    requestBody: string | null;
    requestTime: string | null;
    responseBody: string | null;
    responseTime: string | null;
    responseCode: string | null;
    success: string | null;
  };
};

function getDefaultOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), `api-logs-${timestamp}.jsonl`);
}

export default class ApiLogsDownload extends BaseSessionCommand {
  static override summary = 'Download e-Builder API logs to JSONL';
  static override description =
    'Download API logs from e-Builder, including modal details, across paginated pages';
  static override examples = [
    'eb apilogs download --session-id 1',
    'eb apilogs download --username myuser --pages 10 --output-file ./api-logs.jsonl',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    pages: Flags.integer({
      char: 'p',
      description: 'Number of pages to download from the API logs table',
      default: 10,
      min: 1,
    }),
    'output-file': Flags.string({
      char: 'o',
      description: 'Path to output JSONL file (one log record per line)',
      default: getDefaultOutputPath(),
    }),
    overwrite: Flags.boolean({
      description: 'Overwrite output file if it already exists',
      default: false,
    }),
  };

  public async run(): Promise<{
    outputFile: string;
    pagesRequested: number;
    pagesProcessed: number;
    recordsDownloaded: number;
  } | void> {
    const { flags } = await this.parse(ApiLogsDownload);

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const outputFile = path.resolve(flags['output-file']);

    if (fs.existsSync(outputFile) && !flags.overwrite) {
      this.error(
        `Output file already exists: ${outputFile}. Use --overwrite to replace it or choose a different --output-file.`,
      );
    }

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });

    const cookies = await this.getSessionCookies(session.id, !flags['show-browser']);
    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1600,1000'] : undefined,
    );

    const outputStream = fs.createWriteStream(outputFile, { encoding: 'utf8', flags: 'w' });

    let recordsDownloaded = 0;
    const spinner = this.jsonEnabled()
      ? null
      : ora(`Downloading API logs (pages: ${flags.pages})`).start();

    try {
      const result = await eb.downloadApiLogs({
        env,
        cookies,
        browser,
        pages: flags.pages,
        onPageStart: async (pageNumber) => {
          if (spinner) {
            spinner.text = `Downloading API logs (page ${pageNumber}/${flags.pages}, records: ${recordsDownloaded})`;
          }
        },
        onRecord: async (record: JsonlLogRecord) => {
          outputStream.write(`${JSON.stringify(record)}\n`);
          recordsDownloaded++;

          if (spinner && recordsDownloaded % 10 === 0) {
            spinner.text = `Downloading API logs (records: ${recordsDownloaded})`;
          }
        },
      });

      await new Promise<void>((resolve, reject) => {
        outputStream.end((err: NodeJS.ErrnoException | null) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });

      await eb.BrowserManager.getInstance().closeBrowser();

      if (spinner) {
        spinner.succeed(
          `Downloaded ${result.recordsDownloaded} API logs from ${result.pagesProcessed} pages to ${outputFile}`,
        );
      }

      if (this.jsonEnabled()) {
        return {
          outputFile,
          pagesRequested: flags.pages,
          pagesProcessed: result.pagesProcessed,
          recordsDownloaded: result.recordsDownloaded,
        };
      }
    } catch (error) {
      outputStream.destroy();
      await eb.BrowserManager.getInstance().closeBrowser();
      throw error;
    }
  }
}

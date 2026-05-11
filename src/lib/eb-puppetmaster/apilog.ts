import puppeteer from 'puppeteer';
import { BrowserManager, Environment, baseurl } from './index.js';

export type ApiLogSummary = {
  page: number;
  rowOnPage: number;
  userName: string;
  supportId: string;
  requestTimeUtc: string;
  responseTimeUtc: string;
  success: boolean;
  detailsId: string;
};

export type ApiLogDetail = {
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

export type ApiLogRecord = {
  summary: ApiLogSummary;
  detail: ApiLogDetail;
};

export type DownloadApiLogsArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  pages: number;
  onPageStart?: (page: number) => void | Promise<void>;
  onRecord?: (record: ApiLogRecord) => void | Promise<void>;
};

export type DownloadApiLogsResult = {
  pagesProcessed: number;
  recordsDownloaded: number;
};

const apiLogsTableSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults, table.TableGrid';
const dataRowSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults tr.RowData, #ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults tr.AltRowData';

function parseDetailsId(onclickValue: string): string {
  const match = /openLogDetails\('([^']+)'\)/.exec(onclickValue);
  if (!match?.[1]) {
    throw new Error(`Unable to parse details id from onclick: ${onclickValue}`);
  }

  return match[1];
}

function parseSuccess(input: string): boolean {
  return input.trim().toLowerCase() === 'true';
}

function isDetachedFrameError(error: unknown): boolean {
  return error instanceof Error && /detached frame/i.test(error.message);
}

async function extractSummariesForCurrentPage(
  page: puppeteer.Page,
  pageNumber: number,
): Promise<ApiLogSummary[]> {
  return await page
    .$$eval(
      dataRowSelector,
      (rows, currentPage) => {
        return rows.map((row, index) => {
          const cells = Array.from(row.querySelectorAll('td'));
          const detailsAnchor = cells[5]?.querySelector('a');
          const onclickValue = detailsAnchor?.getAttribute('onclick') || '';

          return {
            page: currentPage,
            rowOnPage: index + 1,
            userName: cells[0]?.textContent?.trim() || '',
            supportId: cells[1]?.textContent?.trim() || '',
            requestTimeUtc: cells[2]?.textContent?.trim() || '',
            responseTimeUtc: cells[3]?.textContent?.trim() || '',
            success: (cells[4]?.textContent?.trim() || '').toLowerCase() === 'true',
            onclickValue,
          };
        });
      },
      pageNumber,
    )
    .then((rows) =>
      rows.map((row) => ({
        page: row.page,
        rowOnPage: row.rowOnPage,
        userName: row.userName,
        supportId: row.supportId,
        requestTimeUtc: row.requestTimeUtc,
        responseTimeUtc: row.responseTimeUtc,
        success: row.success,
        detailsId: parseDetailsId(row.onclickValue),
      })),
    );
}

async function openDetailAndRead(
  page: puppeteer.Page,
  detailsId: string,
  expectedSupportId: string,
): Promise<ApiLogDetail> {
  const readDetailFromPage = async (detailPage: puppeteer.Page): Promise<ApiLogDetail> => {
    await detailPage.waitForFunction(
      (expectedId) => {
        const supportIdInput = document.querySelector(
          '[id$="_tbSupportId"]',
        ) as HTMLInputElement | null;

        if (!supportIdInput) return false;
        if (!supportIdInput.value.trim()) return false;
        if (!expectedId) return true;

        return supportIdInput.value.trim() === expectedId;
      },
      { timeout: 20_000 },
      expectedSupportId,
    );

    return await detailPage.evaluate(() => {
      const getValue = (suffix: string): string | null => {
        const el = document.querySelector(`[id$="${suffix}"]`) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        if (!el) return null;
        return el.value ?? null;
      };

      const requestUriLink = document.querySelector(
        '[id$="_hrefRequestUri"]',
      ) as HTMLAnchorElement | null;

      return {
        userName: getValue('_tbUserName'),
        machineName: getValue('_tbMachineName'),
        supportId: getValue('_tbSupportId'),
        userIp: getValue('_tbUserIp'),
        requestUri: requestUriLink?.href || null,
        requestMethod: getValue('_tbRequestMethod'),
        requestBody: getValue('_tbRequestBody'),
        requestTime: getValue('_tbRequestTime'),
        responseBody: getValue('_tbResponseBody'),
        responseTime: getValue('_tbResponseTime'),
        responseCode: getValue('_tbResponseStatusCode'),
        success: getValue('_tbSuccess'),
      };
    });
  };

  const detailUrlFromWindowOpen = await page.evaluate((logId) => {
    const windowAny = window as unknown as {
      openLogDetails?: (id: string) => void;
      open: Window['open'];
    };

    if (typeof windowAny.openLogDetails !== 'function') {
      throw new Error('openLogDetails function not found on window');
    }

    const originalOpen = windowAny.open.bind(windowAny);
    let openedUrl: string | null = null;

    windowAny.open = ((url?: string | URL | undefined) => {
      if (typeof url === 'string') {
        openedUrl = url;
      } else if (url instanceof URL) {
        openedUrl = url.toString();
      }

      return null;
    }) as Window['open'];

    try {
      windowAny.openLogDetails(logId);
      return openedUrl;
    } finally {
      windowAny.open = originalOpen;
    }
  }, detailsId);

  if (detailUrlFromWindowOpen) {
    const detailPage = await page.browserContext().newPage();

    try {
      const detailUrl = new URL(detailUrlFromWindowOpen, page.url()).toString();
      await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      return await readDetailFromPage(detailPage);
    } finally {
      await detailPage.close().catch(() => undefined);
    }
  }

  const browser = page.browser();
  const popupTargetPromise = browser
    .waitForTarget(
      (target) =>
        target.type() === 'page' &&
        target.opener() === page.target() &&
        target.url() !== 'about:blank',
      { timeout: 7_000 },
    )
    .catch(() => null);

  await page.evaluate((logId) => {
    const windowAny = window as unknown as { openLogDetails?: (id: string) => void };
    if (typeof windowAny.openLogDetails !== 'function') {
      throw new Error('openLogDetails function not found on window');
    }

    windowAny.openLogDetails(logId);
  }, detailsId);

  const popupTarget = await popupTargetPromise;
  const popupPage = popupTarget ? await popupTarget.page() : null;

  if (popupPage) {
    try {
      await popupPage
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
        .catch(() => undefined);
      return await readDetailFromPage(popupPage);
    } finally {
      await popupPage.close().catch(() => undefined);
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await readDetailFromPage(page);
    } catch (error) {
      if (attempt === 1 && isDetachedFrameError(error)) {
        await page.waitForSelector(apiLogsTableSelector, { timeout: 20_000 });
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Unable to read detail for id ${detailsId}`);
}

async function navigateToPage(page: puppeteer.Page, targetPage: number): Promise<void> {
  const previousFirstSupportId = await page.$eval(
    `${dataRowSelector}:first-child td:nth-child(2)`,
    (el) => el.textContent?.trim() || '',
  );

  await page.evaluate((requestedPage) => {
    const pager = document.querySelector('tr.Paging');
    if (!pager) {
      throw new Error('Pagination row not found');
    }

    const link = Array.from(pager.querySelectorAll('a')).find(
      (anchor) => anchor.textContent?.trim() === String(requestedPage),
    );

    if (!link) {
      throw new Error(`Pagination link not found for page ${requestedPage}`);
    }

    (link as HTMLElement).click();
  }, targetPage);

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20_000 }),
    page.waitForFunction(
      (requestedPage) => {
        const currentPage = document.querySelector('tr.Paging span')?.textContent?.trim();
        return currentPage === String(requestedPage);
      },
      { timeout: 20_000 },
      targetPage,
    ),
  ]);

  await page.waitForFunction(
    (previousSupportId) => {
      const firstSupportId = document
        .querySelector(
          '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults tr.RowData td:nth-child(2), #ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults tr.AltRowData td:nth-child(2)',
        )
        ?.textContent?.trim();

      return Boolean(firstSupportId) && firstSupportId !== previousSupportId;
    },
    { timeout: 20_000 },
    previousFirstSupportId,
  );
}

export async function downloadApiLogs(
  options: DownloadApiLogsArgs,
): Promise<DownloadApiLogsResult> {
  const { env, cookies, browser, pages, onPageStart, onRecord } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  if (pages < 1) {
    throw new Error('pages must be at least 1');
  }

  let page: puppeteer.Page | null = null;

  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    page = await context.newPage();
    await context.setCookie(...cookies);

    const url = `https://${env}.${baseurl}/da2/Setup/Admin/APILogs.aspx`;
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForSelector(apiLogsTableSelector, { timeout: 20_000 });

    let recordsDownloaded = 0;

    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      if (onPageStart) {
        await onPageStart(pageNumber);
      }

      if (pageNumber > 1) {
        await navigateToPage(page, pageNumber);
      }

      const summaries = await extractSummariesForCurrentPage(page, pageNumber);

      for (const summary of summaries) {
        const detail = await openDetailAndRead(page, summary.detailsId, summary.supportId);

        if (summary.success !== parseSuccess(detail.success ?? '')) {
          // Continue and keep captured data even if summary/detail success values differ.
        }

        if (onRecord) {
          await onRecord({ summary, detail });
        }

        recordsDownloaded++;
      }
    }

    return {
      pagesProcessed: pages,
      recordsDownloaded,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors for command resiliency.
      }
    }
  }
}

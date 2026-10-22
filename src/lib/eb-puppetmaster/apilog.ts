import puppeteer from 'puppeteer';
import { BrowserManager, Environment, baseurl, optimizePageForAutomation } from './index.js';

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
  fromDate?: string | undefined;
  toDate?: string | undefined;
  onPageStart?: (page: number) => void | Promise<void>;
  onRecord?: (record: ApiLogRecord) => void | Promise<void>;
};

export type DownloadApiLogsResult = {
  pagesProcessed: number;
  recordsDownloaded: number;
};

export const fromDateInputSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_fromDate_dateInput';
export const toDateInputSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_toDate_dateInput';

export function formatDateForInput(date: Date): string {
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const y = date.getFullYear().toString();
  return `${m}/${d}/${y}`;
}

export function getDefaultApiLogDateRange(referenceDate?: Date): {
  fromDate: string;
  toDate: string;
} {
  const to = referenceDate ? new Date(referenceDate) : new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);

  return {
    fromDate: formatDateForInput(from),
    toDate: formatDateForInput(to),
  };
}

export function normalizeDateInput(input: string): string {
  const trimmed = input.trim();
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slashMatch && slashMatch[1] && slashMatch[2] && slashMatch[3]) {
    const m = slashMatch[1].padStart(2, '0');
    const d = slashMatch[2].padStart(2, '0');
    const y = slashMatch[3];
    return `${m}/${d}/${y}`;
  }
  const dashMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (dashMatch && dashMatch[1] && dashMatch[2] && dashMatch[3]) {
    const y = dashMatch[1];
    const m = dashMatch[2].padStart(2, '0');
    const d = dashMatch[3].padStart(2, '0');
    return `${m}/${d}/${y}`;
  }
  return trimmed;
}

export function isValidDateString(input: string): boolean {
  const trimmed = input.trim();
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const dashMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (!slashMatch && !dashMatch) return false;

  let m: number;
  let d: number;
  let y: number;

  if (slashMatch && slashMatch[1] && slashMatch[2] && slashMatch[3]) {
    m = parseInt(slashMatch[1], 10);
    d = parseInt(slashMatch[2], 10);
    y = parseInt(slashMatch[3], 10);
  } else if (dashMatch && dashMatch[1] && dashMatch[2] && dashMatch[3]) {
    y = parseInt(dashMatch[1], 10);
    m = parseInt(dashMatch[2], 10);
    d = parseInt(dashMatch[3], 10);
  } else {
    return false;
  }

  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  if (y < 1900 || y > 2100) return false;

  const testDate = new Date(y, m - 1, d);
  return testDate.getFullYear() === y && testDate.getMonth() === m - 1 && testDate.getDate() === d;
}

export async function applyDateFilter(
  page: puppeteer.Page,
  fromDate: string,
  toDate: string,
): Promise<void> {
  if (typeof page.evaluate === 'function') {
    await page
      .evaluate(
        (fromSel, toSel, fromVal, toVal) => {
          const fillInput = (sel: string, val: string) => {
            const input = document.querySelector(sel) as HTMLInputElement | null;
            if (!input) return;
            input.focus();
            input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));

            const baseId = input.id.replace(/_dateInput$/, '');
            const picker = (window as any).$find?.(baseId) || (window as any)[baseId];
            if (picker?.get_dateInput?.()?.set_value) {
              try {
                picker.get_dateInput().set_value(val);
              } catch {}
            }
          };

          fillInput(fromSel, fromVal);
          fillInput(toSel, toVal);
        },
        fromDateInputSelector,
        toDateInputSelector,
        fromDate,
        toDate,
      )
      .catch(() => null);
  }

  if (typeof page.$ === 'function') {
    const fromEl = await page.$(fromDateInputSelector).catch(() => null);
    if (fromEl && typeof fromEl.click === 'function' && typeof fromEl.type === 'function') {
      try {
        await fromEl.click({ clickCount: 3 });
        await fromEl.type(fromDate);
      } catch {}
    }

    const toEl = await page.$(toDateInputSelector).catch(() => null);
    if (toEl && typeof toEl.click === 'function' && typeof toEl.type === 'function') {
      try {
        await toEl.click({ clickCount: 3 });
        await toEl.type(toDate);
      } catch {}
    }

    const buttonSelectors = [
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnFilter',
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnSearch',
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnView',
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnSubmit',
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnApply',
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnGo',
      'input[type="submit"][id*="contentSection"]',
      'button[id*="contentSection"]',
      'input[type="submit"][value*="Filter" i]',
      'input[type="submit"][value*="Search" i]',
      'input[type="submit"][value*="View" i]',
      'input[type="submit"]',
      'button[type="submit"]',
    ];

    let buttonClicked = false;
    for (const btnSel of buttonSelectors) {
      const btn = await page.$(btnSel).catch(() => null);
      if (btn && typeof btn.click === 'function') {
        const navPromise =
          typeof page.waitForNavigation === 'function'
            ? Promise.race([
                page
                  .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 })
                  .catch(() => null),
                new Promise((resolve) => setTimeout(resolve, 1000)),
              ])
            : Promise.resolve();
        await Promise.all([navPromise, btn.click().catch(() => null)]);
        buttonClicked = true;
        break;
      }
    }

    if (!buttonClicked && toEl && typeof toEl.press === 'function') {
      const navPromise =
        typeof page.waitForNavigation === 'function'
          ? Promise.race([
              page
                .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 })
                .catch(() => null),
              new Promise((resolve) => setTimeout(resolve, 1000)),
            ])
          : Promise.resolve();
      await Promise.all([navPromise, toEl.press('Enter').catch(() => null)]);
    }

    if (typeof page.waitForNetworkIdle === 'function') {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => null);
    }
  }
}

const apiLogsTableSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults, table.TableGrid';
const dataRowSelector =
  '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults tr.RowData, #ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults tr.AltRowData';

export function parseDetailsId(onclickValue: string): string {
  const match = /openLogDetails\s*\(\s*(?:['"]([^'"]+)['"]|([^'")\s;]+))\s*\)/i.exec(onclickValue);
  if (!match) {
    throw new Error(`Unable to parse details id from onclick: ${onclickValue}`);
  }

  const id = (match[1] ?? match[2])?.trim();
  if (!id) {
    throw new Error(`Unable to parse details id from onclick: ${onclickValue}`);
  }

  return id;
}

export function parseSuccess(input: string): boolean {
  return input.trim().toLowerCase() === 'true';
}

function isDetachedFrameError(error: unknown): boolean {
  return error instanceof Error && /detached frame/i.test(error.message);
}

export async function extractSummariesForCurrentPage(
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

export async function openDetailAndRead(
  page: puppeteer.Page,
  detailsId: string,
  expectedSupportId: string,
): Promise<ApiLogDetail> {
  const readDetailFromTarget = async (
    target: puppeteer.Page | puppeteer.Frame,
  ): Promise<ApiLogDetail> => {
    await target.waitForFunction(
      (expectedId) => {
        const supportIdInput = document.querySelector(
          '[id$="_tbSupportId"]',
        ) as HTMLInputElement | null;
        const userNameInput = document.querySelector(
          '[id$="_tbUserName"]',
        ) as HTMLInputElement | null;

        if (!supportIdInput && !userNameInput) return false;
        if (supportIdInput && supportIdInput.value.trim()) {
          if (!expectedId) return true;
          return supportIdInput.value.trim() === expectedId;
        }
        if (userNameInput && userNameInput.value.trim() && !expectedId) return true;
        return false;
      },
      { timeout: 20_000 },
      expectedSupportId,
    );

    return await target.evaluate(() => {
      const getValue = (suffix: string): string | null => {
        const el = document.querySelector(`[id$="${suffix}"]`) as
          HTMLInputElement | HTMLTextAreaElement | null;
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
        requestUri:
          requestUriLink?.href || getValue('_tbRequestUri') || getValue('_hrefRequestUri') || null,
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

  const detailUrlFromIntercept = await page.evaluate((logId) => {
    const windowAny = window as any;
    let openedUrl: string | null = null;

    const captureUrl = (url: unknown) => {
      if (typeof url === 'string') {
        openedUrl = url;
      } else if (url && typeof (url as any).toString === 'function') {
        openedUrl = (url as any).toString();
      }
    };

    const fakeWindow = {
      focus: () => {},
      close: () => {},
      closed: false,
      location: { href: '' },
      document: { write: () => {}, close: () => {} },
    } as unknown as Window;

    const fakeRadWindow = {
      set_title: () => {},
      show: () => {},
      center: () => {},
      close: () => {},
      maximize: () => {},
      restore: () => {},
      autoSize: () => {},
      setUrl: () => {},
      getUrl: () => openedUrl || '',
    };

    const originalOpen =
      typeof windowAny.open === 'function' ? windowAny.open.bind(windowAny) : undefined;
    const originalRadopen =
      typeof windowAny.radopen === 'function' ? windowAny.radopen.bind(windowAny) : undefined;
    const rwm =
      typeof windowAny.GetRadWindowManager === 'function' ? windowAny.GetRadWindowManager() : null;
    const originalRwmOpen = rwm && typeof rwm.open === 'function' ? rwm.open.bind(rwm) : undefined;

    windowAny.open = ((url?: string | URL | undefined) => {
      captureUrl(url);
      return fakeWindow;
    }) as Window['open'];

    if (originalRadopen) {
      windowAny.radopen = (url?: any) => {
        captureUrl(url);
        return fakeRadWindow;
      };
    }

    if (rwm && originalRwmOpen) {
      rwm.open = (url?: any) => {
        captureUrl(url);
        return fakeRadWindow;
      };
    }

    try {
      if (typeof windowAny.openLogDetails === 'function') {
        windowAny.openLogDetails(logId);
      } else {
        const anchor = document.querySelector(`a[onclick*="${logId}"]`) as HTMLAnchorElement | null;
        if (anchor) {
          anchor.click();
        }
      }
      return openedUrl;
    } finally {
      if (originalOpen) {
        windowAny.open = originalOpen;
      }
      if (originalRadopen) {
        windowAny.radopen = originalRadopen;
      }
      if (rwm && originalRwmOpen) {
        rwm.open = originalRwmOpen;
      }
    }
  }, detailsId);

  if (detailUrlFromIntercept) {
    const detailPage = await page.browserContext().newPage();

    try {
      const detailUrl = new URL(detailUrlFromIntercept, page.url()).toString();
      await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      return await readDetailFromTarget(detailPage);
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
    const windowAny = window as any;
    if (typeof windowAny.openLogDetails === 'function') {
      windowAny.openLogDetails(logId);
    } else {
      const anchor = document.querySelector(`a[onclick*="${logId}"]`) as HTMLAnchorElement | null;
      if (anchor) {
        anchor.click();
      }
    }
  }, detailsId);

  const popupTarget = await popupTargetPromise;
  const popupPage = popupTarget ? await popupTarget.page() : null;

  if (popupPage) {
    try {
      await popupPage
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
        .catch(() => undefined);
      return await readDetailFromTarget(popupPage);
    } finally {
      await popupPage.close().catch(() => undefined);
    }
  }

  const findTargetWithDetail = async (
    hostPage: puppeteer.Page,
  ): Promise<puppeteer.Page | puppeteer.Frame> => {
    const checkTarget = async (t: puppeteer.Page | puppeteer.Frame) => {
      return await t
        .evaluate(() => {
          return Boolean(document.querySelector('[id$="_tbSupportId"]'));
        })
        .catch(() => false);
    };

    const startTime = Date.now();
    while (Date.now() - startTime < 20_000) {
      if (await checkTarget(hostPage)) {
        return hostPage;
      }
      for (const frame of hostPage.frames()) {
        if (frame === hostPage.mainFrame()) continue;
        if (await checkTarget(frame)) {
          return frame;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return hostPage;
  };

  const closeInPageModal = async () => {
    await page
      .evaluate(() => {
        const closeBtn = document.querySelector(
          '.rwCloseButton, a[title="Close"], button[title="Close"], .modal-close',
        ) as HTMLElement | null;
        if (closeBtn) {
          closeBtn.click();
        }
        const radWindowManager = (window as any).GetRadWindowManager?.();
        if (radWindowManager?.getActiveWindow?.()) {
          radWindowManager.getActiveWindow().close();
        }
      })
      .catch(() => undefined);
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const target = await findTargetWithDetail(page);
      return await readDetailFromTarget(target);
    } catch (error) {
      if (attempt === 1 && isDetachedFrameError(error)) {
        await page.waitForSelector(apiLogsTableSelector, { timeout: 20_000 });
        continue;
      }

      throw error;
    } finally {
      await closeInPageModal();
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
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }),
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

  if (pages < 1) {
    throw new Error('pages must be at least 1');
  }

  const defaultRange = getDefaultApiLogDateRange();
  const fromDate = normalizeDateInput(options.fromDate || defaultRange.fromDate);
  const toDate = normalizeDateInput(options.toDate || defaultRange.toDate);

  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  let page: puppeteer.Page | null = null;

  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    page = await context.newPage();
    await optimizePageForAutomation(page);
    await context.setCookie(...cookies);

    const url = `https://${env}.${baseurl}/da2/Setup/Admin/APILogs.aspx`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    let hasDateInputs = false;
    if (typeof page.waitForSelector === 'function') {
      hasDateInputs = await page
        .waitForSelector(fromDateInputSelector, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }

    if (hasDateInputs) {
      await applyDateFilter(page, fromDate, toDate);
    }

    if (typeof page.waitForSelector === 'function') {
      await page.waitForSelector(apiLogsTableSelector, { timeout: 20_000 });
    }

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

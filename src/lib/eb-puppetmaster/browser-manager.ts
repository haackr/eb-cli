import puppeteer from "puppeteer";

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: puppeteer.Browser | null = null;

  constructor() {
    // Register cleanup handlers for process shutdown
    const cleanup = async () => {
      await this.closeBrowser();
    };

    process.on("exit", () => {
      // Synchronous cleanup for exit
      if (this.browser) {
        this.browser.close().catch(console.error);
      }
    });

    process.on("SIGINT", async () => {
      await cleanup();
      process.exit();
    });

    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit();
    });

    process.on("uncaughtException", async (err) => {
      console.error("Uncaught Exception:", err);
      await cleanup();
      process.exit(1);
    });

    process.on("unhandledRejection", async (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
      await cleanup();
      process.exit(1);
    });
  }

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  async getBrowser(
    headless: boolean = true,
    args?: string[]
  ): Promise<puppeteer.Browser> {
    if (!this.browser || this.browser.connected === false) {
      this.browser = await puppeteer.launch({
        headless,
        args: args || ["--no-sandbox"],
      });
    }
    return this.browser;
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

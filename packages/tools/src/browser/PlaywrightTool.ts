import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';

const inputSchema = z.object({
  action: z.enum(['navigate', 'screenshot', 'extract_text', 'click', 'fill', 'close'])
    .describe('Action to perform: navigate=go to URL, screenshot=save image, extract_text=get page text, click=click element, fill=type into input, close=close browser'),
  url: z.string().optional().describe('URL to navigate to (required for navigate, screenshot, extract_text)'),
  selector: z.string().optional().describe('CSS or text selector for click/fill actions. For text-based: use text="More information..." or XPath like //a[contains(text(),"More")]'),
  value: z.string().optional().describe('Text value for fill action'),
  path: z.string().optional().describe('File path for screenshot (default: /tmp/emma/screenshot.png)'),
});

type Input = z.infer<typeof inputSchema>;

export class PlaywrightTool implements ITool<Input> {
  readonly name = 'browser';
  readonly description =
    'Control a headless browser. Navigate URLs, take screenshots, extract text, click elements, fill forms. ' +
    'For click: use selector="text=Link Text" to click by visible text, or a CSS selector. ' +
    'The browser persists across calls in the same session.';
  readonly inputSchema = inputSchema;

  // Browser instance is lazily initialized and reused within a session
  #browser: import('playwright').Browser | null = null;
  #page: import('playwright').Page | null = null;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    if (input.action === 'close') {
      await this.#cleanup();
      return { success: true, data: 'Browser closed' };
    }

    try {
      await this.#ensureBrowser();
      const page = this.#page!;

      if (input.action === 'navigate') {
        await page.goto(input.url!, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const title = await page.title();
        return { success: true, data: `Navigated to ${input.url}. Title: ${title}` };
      }

      if (input.action === 'screenshot') {
        if (input.url) {
          await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        const screenshotPath = input.path ?? '/tmp/emma/screenshot.png';
        // Ensure directory exists
        await mkdir(dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        return { success: true, data: `Screenshot saved to ${screenshotPath}` };
      }

      if (input.action === 'extract_text') {
        if (input.url) {
          await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        let text: string;
        if (input.selector) {
          const elements = await page.locator(input.selector).all();
          text = (await Promise.all(elements.map(el => el.textContent()))).filter(Boolean).join('\n') || '';
        } else {
          text = (await page.evaluate('document.body.innerText')) as string;
        }
        return { success: true, data: text.slice(0, 10_000) };
      }

      if (input.action === 'click') {
        const selector = input.selector!;

        // Try multiple strategies to locate and click the element
        let clicked = false;
        let lastError = '';

        // Strategy 1: direct locator (handles text=..., css, xpath)
        try {
          await page.locator(selector).first().click({ timeout: 8000 });
          clicked = true;
        } catch (e1) {
          lastError = (e1 as Error).message;

          // Strategy 2: try as plain text link
          try {
            await page.getByText(selector, { exact: false }).first().click({ timeout: 5000 });
            clicked = true;
          } catch (e2) {
            lastError = (e2 as Error).message;

            // Strategy 3: XPath with contains(text())
            try {
              await page.locator(`//a[contains(., "${selector}")]`).first().click({ timeout: 5000 });
              clicked = true;
            } catch (e3) {
              lastError = (e3 as Error).message;
            }
          }
        }

        if (!clicked) {
          return { success: false, error: `Could not click "${selector}": ${lastError}` };
        }

        // Wait for any navigation that may result from the click
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
        } catch {
          // Navigation may not happen — that's fine
        }

        const title = await page.title().catch(() => '');
        const url = page.url();
        return {
          success: true,
          data: `Clicked '${selector}'. Current page: ${url}${title ? ` (${title})` : ''}`,
        };
      }

      if (input.action === 'fill') {
        await page.locator(input.selector!).fill(input.value!);
        return { success: true, data: `Filled '${input.selector}'` };
      }

      return { success: false, error: 'Unknown action' };
    } catch (err) {
      // If the page crashed, reset the browser instance so next call gets a fresh one
      const msg = (err as Error).message ?? String(err);
      if (msg.includes('closed') || msg.includes('crashed') || msg.includes('disconnected')) {
        await this.#cleanup().catch(() => {});
      }
      return { success: false, error: msg };
    }
  }

  async #ensureBrowser(): Promise<void> {
    // Check if existing browser/page is still usable
    if (this.#browser && this.#page) {
      try {
        // Quick check: if page is closed/crashed, this throws
        await this.#page.evaluate('1');
        return;
      } catch {
        // Page is gone — reset and reopen
        await this.#cleanup().catch(() => {});
      }
    }

    const { chromium } = await import('playwright');
    this.#browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await this.#browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    this.#page = await context.newPage();
  }

  async #cleanup(): Promise<void> {
    try { await this.#page?.close(); } catch { /* ignore */ }
    try { await this.#browser?.close(); } catch { /* ignore */ }
    this.#browser = null;
    this.#page = null;
  }
}

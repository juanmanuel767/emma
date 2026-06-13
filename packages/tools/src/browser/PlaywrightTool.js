import { z } from 'zod';
const inputSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('navigate'),
        url: z.string().url(),
    }),
    z.object({
        action: z.literal('screenshot'),
        url: z.string().url().optional(),
        path: z.string().optional().default('/tmp/emma/screenshot.png'),
    }),
    z.object({
        action: z.literal('extract_text'),
        url: z.string().url(),
        selector: z.string().optional(),
    }),
    z.object({
        action: z.literal('click'),
        selector: z.string(),
    }),
    z.object({
        action: z.literal('fill'),
        selector: z.string(),
        value: z.string(),
    }),
    z.object({
        action: z.literal('close'),
    }),
]);
export class PlaywrightTool {
    name = 'browser';
    description = 'Control a headless browser. Navigate URLs, take screenshots, extract text, click elements, fill forms.';
    inputSchema = inputSchema;
    // Browser instance is lazily initialized and reused within a session
    #browser = null;
    #page = null;
    async execute(input, ctx) {
        if (input.action === 'close') {
            await this.#cleanup();
            return { success: true, data: 'Browser closed' };
        }
        try {
            await this.#ensureBrowser();
            const page = this.#page;
            if (input.action === 'navigate') {
                await page.goto(input.url, { waitUntil: 'networkidle' });
                const title = await page.title();
                return { success: true, data: `Navigated to ${input.url}. Title: ${title}` };
            }
            if (input.action === 'screenshot') {
                if (input.url) {
                    await page.goto(input.url, { waitUntil: 'networkidle' });
                }
                await page.screenshot({ path: input.path, fullPage: true });
                return { success: true, data: `Screenshot saved to ${input.path}` };
            }
            if (input.action === 'extract_text') {
                await page.goto(input.url, { waitUntil: 'networkidle' });
                const text = input.selector
                    ? await page.locator(input.selector).textContent() ?? ''
                    : (await page.evaluate('document.body.innerText'));
                return { success: true, data: text.slice(0, 10_000) };
            }
            if (input.action === 'click') {
                await page.locator(input.selector).click();
                return { success: true, data: `Clicked '${input.selector}'` };
            }
            if (input.action === 'fill') {
                await page.locator(input.selector).fill(input.value);
                return { success: true, data: `Filled '${input.selector}'` };
            }
            return { success: false, error: 'Unknown action' };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    async #ensureBrowser() {
        if (!this.#browser) {
            const { chromium } = await import('playwright');
            this.#browser = await chromium.launch({ headless: true });
            this.#page = await this.#browser.newPage();
        }
    }
    async #cleanup() {
        await this.#page?.close();
        await this.#browser?.close();
        this.#browser = null;
        this.#page = null;
    }
}
//# sourceMappingURL=PlaywrightTool.js.map
import { z } from 'zod';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';

const inputSchema = z.object({
  query: z.string().min(1).max(512).describe('The search query'),
  maxResults: z.number().int().min(1).max(10).optional().default(5),
});

type Input = z.infer<typeof inputSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Decodifica entidades HTML (nombradas y numéricas) que aparecen en los títulos/snippets. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/** Quita etiquetas HTML, decodifica entidades y normaliza espacios. */
function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Bing envuelve la URL real en un redirect ck/a con el destino en base64 (param u=a1<base64>). */
function decodeBingUrl(href: string): string {
  try {
    const u = new URL(href);
    const p = u.searchParams.get('u');
    if (p && p.startsWith('a1')) {
      const b64 = p.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) return decoded;
    }
  } catch {
    /* href no es URL válida */
  }
  return href;
}

/** DuckDuckGo envuelve los enlaces en /l/?uddg=<url-encoded>. */
function resolveDuckUrl(href: string): string {
  try {
    const u = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(u, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u;
  } catch {
    return href;
  }
}

export class WebSearchTool implements ITool<Input, SearchResult[]> {
  readonly name = 'web_search';
  readonly description =
    'Search the web and get a list of results (title, url, snippet) for any query: current info, prices, how-tos, news, etc.';
  readonly inputSchema = inputSchema;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult<SearchResult[]>> {
    const { query, maxResults } = input;
    try {
      // 1) Brave Search API si hay clave (la más fiable; opcional, sin romper nada si no está).
      const braveKey = process.env['BRAVE_API_KEY'];
      if (braveKey) {
        const brave = await this.#brave(query, maxResults, braveKey).catch(() => []);
        if (brave.length > 0) return { success: true, data: brave };
      }

      // 2) Bing (tolera el scraping y rara vez bloquea).
      const bing = await this.#bing(query, maxResults).catch(() => []);
      if (bing.length > 0) return { success: true, data: bing };

      // 3) DuckDuckGo HTML (a veces devuelve una página anti-bot bajo uso intensivo).
      const ddg = await this.#duckHtml(query, maxResults).catch(() => []);
      if (ddg.length > 0) return { success: true, data: ddg };

      // 4) Respuesta instantánea (solo entidades enciclopédicas).
      const instant = await this.#instantAnswer(query, maxResults).catch(() => []);
      if (instant.length > 0) return { success: true, data: instant };

      return { success: true, data: [], metadata: { message: 'No results found' } };
    } catch (err) {
      return { success: false, error: `Search failed: ${(err as Error).message}` };
    }
  }

  /** Brave Search API (JSON). Gratis hasta ~2000/mes; requiere BRAVE_API_KEY. */
  async #brave(query: string, maxResults: number, key: string): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    return (data.web?.results ?? [])
      .slice(0, maxResults)
      .filter((r) => r.url && r.title)
      .map((r) => ({ title: stripHtml(r.title ?? ''), url: r.url ?? '', snippet: stripHtml(r.description ?? '') }));
  }

  /** Busca en Bing y parsea el HTML por bloques de resultado (saltando anuncios). */
  async #bing(query: string, maxResults: number): Promise<SearchResult[]> {
    const res = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=es&cc=CO`,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) return [];
    const html = await res.text();

    const results: SearchResult[] = [];
    for (const block of html.split('<li class="b_algo"').slice(1)) {
      if (results.length >= maxResults) break;
      const linkM = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      if (!linkM) continue;
      const url = decodeBingUrl(decodeEntities(linkM[1] ?? ''));
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      // Saltar anuncios y redirects internos de Bing que no se resolvieron.
      if (!/^https?:\/\//.test(url) || /(^|\.)bing\.com$/.test(host)) continue;
      const title = stripHtml(linkM[2] ?? '');
      const pM =
        /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ?? /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
      const snippet = pM ? stripHtml(pM[1] ?? '') : '';
      if (title) results.push({ title, url, snippet });
    }
    return results;
  }

  /** Respaldo: HTML de DuckDuckGo (html.duckduckgo.com/html/). */
  async #duckHtml(query: string, maxResults: number): Promise<SearchResult[]> {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Language': 'es-ES,es;q=0.9' },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripHtml(sm[1] ?? ''));

    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const results: SearchResult[] = [];
    let lm: RegExpExecArray | null;
    let i = 0;
    while ((lm = linkRe.exec(html)) !== null && results.length < maxResults) {
      const url = resolveDuckUrl(decodeEntities(lm[1] ?? ''));
      const title = stripHtml(lm[2] ?? '');
      // Saltar anuncios de DDG (y.js).
      if (url && title && !/duckduckgo\.com\/y\.js/.test(url)) {
        results.push({ title, url, snippet: snippets[i] ?? '' });
      }
      i += 1;
    }
    return results;
  }

  /** Último recurso: API de respuesta instantánea de DuckDuckGo (entidades enciclopédicas). */
  async #instantAnswer(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');
    const res = await fetch(url.toString(), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      AbstractSource?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const results: SearchResult[] = [];
    if (data.AbstractText && data.AbstractURL) {
      results.push({ title: data.AbstractSource ?? 'Result', url: data.AbstractURL, snippet: data.AbstractText });
    }
    for (const topic of (data.RelatedTopics ?? []).slice(0, maxResults - results.length)) {
      if (topic.Text && topic.FirstURL) results.push({ title: topic.FirstURL, url: topic.FirstURL, snippet: topic.Text });
    }
    return results;
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

interface DesignItem {
  title: string;
  url: string;
  description?: string;
  tags?: string[];
  imageUrl?: string;
  titleJa?: string;
  summaryJa?: string;
}

interface ScrapedData {
  source: string;
  items: DesignItem[];
}

// ── Image download ────────────────────────────────────────────────────────────

function guessExt(url: string): string {
  const m = url.split("?")[0].match(/\.(jpe?g|png|webp|gif|svg)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

function sanitizeSlug(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

async function downloadImage(
  url: string,
  destPath: string,
  redirectsLeft = 5
): Promise<boolean> {
  if (!url.startsWith("http") || redirectsLeft <= 0) return false;
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Referer: new URL(url).origin + "/",
          Accept: "image/webp,image/avif,image/*,*/*;q=0.8",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(destPath, () => {});
          const redirectUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          resolve(downloadImage(redirectUrl, destPath, redirectsLeft - 1));
        } else if (res.statusCode === 200) {
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve(true);
          });
        } else {
          file.close();
          fs.unlink(destPath, () => {});
          resolve(false);
        }
      }
    );
    req.setTimeout(12000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      resolve(false);
    });
  });
}

async function downloadAllImages(
  data: ScrapedData[],
  imageDir: string
): Promise<Map<string, string>> {
  fs.mkdirSync(imageDir, { recursive: true });
  const urlToLocal = new Map<string, string>();

  for (const section of data) {
    const sourceSlug = sanitizeSlug(section.source);
    for (let i = 0; i < section.items.length; i++) {
      const item = section.items[i];
      if (!item.imageUrl || item.imageUrl.startsWith("data:")) continue;

      const ext = guessExt(item.imageUrl);
      const filename = `${sourceSlug}-${String(i + 1).padStart(2, "0")}.${ext}`;
      const destPath = path.join(imageDir, filename);

      process.stdout.write(`  Downloading ${filename}...`);
      const ok = await downloadImage(item.imageUrl, destPath);
      console.log(ok ? " ok" : " failed");

      if (ok) urlToLocal.set(item.imageUrl, filename);
    }
  }

  return urlToLocal;
}

// ── Scrapers ──────────────────────────────────────────────────────────────────

async function scrapeSiteInspire(page: Page): Promise<ScrapedData> {
  console.log("Scraping SiteInspire...");
  const items: DesignItem[] = [];

  try {
    await page.goto("https://www.siteinspire.com/websites", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const results = await page.evaluate(() => {
      // Separate maps: title and imageUrl may come from different anchor elements
      const titleMap = new Map<string, string>();
      const imageMap = new Map<string, string>();

      document
        .querySelectorAll<HTMLAnchorElement>('a[href*="/website/"]')
        .forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (!href.match(/^\/website\/\d+/)) return;

          const raw = a.textContent?.trim() || "";
          const title = raw
            .replace(/\d+\s*(hour|day|week|month)s?\s+ago\s*$/i, "")
            .trim();
          if (title.length > 2 && !titleMap.has(href)) {
            titleMap.set(href, title);
          }

          const imgSrc = a.querySelector<HTMLImageElement>("img")?.src || "";
          if (imgSrc && !imgSrc.startsWith("data:") && !imageMap.has(href)) {
            imageMap.set(href, imgSrc);
          }
        });

      return Array.from(titleMap.entries())
        .slice(0, 8)
        .map(([url, title]) => ({ url, title, imageUrl: imageMap.get(url) || "" }));
    });

    for (const r of results) {
      items.push({
        title: r.title,
        url: `https://www.siteinspire.com${r.url}`,
        imageUrl: r.imageUrl || undefined,
      });
    }
  } catch (err) {
    console.warn(`SiteInspire warning: ${(err as Error).message}`);
  }

  return { source: "SiteInspire", items };
}

async function scrapeDribbble(page: Page): Promise<ScrapedData> {
  console.log("Scraping Dribbble...");
  const items: DesignItem[] = [];

  try {
    await page.goto("https://dribbble.com/shots/popular", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForSelector("li.shot-thumbnail, .shot-thumbnail", {
      timeout: 10000,
    });

    // Scroll to trigger lazy-load on remaining thumbnails
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(1500);

    const results = await page.evaluate(() => {
      const entries: {
        title: string;
        url: string;
        imageUrl: string;
        tags: string[];
      }[] = [];
      const seen = new Set<string>();

      document
        .querySelectorAll("li.shot-thumbnail, [class*='shot-thumbnail']")
        .forEach((el) => {
          const titleEl = el.querySelector(".shot-title, a[class*='title'], h3, h2");
          const linkEl = el.querySelector<HTMLAnchorElement>(
            "a.shot-thumbnail-link, a[href*='/shots/']"
          );
          const href = linkEl?.getAttribute("href") || "";
          if (!href || seen.has(href)) return;
          seen.add(href);

          const tags: string[] = [];
          el.querySelectorAll(".tag, [class*='tag'] a").forEach((t) => {
            const txt = t.textContent?.trim();
            if (txt) tags.push(txt);
          });

          const title =
            titleEl?.textContent?.trim() ||
            linkEl?.getAttribute("title") ||
            "";
          const imageUrl = el.querySelector<HTMLImageElement>("img")?.src || "";

          if (title) entries.push({ title, url: href, imageUrl, tags });
        });

      return entries.slice(0, 8);
    });

    for (const r of results) {
      items.push({
        title: r.title,
        url: r.url.startsWith("http") ? r.url : `https://dribbble.com${r.url}`,
        imageUrl: r.imageUrl || undefined,
        tags: r.tags.length > 0 ? r.tags : undefined,
      });
    }
  } catch (err) {
    console.warn(`Dribbble warning: ${(err as Error).message}`);
  }

  return { source: "Dribbble", items };
}

async function scrapeBehance(page: Page): Promise<ScrapedData> {
  console.log("Scraping Behance...");
  const items: DesignItem[] = [];

  try {
    await page.goto(
      "https://www.behance.net/search/projects?field=branding&sort=featured_date",
      { waitUntil: "networkidle", timeout: 30000 }
    );

    const results = await page.evaluate(() => {
      const out: { title: string; url: string; imageUrl: string }[] = [];
      const seenUrls = new Set<string>();

      // Collect cover images keyed by project ID extracted from image src
      const imgMap = new Map<string, string>();
      document
        .querySelectorAll<HTMLImageElement>('[class*="Cover"] img, [class*="cover"] img')
        .forEach((img) => {
          const src = img.src || "";
          const m = src.match(/projects\/\d+\/([a-f0-9]+)\./i) ||
                    src.match(/projects\/(\d+)\//);
          if (m) imgMap.set(m[1], src);
        });

      document
        .querySelectorAll<HTMLAnchorElement>('a[href*="/gallery/"]')
        .forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (!href.match(/\/gallery\/\d+/)) return;

          const fullUrl = href.startsWith("http")
            ? href
            : `https://www.behance.net${href}`;
          const cleanUrl = fullUrl.split("?")[0];
          if (seenUrls.has(cleanUrl)) return;
          seenUrls.add(cleanUrl);

          const title = (
            a.getAttribute("title") ||
            a.querySelector("div, span, h3")?.textContent?.trim() ||
            a.textContent?.trim() ||
            ""
          ).replace(/^Link to project\s*-\s*/i, "").trim();

          if (title.length < 3) return;

          // Match image by project ID in URL
          const idMatch = cleanUrl.match(/\/gallery\/(\d+)/);
          let imageUrl = "";
          if (idMatch) {
            // Try to find image whose src contains this project id
            document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
              if (img.src.includes(idMatch[1]) && !imageUrl) {
                imageUrl = img.src;
              }
            });
          }

          out.push({ title, url: cleanUrl, imageUrl });
        });

      return out.slice(0, 8);
    });

    items.push(...results.map((r) => ({
      title: r.title,
      url: r.url,
      imageUrl: r.imageUrl || undefined,
    })));
  } catch (err) {
    console.warn(`Behance warning: ${(err as Error).message}`);
  }

  return { source: "Behance (Branding)", items };
}

async function scrapeBrandNew(page: Page): Promise<ScrapedData> {
  console.log("Scraping Brand New...");
  const items: DesignItem[] = [];

  try {
    await page.goto("https://www.underconsideration.com/brandnew/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const articleUrls = await page.evaluate(() => {
      const map = new Map<string, string>();
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!href.match(/brandnew\/archives\/[^/]+\.php/) || href.includes("#")) return;
        const raw = a.textContent?.trim().replace(/\s+/g, " ") || "";
        const title = raw
          .replace(/^No Comments on\s*/i, "")
          .replace(/\s*(Reviewed|Spotted|Noted|News Linked)\s+.+$/i, "")
          .replace(/\s+before after\s*$/i, "")
          .replace(/\s+New\s*$/i, "")
          .trim();
        if (title.length >= 6 && !map.has(href)) map.set(href, title);
      });
      return Array.from(map.entries()).slice(0, 8);
    });

    // Fetch og:image from each article page (block non-document resources for speed)
    for (const [articleUrl, title] of articleUrls) {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        route[type === "document" ? "continue" : "abort"]();
      });
      let imageUrl: string | undefined;
      try {
        await page.goto(articleUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        const og = await page.evaluate(() =>
          document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? ""
        );
        if (og && !og.startsWith("data:")) imageUrl = og;
      } catch { /* skip image */ }
      await page.unroute("**/*");
      items.push({ title, url: articleUrl, imageUrl });
    }
  } catch (err) {
    console.warn(`Brand New warning: ${(err as Error).message}`);
  }

  return { source: "Brand New", items };
}

async function scrapeItsNiceThat(page: Page): Promise<ScrapedData> {
  console.log("Scraping It's Nice That...");
  const items: DesignItem[] = [];

  try {
    await page.goto("https://www.itsnicethat.com/graphic-design", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    try {
      await page.click(
        'button:has-text("Accept"), button:has-text("agree"), [id*="accept"]',
        { timeout: 3000 }
      );
    } catch { /* no consent wall */ }

    const articles = await page.evaluate(() => {
      const map = new Map<string, string>();

      document
        .querySelectorAll<HTMLAnchorElement>("a[href]")
        .forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (!href.match(/\/(articles|projects)\//)) return;
          if (href.startsWith("http") && !href.includes("itsnicethat.com")) return;

          const fullHref = href.startsWith("http")
            ? href
            : `https://www.itsnicethat.com${href}`;

          const raw = a.textContent?.trim().replace(/\s+/g, " ") || "";
          const title = raw
            .replace(/\d+\s*(day|week|month|hour|minute)s?\s+ago\s*$/i, "")
            .replace(/a\s+(day|week|month|hour|minute)\s+ago\s*$/i, "")
            .trim();

          if (title.length > 5 && !map.has(fullHref)) {
            map.set(fullHref, title);
          }
        });

      return Array.from(map.entries()).slice(0, 8);
    });

    // Fetch og:image from each article page (block non-document resources for speed)
    for (const [articleUrl, title] of articles) {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        route[type === "document" ? "continue" : "abort"]();
      });

      let imageUrl: string | undefined;
      try {
        await page.goto(articleUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        const og = await page.evaluate(() =>
          document
            .querySelector('meta[property="og:image"]')
            ?.getAttribute("content") ?? ""
        );
        if (og && !og.startsWith("data:")) imageUrl = og;
      } catch { /* skip image for this article */ }

      await page.unroute("**/*");
      items.push({ title, url: articleUrl, imageUrl });
    }
  } catch (err) {
    console.warn(`It's Nice That warning: ${(err as Error).message}`);
  }

  return { source: "It's Nice That", items };
}

async function scrapeMinimalissimo(page: Page): Promise<ScrapedData> {
  console.log("Scraping Minimalissimo...");
  const items: DesignItem[] = [];
  try {
    await page.goto("https://minimalissimo.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const results = await page.evaluate(() => {
      const seen = new Set<string>();
      const out: { title: string; url: string; imageUrl: string }[] = [];
      document.querySelectorAll<HTMLAnchorElement>('a[href^="/articles/"], a[href^="/portraits/"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (seen.has(href)) return;
        seen.add(href);
        const img = a.querySelector<HTMLImageElement>("img[alt]");
        if (!img) return;
        const title = img.alt.trim();
        if (!title) return;
        let imageUrl = img.src;
        try {
          const u = new URL(img.src, "https://minimalissimo.com");
          imageUrl = u.searchParams.get("url") || img.src;
        } catch {}
        out.push({ title, url: `https://minimalissimo.com${href}`, imageUrl });
      });
      return out.slice(0, 8);
    });
    items.push(...results.map((r) => ({ title: r.title, url: r.url, imageUrl: r.imageUrl || undefined })));
  } catch (err) { console.warn(`Minimalissimo warning: ${(err as Error).message}`); }
  return { source: "Minimalissimo", items };
}

async function scrapeMinimalSites(_page: Page): Promise<ScrapedData> {
  console.log("Scraping Minimal Sites...");
  const items: DesignItem[] = [];
  try {
    // Use WP REST API directly (no Playwright needed for JSON)
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        "https://minimalsites.com/wp-json/wp/v2/website?per_page=8&_embed=true",
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve(data));
        }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });
    const posts = JSON.parse(body) as Array<{
      title: { rendered: string };
      link: string;
      _embedded?: { "wp:featuredmedia"?: Array<{ source_url?: string }> };
    }>;
    for (const post of posts.slice(0, 8)) {
      const title = post.title.rendered.replace(/&amp;/g, "&").replace(/&#[0-9]+;/g, "").trim();
      const imageUrl = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
      items.push({ title, url: post.link, imageUrl: imageUrl || undefined });
    }
  } catch (err) { console.warn(`MinimalSites warning: ${(err as Error).message}`); }
  return { source: "Minimal Sites", items };
}

async function scrapeSiiimple(page: Page): Promise<ScrapedData> {
  console.log("Scraping Siiimple...");
  const items: DesignItem[] = [];
  try {
    await page.goto("https://siiimple.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const results = await page.evaluate(() => {
      const out: { title: string; url: string; imageUrl: string }[] = [];
      document.querySelectorAll<HTMLImageElement>("img.siiimple-gallery-img").forEach((img) => {
        const title = img.alt.trim();
        if (!title) return;
        const container = img.closest("article, li, div[class]");
        const link = container?.querySelector<HTMLAnchorElement>('.gallery-meta li:first-child a, a[href*="siiimple.com/"]');
        if (!link) return;
        out.push({ title, url: link.href, imageUrl: img.src });
      });
      return out.slice(0, 8);
    });
    items.push(...results.map((r) => ({ title: r.title, url: r.url, imageUrl: r.imageUrl || undefined })));
  } catch (err) { console.warn(`Siiimple warning: ${(err as Error).message}`); }
  return { source: "Siiimple", items };
}

async function scrapeKlikkentheke(page: Page): Promise<ScrapedData> {
  console.log("Scraping Klikkentheke...");
  const items: DesignItem[] = [];
  try {
    // Actual entries are at /catalogue/[slug]/ — no subcategory segment
    const entryUrls = await new Promise<string[]>((resolve, reject) => {
      const req = https.get(
        "https://klikkentheke.com/catalogue/",
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" } },
        (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => {
            const matches = [...data.matchAll(/href="(https:\/\/klikkentheke\.com\/catalogue\/[a-z0-9-]+\/)"/g)];
            const urls = [...new Set(matches.map((m) => m[1]))].filter(
              (u) => !/\/(color|style|topic|country|tag|a-z|about|submit|search|page)\//i.test(u)
            );
            resolve(urls.slice(0, 8));
          });
        }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });

    // Fetch og:image and og:title from each entry page
    for (const entryUrl of entryUrls) {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        route[type === "document" ? "continue" : "abort"]();
      });
      try {
        await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        const meta = await page.evaluate(() => ({
          title: document.querySelector('meta[property="og:title"]')?.getAttribute("content")
            ?? document.title ?? "",
          image: document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? "",
        }));
        const title = meta.title
          .replace(/\s*[–—-]\s*Klikkentheke.*$/i, "")
          .replace(/^\d+\s*[–—-]\s*/, "")
          .trim();
        if (title) items.push({ title, url: entryUrl, imageUrl: meta.image || undefined });
      } catch { /* skip */ }
      await page.unroute("**/*");
    }
  } catch (err) { console.warn(`Klikkentheke warning: ${(err as Error).message}`); }
  return { source: "Klikkentheke", items };
}

async function scrapeSankoudesign(page: Page): Promise<ScrapedData> {
  console.log("Scraping Sankou Design...");
  const items: DesignItem[] = [];
  try {
    await page.goto("https://sankoudesign.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const results = await page.evaluate(() => {
      const out: { title: string; url: string; imageUrl: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll<HTMLAnchorElement>("a.detail-link").forEach((a) => {
        const href = a.href;
        if (seen.has(href)) return;
        seen.add(href);
        const container = a.closest("li, article, [class*='post'], div") as Element | null;
        const img = container?.querySelector<HTMLImageElement>("img[alt]");
        const title = (img?.alt || "").trim();
        if (!title) return;
        const imageUrl = img?.getAttribute("data-src") || img?.src || "";
        if (imageUrl.startsWith("data:")) return;
        out.push({ title, url: href, imageUrl });
      });
      return out.slice(0, 8);
    });
    items.push(...results.map((r) => ({ title: r.title, url: r.url, imageUrl: r.imageUrl || undefined })));
  } catch (err) { console.warn(`Sankoudesign warning: ${(err as Error).message}`); }
  return { source: "Sankou Design", items };
}

async function scrapeSiteOfSites(page: Page): Promise<ScrapedData> {
  console.log("Scraping Site of Sites...");
  const items: DesignItem[] = [];
  try {
    await page.goto("https://www.siteofsites.co", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    const results = await page.evaluate(() => {
      const out: { title: string; url: string; imageUrl: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        if (!href.includes("siteofsites.co")) return;
        if (/\/(about|contact|submit|categories)\/?$/.test(href) || href === "https://www.siteofsites.co/") return;
        seen.add(href);
        const title = (a.getAttribute("aria-label") || a.textContent || "").trim();
        if (title.length < 3) return;
        const img = a.querySelector<HTMLImageElement>("img") ?? a.closest("li, article, div")?.querySelector<HTMLImageElement>("img");
        out.push({ title, url: href, imageUrl: img?.src || "" });
      });
      return out.slice(0, 8);
    });
    items.push(...results.map((r) => ({ title: r.title, url: r.url, imageUrl: r.imageUrl || undefined })));
  } catch (err) { console.warn(`Site of Sites warning: ${(err as Error).message}`); }
  return { source: "Site of Sites", items };
}

async function scrapeMinimalGallery(_page: Page): Promise<ScrapedData> {
  console.log("Scraping Minimal Gallery...");
  const items: DesignItem[] = [];
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        "https://minimal.gallery/wp-json/wp/v2/posts?per_page=8&_embed=true",
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
        (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });
    const posts = JSON.parse(body) as Array<{
      title: { rendered: string }; link: string;
      _embedded?: { "wp:featuredmedia"?: Array<{ source_url?: string }> };
    }>;
    for (const post of posts.slice(0, 8)) {
      const title = post.title.rendered.replace(/&amp;/g, "&").replace(/&#[0-9]+;/g, "").trim();
      const imageUrl = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
      items.push({ title, url: post.link, imageUrl: imageUrl || undefined });
    }
  } catch (err) { console.warn(`MinimalGallery warning: ${(err as Error).message}`); }
  return { source: "Minimal Gallery", items };
}

async function scrapeHttpster(_page: Page): Promise<ScrapedData> {
  console.log("Scraping Httpster...");
  const items: DesignItem[] = [];
  try {
    const fetchText = (url: string) => new Promise<string>((resolve, reject) => {
      const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d));
      });
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", (e) => reject(e));
    });

    const jsonBody = await fetchText("https://httpster.net/websites.json");
    const allSites = (JSON.parse(jsonBody) as { websites: Array<{ title: string; url: string }> }).websites;

    // Filter out ad/affiliate links then take first 16
    const sites = allSites
      .filter((s) => !s.url.startsWith("http") || s.url.includes("httpster.net"))
      .slice(0, 8);

    // Fetch og:image from each entry page in parallel
    const results = await Promise.all(sites.map(async (site) => {
      const url = site.url.startsWith("http") ? site.url : `https://httpster.net${site.url}`;
      try {
        const html = await fetchText(url);
        const ogImg = html.match(/og:image"[^>]*content="([^"]+)"/)?.[1] ?? "";
        return { title: site.title, url, imageUrl: ogImg };
      } catch {
        return { title: site.title, url, imageUrl: "" };
      }
    }));

    items.push(...results.map((r) => ({ title: r.title, url: r.url, imageUrl: r.imageUrl || undefined })));
  } catch (err) { console.warn(`Httpster warning: ${(err as Error).message}`); }
  return { source: "Httpster", items };
}

async function scrapeS5Style(_page: Page): Promise<ScrapedData> {
  console.log("Scraping S5 Style...");
  const items: DesignItem[] = [];
  try {
    const xml = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        "https://api.s5-style.com/rss/designs/gwd",
        { headers: { "User-Agent": "Mozilla/5.0" } },
        (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });
    const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    for (const match of itemMatches.slice(0, 8)) {
      const content = match[1];
      const title = content.match(/<title>(.*?)<\/title>/)?.[1]?.trim() || "";
      const link = content.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || "";
      const imgSrc = content.match(/src="([^"]+)"/)?.[1] || "";
      if (title && link) items.push({ title, url: link, imageUrl: imgSrc || undefined });
    }
  } catch (err) { console.warn(`S5Style warning: ${(err as Error).message}`); }
  return { source: "S5 Style", items };
}

async function scrapeTheIndex(page: Page): Promise<ScrapedData> {
  console.log("Scraping The Index...");
  const items: DesignItem[] = [];
  try {
    await page.goto("https://theindex.website/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const studios = await page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return [];
      try {
        const data = JSON.parse(el.textContent || "");
        const list: Array<{
          name: string; slug: { current: string };
          mainImage?: { url: string };
          featuredWork?: Array<{ mainImage?: { url: string } }>;
          websiteUrl?: string;
        }> = data?.props?.pageProps?.pageData?.studios ?? [];
        return list.map((s) => ({
          name: s.name || "",
          slug: s.slug?.current || "",
          imageUrl: s.mainImage?.url || s.featuredWork?.[0]?.mainImage?.url || "",
        }));
      } catch { return []; }
    });
    for (const s of studios.slice(0, 8)) {
      if (!s.name) continue;
      items.push({
        title: s.name,
        url: `https://theindex.website/studio/${s.slug}`,
        imageUrl: s.imageUrl || undefined,
      });
    }
  } catch (err) { console.warn(`TheIndex warning: ${(err as Error).message}`); }
  return { source: "The Index", items };
}

async function scrapeTypewolf(page: Page): Promise<ScrapedData> {
  console.log("Scraping Typewolf...");
  const items: DesignItem[] = [];
  try {
    await page.goto("https://www.typewolf.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const results = await page.evaluate(() => {
      const out: { title: string; url: string; imageUrl: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll<HTMLImageElement>('a[href*="/site-of-the-day/"] img').forEach((img) => {
        const a = img.closest<HTMLAnchorElement>("a");
        if (!a) return;
        const href = a.getAttribute("href") || "";
        const fullUrl = href.startsWith("http") ? href : `https://www.typewolf.com${href}`;
        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);
        const title = img.alt.trim();
        if (!title) return;
        const src = img.getAttribute("src") || "";
        const imageUrl = src.startsWith("http") ? src : `https://www.typewolf.com${src}`;
        out.push({ title, url: fullUrl, imageUrl });
      });
      return out.slice(0, 8);
    });
    items.push(...results.filter((r) => r.title).map((r) => ({
      title: r.title, url: r.url, imageUrl: r.imageUrl || undefined,
    })));
  } catch (err) { console.warn(`Typewolf warning: ${(err as Error).message}`); }
  return { source: "Typewolf", items };
}

async function scrapeBrutalistWebsites(_page: Page): Promise<ScrapedData> {
  console.log("Scraping Brutalist Websites...");
  const items: DesignItem[] = [];
  try {
    const html = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        "https://brutalistwebsites.com",
        { headers: { "User-Agent": "Mozilla/5.0" } },
        (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });
    // Structure: <div class="screenshot"><a href="[url]"><img src="[_img/...jpg]" .../></a></div><p>[Title]</p>
    const matches = [
      ...html.matchAll(
        /<div class="screenshot">\s*<a href="([^"]+)"><img src="(https?:\/\/brutalistwebsites\.com\/_img\/[^"]+)"[^>]*\/><\/a>\s*<\/div>\s*<p>([\s\S]*?)<\/p>/g
      ),
    ];
    const seen = new Set<string>();
    for (const [, url, imgSrc, titleHtml] of matches) {
      if (seen.has(url) || items.length >= 8) break;
      seen.add(url);
      const title = titleHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!title) continue;
      items.push({ title, url, imageUrl: imgSrc });
    }
  } catch (err) { console.warn(`BrutalistWebsites warning: ${(err as Error).message}`); }
  return { source: "Brutalist Websites", items };
}


async function scrapeHoverstates(page: Page): Promise<ScrapedData> {
  console.log("Scraping Hoverstat.es...");
  const items: DesignItem[] = [];
  try {
    await page.goto("https://hoverstat.es", { waitUntil: "domcontentloaded", timeout: 30000 });
    const featureEntries = await page.evaluate(() => {
      const out: { featureUrl: string; title: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/features/"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!href.match(/\/features\/[a-z0-9-]+\//)) return;
        if (seen.has(href)) return;
        seen.add(href);
        const featureUrl = href.startsWith("http") ? href : `https://hoverstat.es${href}`;
        const title = (a.querySelector("h3, h2, h4")?.textContent || a.textContent || "").trim();
        if (title) out.push({ featureUrl, title });
      });
      return out.slice(0, 8);
    });

    for (const entry of featureEntries) {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        route[type === "document" ? "continue" : "abort"]();
      });
      let imageUrl: string | undefined;
      let externalUrl = entry.featureUrl;
      try {
        await page.goto(entry.featureUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        const meta = await page.evaluate(() => ({
          og: document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? "",
          ext: (document.querySelector<HTMLAnchorElement>('a[href^="http"]:not([href*="hoverstat"])')?.href) ?? "",
        }));
        if (meta.og && !meta.og.startsWith("data:")) imageUrl = meta.og;
        if (meta.ext) externalUrl = meta.ext;
      } catch { /* skip */ }
      await page.unroute("**/*");
      items.push({ title: entry.title, url: externalUrl, imageUrl });
    }
  } catch (err) { console.warn(`Hoverstates warning: ${(err as Error).message}`); }
  return { source: "Hoverstat.es", items };
}

async function scrapeBpando(_page: Page): Promise<ScrapedData> {
  console.log("Scraping BP&O...");
  const items: DesignItem[] = [];
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        "https://bpando.org/wp-json/wp/v2/posts?per_page=8&_embed=true",
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
        (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });
    const posts = JSON.parse(body) as Array<{
      title: { rendered: string }; link: string;
      _embedded?: { "wp:featuredmedia"?: Array<{ source_url?: string }> };
    }>;
    for (const post of posts.slice(0, 8)) {
      const title = post.title.rendered.replace(/&amp;/g, "&").replace(/&#[0-9]+;/g, "").replace(/<[^>]+>/g, "").trim();
      const imageUrl = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
      items.push({ title, url: post.link, imageUrl: imageUrl || undefined });
    }
  } catch (err) { console.warn(`BPandO warning: ${(err as Error).message}`); }
  return { source: "BP&O", items };
}

async function scrapeVisualJournal(_page: Page): Promise<ScrapedData> {
  console.log("Scraping Visual Journal...");
  const items: DesignItem[] = [];
  try {
    const html = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        "https://visualjournal.it",
        { headers: { "User-Agent": "Mozilla/5.0" } },
        (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });
    // Structure: <a class="thumb-link" href="[url]"><img class="thumb-image" data-src="[img]" alt="[title] on Visual Journal">
    const matches = [
      ...html.matchAll(
        /<a class="thumb-link" href="(https:\/\/visualjournal\.it\/[^"]+)">\s*<img class="thumb-image" data-src="([^"]+)" alt="([^"]+)"/g
      ),
    ];
    const decodeEntities = (s: string) =>
      s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
       .replace(/&[a-z]+;/g, (m) => ({ "&ocirc;":"ô","&egrave;":"è","&eacute;":"é","&agrave;":"à","&uuml;":"ü","&ouml;":"ö","&auml;":"ä" }[m] ?? ""));
    for (const [, url, imageUrl, altText] of matches) {
      if (items.length >= 8) break;
      const title = decodeEntities(altText.replace(/ on Visual Journal$/i, "").trim());
      if (title) items.push({ title, url, imageUrl });
    }
  } catch (err) { console.warn(`VisualJournal warning: ${(err as Error).message}`); }
  return { source: "Visual Journal", items };
}

// ── Translation ───────────────────────────────────────────────────────────────

interface TranslationResult {
  titleJa: string;
  summaryJa: string;
}

async function translateItems(data: ScrapedData[]): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("ANTHROPIC_API_KEY not set — skipping translation.");
    return;
  }

  const client = new Anthropic({ apiKey });

  const SYSTEM_PROMPT = `あなたはデザイン専門の翻訳者です。英語のデザイン作品・サイト情報を受け取り、以下のJSONフォーマットで返してください。

[
  {
    "titleJa": "日本語タイトル（簡潔に）",
    "summaryJa": "日本語の要約・説明（1〜2文、どんなデザイン作品か、特徴は何かを述べる）"
  },
  ...
]

タイトルが固有名詞・ブランド名の場合はカタカナ表記を使用してください。配列の要素数と順序は入力と完全に一致させてください。JSON以外の文字は含めないでください。`;

  const allItems: Array<{ source: string; index: number; item: DesignItem }> = [];
  for (const section of data) {
    for (let i = 0; i < section.items.length; i++) {
      allItems.push({ source: section.source, index: i, item: section.items[i] });
    }
  }

  const BATCH_SIZE = 10;
  for (let start = 0; start < allItems.length; start += BATCH_SIZE) {
    const batch = allItems.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allItems.length / BATCH_SIZE);
    console.log(`  Translating batch ${batchNum}/${totalBatches}...`);

    const userContent = batch.map((entry, idx) => {
      const parts = [`[${idx + 1}] Source: ${entry.source}`, `Title: ${entry.item.title}`];
      if (entry.item.description) parts.push(`Description: ${entry.item.description}`);
      if (entry.item.tags && entry.item.tags.length > 0) parts.push(`Tags: ${entry.item.tags.join(", ")}`);
      return parts.join("\n");
    }).join("\n\n");

    try {
      const response = await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 2048,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userContent }],
      });

      const raw = response.content.find((b) => b.type === "text")?.text ?? "";
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { console.warn("  Translation: no JSON found in response"); continue; }

      const results: TranslationResult[] = JSON.parse(jsonMatch[0]);
      for (let i = 0; i < batch.length && i < results.length; i++) {
        const { source, index } = batch[i];
        const section = data.find((s) => s.source === source);
        if (section) {
          section.items[index].titleJa = results[i].titleJa;
          section.items[index].summaryJa = results[i].summaryJa;
        }
      }
    } catch (err) {
      console.warn(`  Translation batch ${batchNum} failed: ${(err as Error).message}`);
    }
  }
}

// ── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(
  date: string,
  data: ScrapedData[],
  imageDir: string,
  urlToLocal: Map<string, string>
): string {
  const sectionsHtml = data.map((section) => {
    if (section.items.length === 0) return "";

    const cards = section.items.map((item) => {
      const localFile = item.imageUrl ? urlToLocal.get(item.imageUrl) : undefined;
      const imgTag = localFile
        ? `<img src="${imageDir}/${localFile}" alt="${item.title.replace(/"/g, "&quot;")}" loading="lazy">`
        : `<div class="no-image">No Image</div>`;
      const titleJa = item.titleJa ? `<div class="title-ja">${item.titleJa}</div>` : "";
      const summary = item.summaryJa ? `<div class="summary">${item.summaryJa}</div>` : "";

      return `
        <a class="card" href="${item.url}" target="_blank" rel="noopener">
          <div class="card-img">${imgTag}</div>
          <div class="card-body">
            ${titleJa}
            <div class="title-en">${item.title}</div>
            ${summary}
          </div>
        </a>`;
    }).join("");

    return `
      <section>
        <h2>${section.source}</h2>
        <div class="grid">${cards}</div>
      </section>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Design Trends — ${date}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f6f6;
      color: #1a1a1a;
      padding: 40px 24px;
    }
    h1 {
      font-size: 1.6rem;
      font-weight: 700;
      margin-bottom: 4px;
      color: #111;
    }
    .meta { font-size: 0.8rem; color: #999; margin-bottom: 48px; }
    section { margin-bottom: 56px; }
    h2 {
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #aaa;
      margin-bottom: 20px;
      padding-bottom: 8px;
      border-bottom: 1px solid #ddd;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 12px;
    }
    .card {
      background: #fff;
      border-radius: 0;
      overflow: hidden;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
    }
    .card:hover {}
    .card-img { aspect-ratio: 4/3; overflow: hidden; background: #eee; }
    .card-img img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: 1; transition: opacity 0.2s; }
    .card:hover .card-img img { opacity: 0.7; }
    .no-image {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.75rem; color: #bbb;
    }
    .card-body { padding: 10px 12px; flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .title-ja { font-size: 0.82rem; font-weight: 600; color: #111; line-height: 1.3; transition: color 0.2s; }
    .title-en { font-size: 0.75rem; color: #666; line-height: 1.3; transition: color 0.2s; }
    .summary { font-size: 0.75rem; color: #888; line-height: 1.5; margin-top: 3px; }
    .card:hover .title-ja { color: #ccc; }
    .card:hover .title-en { color: #ccc; }
  </style>
</head>
<body>
  <h1>Design Trends — ${date}</h1>
  <div class="meta">Generated on ${new Date().toISOString()}</div>
  ${sectionsHtml}
</body>
</html>`;
}

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown(
  date: string,
  data: ScrapedData[],
  imageDir: string,
  urlToLocal: Map<string, string>
): string {
  const lines: string[] = [
    `# Design Trends — ${date}`,
    "",
    `> Generated on ${new Date().toISOString()}`,
    "",
  ];

  for (const section of data) {
    lines.push(`## ${section.source}`);
    lines.push("");

    if (section.items.length === 0) {
      lines.push("_No items collected._");
      lines.push("");
      continue;
    }

    section.items.forEach((item, i) => {
      const heading = item.titleJa ? `${item.titleJa} / ${item.title}` : item.title;
      lines.push(`### ${i + 1}. [${heading}](${item.url})`);

      if (item.imageUrl) {
        const localFile = urlToLocal.get(item.imageUrl);
        if (localFile) {
          lines.push(`![${item.title}](${imageDir}/${localFile})`);
        }
      }

      if (item.summaryJa) lines.push(item.summaryJa);
      if (item.description) lines.push(item.description);
      if (item.tags && item.tags.length > 0) {
        lines.push(`**Tags:** ${item.tags.join(", ")}`);
      }
      lines.push("");
    });
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const isCI = process.env.CI === "true";

  // CI（GitHub Actions）のときは docs/ に固定出力、ローカルは outputs/ に日付付きで出力
  const outputDir = isCI
    ? path.resolve(__dirname, "../docs")
    : path.resolve(__dirname, "../outputs");
  const imageDirAbs = isCI
    ? path.join(outputDir, "images")
    : path.join(outputDir, "images", today);
  const imageDirRel = isCI ? "images" : `images/${today}`;
  const outputPath = isCI
    ? null
    : path.join(outputDir, `${today}-design-trends.md`);

  fs.mkdirSync(outputDir, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
  });

  const results: ScrapedData[] = [];

  try {
    const page1 = await context.newPage();
    results.push(await scrapeSiteInspire(page1));
    await page1.close();

    const page3 = await context.newPage();
    results.push(await scrapeBehance(page3));
    await page3.close();

    const page5 = await context.newPage();
    results.push(await scrapeItsNiceThat(page5));
    await page5.close();

    const page6 = await context.newPage();
    results.push(await scrapeMinimalissimo(page6));
    await page6.close();

    const page7 = await context.newPage();
    results.push(await scrapeMinimalSites(page7));
    await page7.close();

    const page8 = await context.newPage();
    results.push(await scrapeSiiimple(page8));
    await page8.close();

    const page9 = await context.newPage();
    results.push(await scrapeKlikkentheke(page9));
    await page9.close();

    // Site of Sites uses Wix (fully JS-rendered), skipping

    const page12 = await context.newPage();
    results.push(await scrapeMinimalGallery(page12));
    await page12.close();

    const page13 = await context.newPage();
    results.push(await scrapeHttpster(page13));
    await page13.close();

    const page2 = await context.newPage();
    results.push(await scrapeDribbble(page2));
    await page2.close();

    const page4 = await context.newPage();
    results.push(await scrapeBrandNew(page4));
    await page4.close();

    const page15 = await context.newPage();
    results.push(await scrapeTheIndex(page15));
    await page15.close();

    const pageTW = await context.newPage();
    results.push(await scrapeTypewolf(pageTW));
    await pageTW.close();

    const pageBR = await context.newPage();
    results.push(await scrapeBrutalistWebsites(pageBR));
    await pageBR.close();

    const pageHS = await context.newPage();
    results.push(await scrapeHoverstates(pageHS));
    await pageHS.close();

    const pageBP = await context.newPage();
    results.push(await scrapeBpando(pageBP));
    await pageBP.close();

    const pageVJ = await context.newPage();
    results.push(await scrapeVisualJournal(pageVJ));
    await pageVJ.close();

    const page14 = await context.newPage();
    results.push(await scrapeS5Style(page14));
    await page14.close();

    const page16 = await context.newPage();
    results.push(await scrapeSankoudesign(page16));
    await page16.close();
  } finally {
    await browser.close();
  }

  console.log("\nDownloading images...");
  const urlToLocal = await downloadAllImages(results, imageDirAbs);

  console.log("\nTranslating to Japanese...");
  await translateItems(results);

  if (outputPath) {
    const markdown = buildMarkdown(today, results, imageDirRel, urlToLocal);
    fs.writeFileSync(outputPath, markdown, "utf-8");
  }

  const htmlPath = isCI
    ? path.join(outputDir, "index.html")
    : path.join(outputDir, `${today}-design-trends.html`);
  const html = buildHtml(today, results, imageDirRel, urlToLocal);
  fs.writeFileSync(htmlPath, html, "utf-8");

  const totalItems = results.reduce((sum, r) => sum + r.items.length, 0);
  console.log(`\nDone! Collected ${totalItems} items, ${urlToLocal.size} images.`);
  if (outputPath) console.log(`Saved to: ${outputPath}`);
  console.log(`HTML:     ${htmlPath}`);

  if (!isCI) {
    const { exec } = require("child_process");
    exec(`open "${htmlPath}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

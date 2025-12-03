// WeWorkRemotely jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://weworkremotely.com';

// ------------------------
// Generic helpers
// ------------------------

const toAbs = (href, base = BASE_URL) => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

// Clean HTML -> plain text
const cleanText = (html) => {
    if (!html) return '';
    const $ = cheerioLoad(html);
    $('script, style, noscript, iframe').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

// Keep only text-related tags in description_html
// Allowed: p, br, strong, b, em, i, ul, ol, li, a
const sanitizeDescriptionHtml = (html) => {
    if (!html) return null;

    const $ = cheerioLoad('<div id="__root__"></div>');
    const root = $('#__root__');
    root.html(html);

    // Remove obviously non-content elements
    root
        .find(
            'script, style, noscript, iframe, canvas, svg, form, button, input, select, textarea, meta, link, head, title'
        )
        .remove();

    const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'a']);

    root.find('*').each((_, el) => {
        const tag = (el.tagName || el.name || '').toLowerCase();
        const $el = root.find(el);

        if (!ALLOWED_TAGS.has(tag)) {
            // unwrap element: keep children, remove wrapper
            const children = $el.contents();
            $el.replaceWith(children);
            return;
        }

        // Strip all attributes except href on <a>
        const attribs = el.attribs || {};
        for (const name of Object.keys(attribs)) {
            if (!(tag === 'a' && name.toLowerCase() === 'href')) {
                $el.removeAttr(name);
            }
        }
    });

    let result = root.html() || '';
    result = result.trim();
    result = result.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n');

    return result || null;
};

// Salary parser -> splits into salary_text, min, max, currency, interval
const parseSalary = (raw) => {
    if (!raw && raw !== 0) {
        return {
            salary_text: null,
            salary_min: null,
            salary_max: null,
            salary_currency: null,
            salary_interval: null,
        };
    }

    const text = String(raw).replace(/\s+/g, ' ').trim();
    if (!text) {
        return {
            salary_text: null,
            salary_min: null,
            salary_max: null,
            salary_currency: null,
            salary_interval: null,
        };
    }

    // Currency detection
    let currency = null;
    const currencyMatch =
        text.match(/\b(USD|EUR|GBP|CAD|AUD|CHF|JPY)\b/i) || text.match(/[$€£¥]/);

    if (currencyMatch) {
        const cur = (currencyMatch[1] || currencyMatch[0]).toUpperCase();
        switch (cur) {
            case 'USD':
            case '$':
                currency = 'USD';
                break;
            case 'EUR':
            case '€':
                currency = 'EUR';
                break;
            case 'GBP':
            case '£':
                currency = 'GBP';
                break;
            case 'CAD':
                currency = 'CAD';
                break;
            case 'AUD':
                currency = 'AUD';
                break;
            case 'CHF':
                currency = 'CHF';
                break;
            case 'JPY':
            case '¥':
                currency = 'JPY';
                break;
            default:
                currency = null;
        }
    }

    // Interval detection
    let interval = null;
    const lower = text.toLowerCase();

    if (/\b(per|a|an)\s+year\b/.test(lower) || /\bannual(ly)?\b/.test(lower) || /\byearly\b/.test(lower)) {
        interval = 'year';
    } else if (/\b(per|a|an)\s+month\b/.test(lower) || /\bmonthly\b/.test(lower)) {
        interval = 'month';
    } else if (/\b(per|a|an)\s+week\b/.test(lower) || /\bweekly\b/.test(lower)) {
        interval = 'week';
    } else if (/\b(per|a|an)\s+day\b/.test(lower) || /\bdaily\b/.test(lower)) {
        interval = 'day';
    } else if (/\b(per|a|an)\s+hour\b/.test(lower) || /\bhourly\b/.test(lower)) {
        interval = 'hour';
    }

    // Numeric extraction (supports "80,000", "80k", etc.)
    const nums = [];
    const numRegex = /(\d[\d,\.]*\s*k?)/gi;
    let match;
    while ((match = numRegex.exec(text)) !== null) {
        let numStr = match[1].toLowerCase().replace(/,/g, '').trim();
        let multiplier = 1;
        if (numStr.endsWith('k')) {
            multiplier = 1000;
            numStr = numStr.slice(0, -1);
        }
        const parsed = parseFloat(numStr);
        if (!Number.isNaN(parsed)) nums.push(parsed * multiplier);
    }

    let min = null;
    let max = null;
    if (nums.length === 1) {
        min = nums[0];
        max = nums[0];
    } else if (nums.length >= 2) {
        min = Math.min(nums[0], nums[1]);
        max = Math.max(nums[0], nums[1]);
    }

    if (!interval && min && min > 1000) {
        interval = 'year';
    }

    return {
        salary_text: text,
        salary_min: min || null,
        salary_max: max || null,
        salary_currency: currency,
        salary_interval: interval,
    };
};

const buildStartUrl = (cat) => {
    const categorySlug = cat ? String(cat).trim() : 'all-other-remote-jobs';
    return `${BASE_URL}/categories/${categorySlug}`;
};

// ------------------------
// JSON-LD extraction
// ------------------------

const extractFromJsonLd = ($) => {
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
        try {
            const raw = $(scripts[i]).html() || '';
            if (!raw.trim()) continue;

            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : [parsed];

            for (const e of arr) {
                if (!e) continue;
                const t = e['@type'] || e.type;
                const types = Array.isArray(t) ? t : [t];
                if (!types.includes('JobPosting')) continue;

                // Salary text from JSON-LD
                let salaryText = null;
                if (e.baseSalary) {
                    const val = e.baseSalary.value || e.baseSalary;
                    if (typeof val === 'string') {
                        salaryText = val;
                    } else if (val && typeof val === 'object') {
                        const pieces = [];
                        if (val.minValue != null && val.maxValue != null) {
                            pieces.push(`${val.minValue} - ${val.maxValue}`);
                        } else if (val.value != null) {
                            pieces.push(String(val.value));
                        }
                        const currency = e.baseSalary.currency || val.currency;
                        if (currency) pieces.unshift(currency);
                        salaryText = pieces.join(' ');
                    }
                }

                // Location from JSON-LD
                let location = null;
                if (e.jobLocation) {
                    const loc = Array.isArray(e.jobLocation) ? e.jobLocation[0] : e.jobLocation;
                    const addr = loc && loc.address;
                    if (addr) {
                        location =
                            addr.addressLocality ||
                            addr.addressRegion ||
                            addr.addressCountry ||
                            null;
                    }
                }

                const descHtml = e.description ? sanitizeDescriptionHtml(e.description) : null;
                const employment = e.employmentType;
                const jobType = Array.isArray(employment) ? employment.join(', ') : employment || null;

                return {
                    title: e.title || e.name || null,
                    company: e.hiringOrganization?.name || null,
                    date_posted: e.datePosted || null,
                    description_html: descHtml,
                    location: location,
                    salary_text: salaryText,
                    job_type: jobType,
                };
            }
        } catch {
            // ignore JSON-LD parsing errors
        }
    }
    return null;
};

// ------------------------
// WWR-specific extraction helpers
// ------------------------

// Collect job detail links from a list page
const findJobLinks = ($, base) => {
    const links = new Set();
    $('a[href*="/remote-jobs/"]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        if (/\/remote-jobs\/[^\/?#]+$/i.test(href)) {
            const abs = toAbs(href, base);
            if (abs) links.add(abs);
        }
    });
    return [...links];
};

const findNextPage = (currentUrl, currentPageNo) => {
    try {
        const url = new URL(currentUrl);
        const nextPageNo = currentPageNo + 1;
        url.searchParams.set('page', String(nextPageNo));
        return url.href;
    } catch {
        return null;
    }
};

// Extract company name with heuristics (fixes "We're Walter!" case)
const extractCompany = ($, title) => {
    // 1) Prefer clean, explicit selectors
    const selectors = [
        'a[href*="/company/"]',
        '.company-name',
        '.company h2',
        '.company h3',
        '.listing-company a',
    ];

    for (const sel of selectors) {
        const txt = $(sel).first().text().replace(/\s+/g, ' ').trim();
        if (txt && txt.length <= 80) {
            return txt;
        }
    }

    // 2) Fallback: parse from header text
    const headerText = $('.listing-header-container')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim();

    if (!headerText) return null;

    // Try "We're X" / "We are X"
    const weMatch = headerText.match(/We(?:'re| are)\s+([A-Z][A-Za-z0-9 &\-]{1,60})[!.,]/);
    if (weMatch) return weMatch[1].trim();

    // Remove title prefix if present
    let candidate = headerText;
    if (title && candidate.startsWith(title)) {
        candidate = candidate.slice(title.length).trim();
    }

    // Cut off "Posted ..." section
    candidate = candidate.replace(/Posted\s+\d+.*?(ago)?/i, '').trim();
    // Remove "Apply now" and similar CTA
    candidate = candidate.replace(/Apply now.*$/i, '').trim();

    if (candidate.length > 80) return null;
    return candidate || null;
};

// Extract date_posted with multiple fallbacks
const extractDatePosted = ($, jsonDate) => {
    if (jsonDate) return jsonDate;

    // 1) <time datetime="...">
    const dtAttr =
        $('.listing-header-container time[datetime]')
            .first()
            .attr('datetime') ||
        $('time[datetime]').first().attr('datetime');
    if (dtAttr && dtAttr.trim()) return dtAttr.trim();

    // 2) time element text
    const timeText =
        $('.listing-header-container time').first().text().trim() ||
        $('time').first().text().trim();
    if (timeText) return timeText;

    // 3) "Posted X ago" in header text
    const headerText = $('.listing-header-container')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
    if (headerText) {
        const postedMatch = headerText.match(/Posted\s+(.+?)(?:\s+ago|$)/i);
        if (postedMatch && postedMatch[1]) return `Posted ${postedMatch[1].trim()}`;
    }

    // 4) Meta tags
    const metaDate =
        $('meta[property="article:published_time"]').attr('content') ||
        $('meta[name="date"]').attr('content') ||
        null;
    if (metaDate && metaDate.trim()) return metaDate.trim();

    return null;
};

// Extract job type from tags/labels around header
const extractJobType = ($, jsonJobType) => {
    if (jsonJobType) return jsonJobType;

    const pieces = new Set();

    $('.listing-header-container .listing-tag').each((_, el) => {
        const t = cheerioLoad(el).root().text().replace(/\s+/g, ' ').trim();
        if (t) pieces.add(t);
    });

    $('.listing-tag').each((_, el) => {
        const t = cheerioLoad(el).root().text().replace(/\s+/g, ' ').trim();
        if (t) pieces.add(t);
    });

    $('ul.listing-tags li').each((_, el) => {
        const t = cheerioLoad(el).root().text().replace(/\s+/g, ' ').trim();
        if (t) pieces.add(t);
    });

    $('[class*="employment"], [class*="job-type"]').each((_, el) => {
        const t = cheerioLoad(el).root().text().replace(/\s+/g, ' ').trim();
        if (t) pieces.add(t);
    });

    const all = [...pieces];
    if (!all.length) return null;

    // Prefer entries that clearly look like job types
    const preferred = all.find((t) =>
        /(full[\s-]?time|part[\s-]?time|contract|freelance|temporary|intern(ship)?)/i.test(t)
    );
    return preferred || all.join(' | ');
};

// Pick best description container (longest sanitized text)
const extractBestDescriptionHtml = ($) => {
    const selectors = [
        '.listing-container--description',
        '.listing-container .listing-body',
        '.listing-container',
        '#job-description',
        '[data-id="job-description"]',
        '[class*="job-description"]',
        '.description',
        'article',
    ];

    let bestHtml = null;
    let bestLen = 0;

    for (const sel of selectors) {
        const el = $(sel).first();
        if (!el || !el.length) continue;

        const raw = String(el.html() || '').trim();
        if (!raw) continue;

        const sanitized = sanitizeDescriptionHtml(raw);
        if (!sanitized) continue;

        const len = cleanText(sanitized).length;
        if (len > bestLen) {
            bestLen = len;
            bestHtml = sanitized;
        }
    }

    return bestHtml;
};

// ------------------------
// Main actor
// ------------------------

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        category = 'all-other-remote-jobs',
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 999,
        collectDetails = true,
        startUrl,
        startUrls,
        url,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
        ? Math.max(1, +RESULTS_WANTED_RAW)
        : Number.MAX_SAFE_INTEGER;

    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
        ? Math.max(1, +MAX_PAGES_RAW)
        : 999;

    // Initial URLs
    const initial = [];
    if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
    if (startUrl) initial.push(startUrl);
    if (url) initial.push(url);
    if (!initial.length) initial.push(buildStartUrl(category));

    const proxyConf = proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
        : undefined;

    let saved = 0;

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxRequestRetries: 3,
        useSessionPool: true,
        maxConcurrency: 10,
        requestHandlerTimeoutSecs: 60,
        preNavigationHooks: [
            async ({ request }) => {
                request.headers = {
                    ...(request.headers || {}),
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                };
            },
        ],
        async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            if (label === 'LIST') {
                const links = findJobLinks($, request.url);
                crawlerLog.info(`LIST ${request.url} -> found ${links.length} job links`);

                if (saved >= RESULTS_WANTED) {
                    crawlerLog.debug(
                        `LIST reached RESULTS_WANTED (${RESULTS_WANTED}). Skipping further processing.`
                    );
                    return;
                }

                const remaining = RESULTS_WANTED - saved;

                if (collectDetails) {
                    const toEnqueue = links.slice(0, Math.max(0, remaining));
                    if (toEnqueue.length) {
                        await enqueueLinks({
                            urls: toEnqueue,
                            userData: { label: 'DETAIL' },
                        });
                    }
                } else {
                    const toPush = links.slice(0, Math.max(0, remaining));
                    if (toPush.length) {
                        await Dataset.pushData(
                            toPush.map((u) => ({
                                url: u,
                                _source: 'weworkremotely.com',
                            }))
                        );
                        saved += toPush.length;
                    }
                }

                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                    const next = findNextPage(request.url, pageNo);
                    if (next) {
                        await enqueueLinks({
                            urls: [next],
                            userData: { label: 'LIST', pageNo: pageNo + 1 },
                        });
                    }
                }
                return;
            }

            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) {
                    crawlerLog.debug(
                        `DETAIL ${request.url} skipped (RESULTS_WANTED reached).`
                    );
                    return;
                }

                try {
                    const json = extractFromJsonLd($) || {};
                    const data = { ...json };

                    // TITLE
                    if (!data.title) {
                        data.title =
                            $('h1').first().text().trim() ||
                            $('h2.title').first().text().trim() ||
                            $('.listing-header-container h1').first().text().trim() ||
                            $('.listing-header h1').first().text().trim() ||
                            null;
                    }

                    // COMPANY (with heuristics)
                    if (!data.company) {
                        data.company = extractCompany($, data.title);
                    }

                    // DESCRIPTION HTML (use best container, always sanitized)
                    if (!data.description_html) {
                        data.description_html = extractBestDescriptionHtml($);
                    } else {
                        data.description_html = sanitizeDescriptionHtml(
                            data.description_html
                        );
                    }

                    // DESCRIPTION TEXT
                    data.description_text = data.description_html
                        ? cleanText(data.description_html)
                        : null;

                    // LOCATION
                    if (!data.location) {
                        data.location =
                            $('.region').first().text().trim() ||
                            $('[class*="location"]').first().text().trim() ||
                            'Remote';
                    }

                    // DATE POSTED
                    data.date_posted = extractDatePosted($, data.date_posted);

                    // JOB TYPE
                    data.job_type = extractJobType($, data.job_type);

                    // SALARY
                    let salaryText = data.salary_text || null;
                    if (!salaryText) {
                        const salaryDom =
                            $('.compensation').first().text().trim() ||
                            $('[class*="salary"]').first().text().trim() ||
                            null;
                        salaryText = salaryDom || null;
                    }
                    const salaryParsed = parseSalary(salaryText);

                    // CATEGORY
                    const jobCategory =
                        $('.listing-header-container a[href*="/categories/"]')
                            .first()
                            .text()
                            .trim() ||
                        category ||
                        null;

                    const item = {
                        title: data.title || null,
                        company: data.company || null,
                        category: jobCategory,
                        location: data.location || null,
                        salary: salaryParsed.salary_text, // backward compatible
                        salary_text: salaryParsed.salary_text,
                        salary_min: salaryParsed.salary_min,
                        salary_max: salaryParsed.salary_max,
                        salary_currency: salaryParsed.salary_currency,
                        salary_interval: salaryParsed.salary_interval,
                        job_type: data.job_type || null,
                        date_posted: data.date_posted || null,
                        description_html: data.description_html || null,
                        description_text: data.description_text || null,
                        url: request.url,
                        _source: 'weworkremotely.com',
                    };

                    await Dataset.pushData(item);
                    saved += 1;
                    crawlerLog.debug(
                        `DETAIL saved (${saved}/${RESULTS_WANTED}): ${request.url}`
                    );
                } catch (err) {
                    crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                }
            }
        },
    });

    await crawler.run(
        initial.map((u) => ({
            url: u,
            userData: { label: 'LIST', pageNo: 1 },
        }))
    );

    log.info(`Finished. Saved ${saved} items`);
});

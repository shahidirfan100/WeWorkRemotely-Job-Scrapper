// WeWorkRemotely jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://weworkremotely.com';

// Helper: absolute URL
const toAbs = (href, base = BASE_URL) => {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
};

// Helper: clean HTML → plain text
const cleanText = (html) => {
    if (!html) return '';
    const $ = cheerioLoad(html);
    $('script, style, noscript, iframe').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

// Helper: salary parser
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
    const currencyMatch = text.match(/\b(USD|EUR|GBP|CAD|AUD|CHF|JPY)\b/i)
        || text.match(/[$€£¥]/);

    if (currencyMatch) {
        const cur = currencyMatch[1] || currencyMatch[0];
        switch (cur.toUpperCase()) {
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

    // Interval detection (per year / hour / etc.)
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

    // Numeric extraction (supports "80,000", "80k", "80.5", etc.)
    const numberFragments = [];
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
        if (!Number.isNaN(parsed)) {
            numberFragments.push(parsed * multiplier);
        }
    }

    let min = null;
    let max = null;
    if (numberFragments.length === 1) {
        min = numberFragments[0];
        max = numberFragments[0];
    } else if (numberFragments.length >= 2) {
        // Take first two as range
        min = Math.min(numberFragments[0], numberFragments[1]);
        max = Math.max(numberFragments[0], numberFragments[1]);
    }

    // If no explicit interval but looks like a yearly salary, guess "year"
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

// Helper: build default category URL
const buildStartUrl = (cat) => {
    const categorySlug = cat ? String(cat).trim() : 'all-other-remote-jobs';
    return `${BASE_URL}/categories/${categorySlug}`;
};

// Extract from JSON-LD
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
                        location = addr.addressLocality || addr.addressRegion || addr.addressCountry || null;
                    }
                }

                return {
                    title: e.title || e.name || null,
                    company: e.hiringOrganization?.name || null,
                    date_posted: e.datePosted || null,
                    description_html: e.description || null,
                    location: location,
                    salary_text: salaryText,
                    job_type: e.employmentType || null,
                };
            }
        } catch {
            // ignore JSON-LD parsing errors
        }
    }
    return null;
};

// Collect job detail links from a list page
const findJobLinks = ($, base) => {
    const links = new Set();

    $('a[href*="/remote-jobs/"]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        // Ensure it's a job detail page (no trailing slash / extra segments)
        if (/\/remote-jobs\/[^\/?#]+$/i.test(href)) {
            const abs = toAbs(href, base);
            if (abs) links.add(abs);
        }
    });

    return [...links];
};

// Build next page URL
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

    // Build initial URLs
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
                // Simple but realistic headers for "stealth"
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
                    crawlerLog.debug(`LIST reached RESULTS_WANTED (${RESULTS_WANTED}). Skipping further processing.`);
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
                            })),
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
                    crawlerLog.debug(`DETAIL ${request.url} skipped (RESULTS_WANTED reached).`);
                    return;
                }

                try {
                    const json = extractFromJsonLd($) || {};
                    const data = { ...json };

                    // TITLE
                    if (!data.title) {
                        data.title =
                            $('h1').first().text().trim()
                            || $('h2.title').first().text().trim()
                            || $('.listing-header-container h1').first().text().trim()
                            || null;
                    }

                    // COMPANY
                    if (!data.company) {
                        data.company =
                            $('.listing-header-container h2').first().text().trim()
                            || $('a[href*="/company/"]').first().text().trim()
                            || $('.company h2').first().text().trim()
                            || $('.company-name').first().text().trim()
                            || null;
                    }

                    // DESCRIPTION HTML
                    if (!data.description_html) {
                        let desc =
                            $('.listing-container--description').first();
                        if (!desc || !desc.length) {
                            desc =
                                $('.listing-container').first()
                                || $('#job-description').first()
                                || $('[class*="job-description"]').first()
                                || $('.description').first();
                        }
                        if (!desc || !desc.length) {
                            desc = $('article').first();
                        }
                        data.description_html = desc && desc.length ? String(desc.html()).trim() : null;
                    }

                    // DESCRIPTION TEXT
                    data.description_text = data.description_html ? cleanText(data.description_html) : null;

                    // LOCATION
                    if (!data.location) {
                        data.location =
                            $('.region').first().text().trim()
                            || $('[class*="location"]').first().text().trim()
                            || 'Remote';
                    }

                    // DATE POSTED
                    if (!data.date_posted) {
                        const timeEl = $('.listing-header-container time, time').first();
                        const datetime = timeEl.attr('datetime');
                        const timeText = timeEl.text().trim();
                        data.date_posted = datetime || timeText || null;
                    }

                    // JOB TYPE
                    if (!data.job_type) {
                        data.job_type =
                            $('.listing-tag').first().text().trim()
                            || $('[class*="tag"]').first().text().trim()
                            || null;
                    }

                    // SALARY
                    let salaryText = data.salary_text || null;
                    if (!salaryText) {
                        const salaryDom =
                            $('.compensation').first().text().trim()
                            || $('[class*="salary"]').first().text().trim()
                            || null;
                        salaryText = salaryDom || null;
                    }

                    const salaryParsed = parseSalary(salaryText);

                    // CATEGORY
                    const jobCategory =
                        $('.listing-header-container a[href*="/categories/"]').first().text().trim()
                        || category
                        || null;

                    const item = {
                        title: data.title || null,
                        company: data.company || null,
                        category: jobCategory,
                        location: data.location || null,
                        // salary - keep raw + split fields
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
                    crawlerLog.debug(`DETAIL saved (${saved}/${RESULTS_WANTED}): ${request.url}`);
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
        })),
    );

    log.info(`Finished. Saved ${saved} items`);
});

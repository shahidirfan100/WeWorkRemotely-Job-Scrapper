// WeWorkRemotely jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            category = 'all-other-remote-jobs', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://weworkremotely.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (cat) => {
            const categorySlug = cat ? String(cat).trim() : 'all-other-remote-jobs';
            return `https://weworkremotely.com/categories/${categorySlug}`;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(category));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value?.value || e.baseSalary?.value || null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            // WeWorkRemotely specific selectors - job listings are in <li> elements with links
            $('a[href*="/remote-jobs/"]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Only include actual job detail pages, not company pages
                if (/\/remote-jobs\/[^\/]+$/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, base, currentPageNo) {
            // WeWorkRemotely uses page numbers in URL like /categories/all-other-remote-jobs?page=2
            const nextPageNo = currentPageNo + 1;
            const currentUrl = new URL(base);
            currentUrl.searchParams.set('page', nextPageNo.toString());
            return currentUrl.href;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) { await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'weworkremotely.com' }))); saved += toPush.length; }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                        const next = findNextPage($, request.url, pageNo);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        
                        // WeWorkRemotely specific selectors
                        if (!data.title) data.title = $('h1').first().text().trim() || $('h2.title').first().text().trim() || null;
                        
                        // Company name
                        if (!data.company) {
                            data.company = $('a[href*="/company/"]').first().text().trim() || 
                                         $('.company h2').first().text().trim() || 
                                         $('.company-name').first().text().trim() || null;
                        }
                        
                        // Job description
                        if (!data.description_html) { 
                            const desc = $('.listing-container').first() || 
                                       $('#job-description').first() || 
                                       $('[class*="job-description"]').first() || 
                                       $('.description').first();
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null;
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        
                        // Location
                        if (!data.location) {
                            data.location = $('.region').first().text().trim() || 
                                          $('[class*="location"]').first().text().trim() || 
                                          'Remote' || null;
                        }
                        
                        // Date posted
                        if (!data.date_posted) {
                            const dateText = $('.listing-header-container time, time').first().attr('datetime') || 
                                           $('.listing-header-container time, time').first().text().trim() || null;
                            data.date_posted = dateText;
                        }
                        
                        // Job type
                        if (!data.job_type) {
                            data.job_type = $('.listing-tag').first().text().trim() || null;
                        }
                        
                        // Salary
                        if (!data.salary) {
                            const salaryText = $('.compensation').first().text().trim() || 
                                             $('[class*="salary"]').first().text().trim() || null;
                            data.salary = salaryText;
                        }
                        
                        // Category
                        const jobCategory = $('.listing-header-container a[href*="/categories/"]').first().text().trim() || 
                                          category || null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: jobCategory,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });

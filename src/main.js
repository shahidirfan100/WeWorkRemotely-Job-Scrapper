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
            category = 'all-other-remote-jobs', keyword = '', location = '', results_wanted: RESULTS_WANTED_RAW = 100,
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

        const parseSalary = (salaryText) => {
            if (!salaryText) return { min_salary: null, max_salary: null, currency: null, salary_text: null };
            
            const text = String(salaryText).trim();
            const result = { min_salary: null, max_salary: null, currency: 'USD', salary_text: text };
            
            // Extract currency
            if (/USD|\$/i.test(text)) result.currency = 'USD';
            else if (/EUR|€/i.test(text)) result.currency = 'EUR';
            else if (/GBP|£/i.test(text)) result.currency = 'GBP';
            
            // Extract salary range
            const rangeMatch = text.match(/(\$?[\d,]+)(?:\s*(?:-|to)\s*(\$?[\d,]+))?/i);
            if (rangeMatch) {
                const min = rangeMatch[1].replace(/[^\d]/g, '');
                const max = rangeMatch[2] ? rangeMatch[2].replace(/[^\d]/g, '') : null;
                result.min_salary = min ? parseInt(min, 10) : null;
                result.max_salary = max ? parseInt(max, 10) : null;
            }
            
            // Check for hourly rate
            if (/hour|hr/i.test(text)) {
                result.salary_text = text + ' (hourly)';
            }
            
            return result;
        };

        const buildStartUrl = (cat, kw, loc) => {
            // If keyword is provided, use search page
            if (kw && String(kw).trim()) {
                const searchUrl = new URL('https://weworkremotely.com/remote-jobs/search');
                searchUrl.searchParams.set('term', String(kw).trim());
                if (loc && String(loc).trim()) {
                    searchUrl.searchParams.set('region', String(loc).trim());
                }
                return searchUrl.href;
            }
            // Otherwise use category page
            const categorySlug = cat ? String(cat).trim() : 'all-other-remote-jobs';
            return `https://weworkremotely.com/categories/${categorySlug}`;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(category, keyword, location));

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
                        
                        // Title - try multiple selectors
                        if (!data.title) {
                            data.title = $('h1').first().text().trim() || 
                                       $('h1.listing-header').first().text().trim() ||
                                       $('.listing-header h1').first().text().trim() || null;
                        }
                        
                        // Company name - improved selectors
                        if (!data.company) {
                            const companyLink = $('a[href*="/company/"]').first();
                            data.company = companyLink.text().trim();
                            
                            if (!data.company) {
                                // Try alternative selectors
                                const companyDiv = $('.company');
                                if (companyDiv.length) {
                                    // Get the company name, excluding other text
                                    data.company = companyDiv.find('h2, h3').first().text().trim() || 
                                                 companyDiv.contents().filter(function() {
                                                     return this.type === 'text';
                                                 }).text().trim() || null;
                                }
                            }
                        }
                        
                        // Job description - improved extraction
                        if (!data.description_html) {
                            // Try to find the main job description container
                            let descContainer = $('#job-details').first();
                            if (!descContainer.length) descContainer = $('.listing-container').first();
                            if (!descContainer.length) descContainer = $('[class*="job-description"]').first();
                            if (!descContainer.length) descContainer = $('.job-details').first();
                            
                            if (descContainer.length) {
                                // Remove unwanted sections
                                const clone = descContainer.clone();
                                clone.find('.listing-header-container, .apply-section, .related-jobs, script, style').remove();
                                data.description_html = clone.html() ? String(clone.html()).trim() : null;
                            }
                            
                            // Fallback: get all text between header and footer
                            if (!data.description_html) {
                                const bodyText = $('body').html();
                                data.description_html = bodyText ? String(bodyText).trim() : null;
                            }
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        
                        // Location - better extraction
                        if (!data.location) {
                            // Look for region info
                            const regionSpan = $('.region, .location, [class*="region"]').first();
                            data.location = regionSpan.text().trim();
                            
                            if (!data.location) {
                                // Try to find in the listing info
                                const listingInfo = $('.listing-header-container, .job-info').text();
                                const regionMatch = listingInfo.match(/(?:Region|Location)\s*:?\s*([^\n]+)/i);
                                data.location = regionMatch ? regionMatch[1].trim() : 'Anywhere in the World';
                            }
                        }
                        
                        // Date posted - improved extraction
                        if (!data.date_posted) {
                            // Try datetime attribute first
                            const timeEl = $('time').first();
                            data.date_posted = timeEl.attr('datetime') || timeEl.text().trim();
                            
                            if (!data.date_posted) {
                                // Look for "Posted on" text
                                const postedText = $('.listing-header-container, .job-info').text();
                                const dateMatch = postedText.match(/Posted\s+(?:on\s+)?([^\n]+?)(?:\s+Apply|$)/i);
                                data.date_posted = dateMatch ? dateMatch[1].trim() : null;
                            }
                        }
                        
                        // Job type - improved extraction
                        if (!data.job_type) {
                            // Look for job type in various places
                            const jobTypeEl = $('.listing-tag, .job-type, [class*="job-type"]').first();
                            data.job_type = jobTypeEl.text().trim();
                            
                            if (!data.job_type) {
                                // Try to extract from listing info
                                const listingInfo = $('.listing-header-container, .job-info').text();
                                const typeMatch = listingInfo.match(/Job\s+type\s*:?\s*(Full-Time|Part-Time|Contract|Freelance)/i);
                                data.job_type = typeMatch ? typeMatch[1].trim() : null;
                            }
                        }
                        
                        // Salary - improved extraction and parsing
                        let salaryText = data.salary;
                        if (!salaryText) {
                            const salaryEl = $('.compensation, .salary, [class*="salary"], [class*="compensation"]').first();
                            salaryText = salaryEl.text().trim();
                            
                            if (!salaryText) {
                                // Try to find in listing info or job description
                                const listingInfo = $('.listing-header-container, .job-info, #job-details').text();
                                const salaryMatch = listingInfo.match(/(?:Salary|Pay|Compensation)\s*:?\s*([^\n]+)/i);
                                salaryText = salaryMatch ? salaryMatch[1].trim() : null;
                            }
                        }
                        
                        const salaryData = parseSalary(salaryText);
                        
                        // Category
                        const jobCategory = $('.listing-header-container a[href*="/categories/"]').first().text().trim() || 
                                          $('[class*="category"]').first().text().trim() ||
                                          category || null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: jobCategory,
                            location: data.location || null,
                            salary: salaryData.salary_text || null,
                            min_salary: salaryData.min_salary,
                            max_salary: salaryData.max_salary,
                            currency: salaryData.currency,
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

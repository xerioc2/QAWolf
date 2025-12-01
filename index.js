// index.js
// QA Wolf take-home: validate that the first 100 Hacker News
// "newest" articles are sorted from newest to oldest.
//
// Run with:  node index.js

const { chromium } = require('playwright');
const fs = require('fs');

// === Configuration ===========================================================
const HN_NEWEST_URL = 'https://news.ycombinator.com/newest';
const EXPECTED_ARTICLE_COUNT = 200;
const MAX_PAGES_TO_VISIT = 10; // safety guard so we don't paginate forever
const JSON_REPORT_PATH = 'hn_newest_report.json';
const PAGE_LOAD_TIMEOUT = 60000; // 60 seconds for page loads
const SELECTOR_TIMEOUT = 45000; // 45 seconds for waiting for selectors

// === Small utility helpers ===================================================

/**
 * Simple sleep helper.
 * @param {number} ms - milliseconds to wait
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generic retry wrapper.
 * Useful for flaky network operations (navigation, clicking links, etc.).
 *
 * @param {Function} fn        - async function to try
 * @param {Object}   options
 * @param {number}   options.attempts  - max attempts
 * @param {number}   options.delayMs   - delay between attempts
 * @param {string}   options.label     - label to show in logs
 */
async function withRetry(fn, { attempts = 3, delayMs = 500, label = 'operation' } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(
        `[Retry] ${label} failed on attempt ${i}/${attempts}:`,
        err.message || err
      );
      if (i < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw new Error(`[Retry] ${label} failed after ${attempts} attempts: ${lastError}`);
}

/**
 * Capture a screenshot if possible. Fails gracefully if it can't.
 * @param {import('playwright').Page} page
 * @param {string} path
 */
async function captureScreenshot(page, path) {
  try {
    await page.screenshot({ path, fullPage: true });
    console.log(`📸 Screenshot captured: ${path}`);
  } catch (err) {
    console.warn(`Could not capture screenshot (${path}):`, err.message || err);
  }
}

// === Scraping logic ==========================================================

/**
 * Scrape all visible articles on the current "newest" page.
 * Each article is represented as:
 *   { title: string, ageText: string, ageISO: string | null }
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{title: string, ageText: string, ageISO: string | null}>>}
 */
async function scrapeArticlesOnPage(page) {
  try {
    // Wait for articles with increased timeout
    await page.waitForSelector('tr.athing', { timeout: SELECTOR_TIMEOUT });
  } catch (err) {
    console.warn(
      '⚠️ Timed out waiting for articles on this page. URL was:',
      page.url()
    );
    // Return empty list instead of throwing so caller can decide what to do
    return [];
  }

  // Each story on HN has a row with class "athing" and a following row with metadata.
  return page.$$eval('tr.athing', rows => {
    return rows.map(row => {
      const titleLink = row.querySelector('.titleline a');
      const title = titleLink ? titleLink.innerText.trim() : '';

      const subtextRow = row.nextElementSibling;
      const ageLink = subtextRow?.querySelector('span.age a') || null;
      const ageText = ageLink ? ageLink.innerText.trim() : ''; // e.g. "5 minutes ago"
      const ageISO = ageLink ? ageLink.getAttribute('title') : null; // e.g. "2025-01-05T13:45:00"

      return { title, ageText, ageISO };
    });
  });
}

/**
 * Navigate to the next page by clicking the "More" link.
 * The "More" link is specifically the pagination link at the bottom of the page,
 * not any article title that happens to contain the word "More".
 *
 * Throws an error if navigation fails, allowing the retry wrapper to handle it.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function navigateToNextPage(page) {
  // The "More" link on HN is in a table cell with class "morelink"
  // More specific selector to avoid clicking article titles
  const moreLink = await page.$('a.morelink');
  
  if (!moreLink) {
    throw new Error('Could not find "More" link for pagination.');
  }

  // Get current URL to detect when navigation completes
  const currentUrl = page.url();
  
  // Click and wait for URL to change (it will add ?next=XXXXX param)
  await Promise.all([
    page.waitForURL(url => url !== currentUrl, { timeout: PAGE_LOAD_TIMEOUT }),
    moreLink.click(),
  ]);

  // Give the page a moment to settle
  await sleep(500);
}

/**
 * Collect at least EXPECTED_ARTICLE_COUNT articles,
 * following the "More" pagination link as needed.
 *
 * @param {import('playwright').Page} page
 * @param {number} n
 * @returns {Promise<Array<{title: string, ageText: string, ageISO: string | null}>>}
 */
async function getFirstNArticles(page, n = EXPECTED_ARTICLE_COUNT) {
  const collected = [];
  let pagesVisited = 0;

  while (collected.length < n) {
    pagesVisited++;

    if (pagesVisited > MAX_PAGES_TO_VISIT) {
      console.warn(
        `[Warning] Visited ${pagesVisited} pages but only collected ` +
        `${collected.length} articles.`
      );
      break;
    }

    console.time(`scrape-page-${pagesVisited}`);
    console.log(`Scraping page #${pagesVisited}...`);

    const pageArticles = await scrapeArticlesOnPage(page);

    if (pageArticles.length === 0) {
      console.warn(`⚠️ No articles found on page #${pagesVisited}; stopping pagination.`);
      console.timeEnd(`scrape-page-${pagesVisited}`);
      break;
    }

    collected.push(...pageArticles);
    console.log(`  → Found ${pageArticles.length} articles (total: ${collected.length})`);
    console.timeEnd(`scrape-page-${pagesVisited}`);

    if (collected.length >= n) {
      break;
    }

    // Navigate to next page with retry
    // Now withRetry actually retries because navigateToNextPage throws on failure
    console.log('Navigating to next page...');
    try {
      await withRetry(
        () => navigateToNextPage(page),
        { attempts: 2, delayMs: 2000, label: 'pagination navigation' }
      );
    } catch (err) {
      console.warn('Failed to navigate to next page after retries; stopping pagination.');
      break;
    }
  }

  // Only keep the first N (e.g., first 100) articles
  return collected.slice(0, n);
}

// === Time parsing and validation =============================================

/**
 * Convert an ISO timestamp string to milliseconds since epoch, or null.
 * @param {string | null} iso
 * @returns {number | null}
 */
function parseIsoTimestamp(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Parse a relative age string like "5 minutes ago" into a timestamp.
 * Returns null if parsing fails or the unit is unknown.
 *
 * @param {string} ageText
 * @param {number} nowMs - reference "now", for easier testing and consistency
 * @returns {number | null}
 */
function parseRelativeAgeToTimestamp(ageText, nowMs) {
  const match = ageText.match(/(\d+)\s+(\w+)/);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();

  let secondsAgo;
  if (unit.startsWith('second')) {
    secondsAgo = value;
  } else if (unit.startsWith('minute')) {
    secondsAgo = value * 60;
  } else if (unit.startsWith('hour')) {
    secondsAgo = value * 60 * 60;
  } else if (unit.startsWith('day')) {
    secondsAgo = value * 24 * 60 * 60;
  } else {
    // Unknown unit ("months", "years", etc.) – treat as unparsable
    return null;
  }

  return nowMs - secondsAgo * 1000;
}

/**
 * Convert an article's age into a comparable timestamp (ms since epoch).
 * We try ISO first (most reliable), then fall back to parsing strings like:
 *   "5 minutes ago", "2 hours ago", "1 day ago"
 *
 * @param {{ageText: string, ageISO: string | null}} article
 * @param {number} nowMs
 * @returns {number} timestamp in milliseconds, or NaN if parsing fails
 */
function toTimestamp(article, nowMs) {
  const fromIso = parseIsoTimestamp(article.ageISO);
  if (fromIso !== null) return fromIso;

  const fromRelative = parseRelativeAgeToTimestamp(article.ageText, nowMs);
  if (fromRelative !== null) return fromRelative;

  return NaN;
}

/**
 * Enrich raw article objects with computed timestamps and indices.
 *
 * @param {Array<{title: string, ageText: string, ageISO: string | null}>} articles
 * @param {number} nowMs
 * @returns {Array<{index:number,title:string,ageText:string,ageISO:string|null,timestamp:number}>}
 */
function enrichArticlesWithTimestamps(articles, nowMs) {
  return articles.map((a, index) => ({
    index: index + 1,
    title: a.title,
    ageText: a.ageText,
    ageISO: a.ageISO,
    timestamp: toTimestamp(a, nowMs),
  }));
}

/**
 * Check that all timestamps are parseable (non-NaN).
 * @param {Array<{index:number,title:string,ageText:string,timestamp:number}>} details
 * @returns {{ ok: boolean, problems: string[] }}
 */
function checkTimestampsParsable(details) {
  const problems = [];

  for (const d of details) {
    if (Number.isNaN(d.timestamp)) {
      problems.push(
        `Unparsable timestamp for article #${d.index}: ` +
        `"${d.title}" (${d.ageText}, ISO: ${d.ageISO ?? 'none'})`
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Validate that articles are sorted from newest to oldest.
 * Identical timestamps are allowed; we only fail if a clearly older item appears before a newer one.
 *
 * @param {Array<{index:number,title:string,ageText:string,timestamp:number}>} details
 * @returns {{ ok: boolean, problems: string[] }}
 */
function checkSortedNewestToOldest(details) {
  const problems = [];

  for (let i = 1; i < details.length; i++) {
    const prev = details[i - 1];
    const curr = details[i];

    if (Number.isNaN(prev.timestamp) || Number.isNaN(curr.timestamp)) {
      // Parsing issues are handled in checkTimestampsParsable,
      // so just skip here to avoid duplicate messages.
      continue;
    }

    // Since we're using timestamps where larger = newer,
    // we expect a non-increasing sequence as we move down the list:
    //   prev.timestamp >= curr.timestamp
    //
    // Note: identical timestamps are allowed.
    if (prev.timestamp < curr.timestamp) {
      problems.push(
        `Ordering issue between #${prev.index} and #${curr.index}: ` +
        `"${prev.title}" (${prev.ageText}) appears before ` +
        `"${curr.title}" (${curr.ageText}), but has an *older* timestamp.`
      );
      break; // One clear example of bad ordering is enough to fail the check
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * High-level validator that uses smaller checks:
 *  - timestamp parseability
 *  - sort order
 *
 * @param {Array<{title: string, ageText: string, ageISO: string | null}>} articles
 * @param {number} nowMs
 * @returns {{ isSorted: boolean, details: any[], problems: string[] }}
 */
function validateArticles(articles, nowMs) {
  const details = enrichArticlesWithTimestamps(articles, nowMs);

  const parseCheck = checkTimestampsParsable(details);
  const sortCheck = checkSortedNewestToOldest(details);

  const problems = [
    ...parseCheck.problems,
    ...sortCheck.problems,
  ];

  return {
    isSorted: parseCheck.ok && sortCheck.ok,
    details,
    problems,
  };
}

// === Reporting ===============================================================

/**
 * Build a JSON-serializable result object for reporting.
 *
 * @param {Object} params
 * @param {Array}  params.articles
 * @param {Object} params.validationResult
 * @param {number} params.startedAt
 * @param {number} params.finishedAt
 */
function buildResultObject({ articles, validationResult, startedAt, finishedAt }) {
  // Calculate some useful statistics
  const timestamps = validationResult.details
    .map(d => d.timestamp)
    .filter(t => !Number.isNaN(t));
  
  const stats = timestamps.length > 0 ? {
    oldestTimestamp: new Date(Math.min(...timestamps)).toISOString(),
    newestTimestamp: new Date(Math.max(...timestamps)).toISOString(),
    timeSpanHours: ((Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60)).toFixed(2),
    unparsableCount: validationResult.details.filter(d => Number.isNaN(d.timestamp)).length,
  } : null;

  return {
    meta: {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      durationSeconds: ((finishedAt - startedAt) / 1000).toFixed(2),
      expectedCount: EXPECTED_ARTICLE_COUNT,
      actualCount: articles.length,
    },
    validation: {
      passed: validationResult.isSorted,
      isSorted: validationResult.isSorted,
      problemCount: validationResult.problems.length,
      problems: validationResult.problems,
    },
    statistics: stats,
    // Include first 5 and last 3 articles to show the range
    sampleArticles: {
      first5: articles.slice(0, 5).map((a, i) => ({
        position: i + 1,
        title: a.title,
        age: a.ageText,
      })),
      last3: articles.slice(-3).map((a, i) => ({
        position: articles.length - 2 + i,
        title: a.title,
        age: a.ageText,
      })),
    },
  };
}

/**
 * Write the result object as pretty-printed JSON to disk.
 * @param {Object} result
 * @param {string} filename
 */
function writeJsonReport(result, filename = JSON_REPORT_PATH) {
  try {
    fs.writeFileSync(filename, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`📝 JSON report written to ${filename}`);
  } catch (err) {
    console.warn(`Could not write JSON report (${filename}):`, err.message || err);
  }
}

/**
 * Print a nice summary to the console
 * @param {Object} result
 */
function printSummary(result) {
  console.log('\n' + '='.repeat(70));
  console.log('TEST SUMMARY');
  console.log('='.repeat(70));
  console.log(`Status: ${result.validation.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Articles Validated: ${result.meta.actualCount}/${result.meta.expectedCount}`);
  console.log(`Execution Time: ${result.meta.durationSeconds}s`);
  
  if (result.statistics) {
    console.log(`Time Span: ${result.statistics.timeSpanHours} hours`);
    console.log(`Newest: ${result.statistics.newestTimestamp}`);
    console.log(`Oldest: ${result.statistics.oldestTimestamp}`);
    if (result.statistics.unparsableCount > 0) {
      console.log(`⚠️  Unparsable timestamps: ${result.statistics.unparsableCount}`);
    }
  }
  
  if (result.validation.problemCount > 0) {
    console.log(`\nProblems Found: ${result.validation.problemCount}`);
    result.validation.problems.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p}`);
    });
  }
  console.log('='.repeat(70) + '\n');
}

// === Main script (entry point) ==============================================

(async () => {
  const startedAt = Date.now();

  const browser = await chromium.launch({
    headless: true, // set to false if you want to watch the browser in action
  });

  const page = await browser.newPage();
  
  // Set default timeout for all operations
  page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);

  let articles = [];
  let validationResult = { isSorted: false, problems: [], details: [] };

  try {
    console.log('🚀 Starting Hacker News validation script...');
    console.log('Navigating to Hacker News /newest...');

    // Navigation can also be flaky, so use our retry helper
    await withRetry(
      () => page.goto(HN_NEWEST_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT }),
      { attempts: 3, delayMs: 2000, label: 'initial navigation' }
    );

    // Wait for page to be ready
    await sleep(1000);

    console.log('Collecting articles...');
    articles = await getFirstNArticles(page, EXPECTED_ARTICLE_COUNT);

    console.log(`Collected ${articles.length} articles.`);

    if (articles.length !== EXPECTED_ARTICLE_COUNT) {
      console.warn(
        `⚠️ Expected exactly ${EXPECTED_ARTICLE_COUNT} articles but found ${articles.length}. ` +
        'Proceeding to validate the articles that were collected.'
      );
    }

    if (articles.length === 0) {
      throw new Error('No articles were collected. Cannot proceed with validation.');
    }

    console.log('Validating sort order (newest → oldest)...');
    const nowMs = Date.now();
    validationResult = validateArticles(articles, nowMs);

    if (validationResult.isSorted) {
      console.log(
        `✅ PASS: The ${articles.length} collected Hacker News "newest" articles ` +
        'are sorted from newest to oldest.'
      );
    } else {
      console.error(
        `❌ FAIL: Articles are NOT sorted from newest to oldest.`
      );
      validationResult.problems.forEach(p => console.error(' -', p));

      // Screenshot on validation failure
      await captureScreenshot(page, 'hn_validation_failure.png');

      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Error running script:', err.message || err);

    // Screenshot on unexpected runtime error
    await captureScreenshot(page, 'hn_runtime_error.png');

    process.exitCode = 1;
  } finally {
    const finishedAt = Date.now();

    // Build and write JSON report regardless of pass/fail
    const resultObj = buildResultObject({
      articles,
      validationResult,
      startedAt,
      finishedAt,
    });
    
    writeJsonReport(resultObj, JSON_REPORT_PATH);
    printSummary(resultObj);

    await browser.close();
    console.log('✨ Script complete!');
  }
})();
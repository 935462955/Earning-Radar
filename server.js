const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const CACHE_DIR = path.join(ROOT, ".cache");
const PORT = Number(process.env.PORT || 4173);
const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT || "earnings-radar/0.1 contact@example.com";

const DAY = 24 * 60 * 60 * 1000;
const SEC_TTL = 8 * 60 * 60 * 1000;
const TEXT_TTL = 12 * 60 * 60 * 1000;
const CALENDAR_TTL = 6 * 60 * 60 * 1000;
const PROFILE_TTL = 14 * DAY;
const TRANSLATION_TTL = 30 * DAY;
const RANKING_TTL = 4 * 60 * 60 * 1000;
const TEXT_SCAN_MIN_SCORE = Number(process.env.TEXT_SCAN_MIN_SCORE || 20);
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 100);
const RANKING_DIAGNOSTICS_VERSION = 8;
const SIGNAL_PATTERN_VERSION = 2;
const ASHARE_DATA_FILTER_VERSION = 2;

const RESULT_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F"]);
const TEXT_FORMS = new Set([
  "10-Q",
  "10-K",
  "20-F",
  "40-F",
  "8-K",
  "6-K",
  "S-1",
  "S-1/A",
  "F-1",
  "F-1/A",
  "424B4",
  "424B5"
]);

const METRICS = {
  revenue: {
    label: "Revenue",
    unit: "USD",
    concepts: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
      "SalesRevenueGoodsNet",
      "SalesRevenueServicesNet"
    ]
  },
  netIncome: {
    label: "Net income",
    unit: "USD",
    concepts: ["NetIncomeLoss", "ProfitLoss"]
  },
  grossProfit: {
    label: "Gross profit",
    unit: "USD",
    concepts: ["GrossProfit"]
  },
  operatingIncome: {
    label: "Operating income",
    unit: "USD",
    concepts: ["OperatingIncomeLoss"]
  },
  operatingCashFlow: {
    label: "Operating cash flow",
    unit: "USD",
    concepts: [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"
    ]
  },
  epsDiluted: {
    label: "Diluted EPS",
    unit: "USD/shares",
    concepts: ["EarningsPerShareDiluted"]
  }
};

const SIGNAL_PATTERNS = [
  {
    label: "产品供不应求",
    score: 18,
    patterns: [
      /demand\s+(?:continues\s+to\s+)?(?:exceeds|outpaces|exceeding|outpacing)\s+(?:our\s+)?supply/gi,
      /unable\s+to\s+meet\s+(?:customer\s+)?demand/gi,
      /supply\s+constrained|capacity\s+constrained/gi,
      /sold\s+out|oversubscribed/gi
    ]
  },
  {
    label: "行业高景气度上行",
    score: 14,
    patterns: [
      /industry\s+(?:upcycle|tailwinds?|momentum)/gi,
      /favorable\s+(?:industry|market)\s+conditions/gi,
      /robust\s+(?:industry|market)\s+demand/gi,
      /secular\s+growth\s+(?:trend|opportunit(?:y|ies))/gi
    ]
  },
  {
    label: "市场超预期拓展",
    score: 14,
    patterns: [
      /(?:market|customer)\s+(?:adoption|expansion)\s+(?:has\s+)?(?:exceeded|outpaced)\s+(?:our\s+)?expectations/gi,
      /better\s+than\s+expected\s+(?:demand|adoption|growth)/gi,
      /expanded\s+(?:into|across)\s+new\s+markets/gi,
      /accelerated\s+(?:customer\s+)?adoption/gi
    ]
  },
  {
    label: "新品上市持续超预期",
    score: 14,
    patterns: [
      /new\s+product\s+(?:launch|ramp|introduction)[^.]{0,120}(?:exceeded|ahead\s+of|better\s+than)\s+(?:our\s+)?expectations/gi,
      /(?:launch|ramp)\s+(?:continues\s+to\s+)?(?:exceed|outperform)\s+(?:our\s+)?expectations/gi,
      /strong\s+(?:initial\s+)?demand\s+for\s+(?:our\s+)?new\s+products?/gi
    ]
  },
  {
    label: "产品价格中枢持续上涨",
    score: 14,
    patterns: [
      /higher\s+(?:average\s+)?selling\s+prices?/gi,
      /average\s+selling\s+price(?:s|\s+\(asp\))?\s+(?:increased|rose|expanded)/gi,
      /\bASP\b\s+(?:increased|rose|expanded)/gi,
      /price\s+increases?|pricing\s+power|favorable\s+pricing/gi
    ]
  },
  {
    label: "供给偏紧",
    score: 14,
    patterns: [
      /supply\s+(?:remains|remained|is)\s+tight/gi,
      /tight\s+supply|limited\s+supply/gi,
      /inventory\s+(?:remains|remained|is)\s+(?:lean|low)/gi,
      /constraints?\s+on\s+(?:supply|capacity|production)/gi
    ]
  },
  {
    label: "需求旺盛",
    score: 14,
    patterns: [
      /strong\s+(?:customer\s+)?demand/gi,
      /robust\s+(?:customer\s+)?demand/gi,
      /demand\s+(?:remains|remained|is)\s+(?:strong|robust|healthy)/gi,
      /record\s+(?:orders|bookings|backlog)/gi
    ]
  }
];

let secQueue = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashKey(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function readJson(file) {
  const body = await fs.readFile(file, "utf8");
  return JSON.parse(body);
}

async function readCache(name, maxAgeMs) {
  try {
    const file = path.join(CACHE_DIR, name);
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return await readJson(file);
  } catch {
    return null;
  }
}

async function writeCache(name, payload) {
  await ensureCacheDir();
  const file = path.join(CACHE_DIR, name);
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function secFetch(url, type = "json") {
  const run = secQueue.then(async () => {
    await delay(140);
    const response = await fetchWithTimeout(url, {
      timeoutMs: 25000,
      headers: {
        "User-Agent": SEC_USER_AGENT,
        Accept:
          type === "json"
            ? "application/json, text/plain, */*"
            : "text/html,application/xhtml+xml,text/plain,*/*"
      }
    });
    return type === "json" ? response.json() : response.text();
  });
  secQueue = run.catch(() => undefined);
  return run;
}

async function cachedSecJson(url, force = false, ttl = SEC_TTL) {
  const name = `sec-json-${hashKey(url)}.json`;
  if (!force) {
    const cached = await readCache(name, ttl);
    if (cached) return cached;
  }
  const payload = await secFetch(url, "json");
  await writeCache(name, payload);
  return payload;
}

async function cachedSecText(url, force = false, ttl = TEXT_TTL) {
  const name = `sec-text-${hashKey(url)}.json`;
  if (!force) {
    const cached = await readCache(name, ttl);
    if (cached?.text) return cached.text;
  }
  const text = await secFetch(url, "text");
  await writeCache(name, { text, url, fetchedAt: new Date().toISOString() });
  return text;
}

async function fetchNasdaqJson(url) {
  const response = await fetchWithTimeout(url, {
    timeoutMs: 18000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json, text/plain, */*",
      Origin: "https://www.nasdaq.com",
      Referer: "https://www.nasdaq.com/market-activity/earnings"
    }
  });
  return response.json();
}

async function cachedNasdaqJson(url, force = false, ttl = CALENDAR_TTL) {
  const name = `nasdaq-json-${hashKey(url)}.json`;
  if (!force) {
    const cached = await readCache(name, ttl);
    if (cached) return cached;
  }
  const payload = await fetchNasdaqJson(url);
  await writeCache(name, payload);
  return payload;
}

function eastmoneyReferer(url) {
  if (String(url).includes("emweb.securities.eastmoney.com")) {
    return "https://emweb.securities.eastmoney.com/";
  }
  if (String(url).includes("quote.eastmoney.com") || String(url).includes("push2.eastmoney.com")) {
    return "https://quote.eastmoney.com/center/gridlist.html";
  }
  return "https://data.eastmoney.com/";
}

async function fetchEastmoneyJson(url) {
  const response = await fetchWithTimeout(url, {
    timeoutMs: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: eastmoneyReferer(url)
    }
  });
  return response.json();
}

async function cachedEastmoneyJson(url, force = false, ttl = CALENDAR_TTL) {
  const name = `eastmoney-json-${hashKey(url)}.json`;
  if (!force) {
    const cached = await readCache(name, ttl);
    if (cached) return cached;
  }
  const payload = await fetchEastmoneyJson(url);
  await writeCache(name, payload);
  return payload;
}

function eastmoneyDataUrl(reportName, params = {}) {
  const query = new URLSearchParams({
    pageNumber: "1",
    pageSize: "500",
    sortColumns: "NOTICE_DATE,SECURITY_CODE",
    sortTypes: "-1,1",
    source: "WEB",
    client: "WEB",
    reportName,
    columns: "ALL",
    ...params
  });
  return `https://datacenter-web.eastmoney.com/api/data/v1/get?${query.toString()}`;
}

async function fetchEastmoneyPaged(reportName, params = {}, force = false) {
  const pageSize = Number(params.pageSize || 500);
  const firstUrl = eastmoneyDataUrl(reportName, { ...params, pageNumber: "1", pageSize });
  const first = await cachedEastmoneyJson(firstUrl, force);
  const result = first?.result || {};
  const rows = [...(result.data || [])];
  const pages = Math.min(Number(result.pages || 1), 50);
  if (pages <= 1) return rows;
  const rest = await mapLimit(
    Array.from({ length: pages - 1 }, (_, index) => index + 2),
    4,
    async (pageNumber) => {
      const url = eastmoneyDataUrl(reportName, { ...params, pageNumber, pageSize });
      return cachedEastmoneyJson(url, force);
    }
  );
  for (const page of rest) {
    if (page?.error) continue;
    rows.push(...(page?.result?.data || []));
  }
  return rows;
}

function hasChineseText(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function isUsefulChineseTranslation(source, translated) {
  const normalizedSource = String(source || "").trim().toLowerCase();
  const normalizedTranslated = String(translated || "").trim().toLowerCase();
  return (
    hasChineseText(translated) &&
    normalizedTranslated &&
    normalizedTranslated !== normalizedSource
  );
}

async function translateToChinese(text, force = false) {
  const sourceText = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!sourceText) {
    return { sourceText: "", translatedText: "", provider: "", status: "empty" };
  }
  if (hasChineseText(sourceText)) {
    return {
      sourceText,
      translatedText: sourceText,
      provider: "input",
      status: "already-chinese"
    };
  }

  const cacheName = `translation-en-zh-${hashKey(sourceText)}.json`;
  if (!force) {
    const cached = await readCache(cacheName, TRANSLATION_TTL);
    if (cached) return cached;
  }

  const params = new URLSearchParams({
    q: sourceText,
    langpair: "en|zh-CN"
  });
  const response = await fetchWithTimeout(
    `https://api.mymemory.translated.net/get?${params.toString()}`,
    {
      timeoutMs: 20000,
      headers: {
        "User-Agent": "earnings-radar/0.1",
        Accept: "application/json, text/plain, */*"
      }
    }
  );
  const payload = await response.json();
  const translatedText = String(payload?.responseData?.translatedText || "").trim();
  const result = {
    sourceText,
    translatedText,
    provider: "MyMemory",
    match: payload?.responseData?.match ?? null,
    status: isUsefulChineseTranslation(sourceText, translatedText) ? "ok" : "unchanged"
  };
  await writeCache(cacheName, result);
  return result;
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (!value) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : new Date(time);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function quarterRange(now = new Date()) {
  const month = now.getUTCMonth();
  const startMonth = Math.floor(month / 3) * 3;
  const start = new Date(Date.UTC(now.getUTCFullYear(), startMonth, 1));
  const end = addDays(new Date(Date.UTC(now.getUTCFullYear(), startMonth + 3, 1)), -1);
  return {
    label: `${now.getUTCFullYear()} Q${Math.floor(month / 3) + 1}`,
    start: toDateOnly(start),
    end: toDateOnly(end),
    today: toDateOnly(now)
  };
}

function reportingFrame(now = new Date()) {
  const currentQuarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const quarter = currentQuarter === 1 ? 4 : currentQuarter - 1;
  const year = currentQuarter === 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  return {
    frame: `CY${year}Q${quarter}`,
    priorFrame: `CY${year - 1}Q${quarter}`,
    label: `${year} Q${quarter}`
  };
}

function cikPad(cik) {
  return String(cik).padStart(10, "0");
}

function cikPlain(cik) {
  return String(Number(cik));
}

function normalizeTicker(ticker) {
  return ticker.toUpperCase().replace(".", "-");
}

function clampNumber(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCustomKeywordRules(input = "") {
  return String(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => {
      const [rawLabel, rawTerms] = line.includes(":")
        ? line.split(/:(.*)/s)
        : line.includes("|")
          ? line.split(/\|(.*)/s)
          : [line, line];
      const label = rawLabel.trim().slice(0, 40);
      const terms = String(rawTerms || rawLabel)
        .split(/[,，;；]/)
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 12);
      return { label, terms };
    })
    .filter((rule) => rule.label && rule.terms.length);
}

function parseCompanyQueries(input = "") {
  const queries = [];
  const push = (value) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (normalized && !queries.includes(normalized)) queries.push(normalized);
  };
  for (const chunk of String(input || "").split(/[,，;；\n\r]+/)) {
    push(chunk);
    const tokens = chunk.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      const tokenLikeQueries = tokens.filter((token) =>
        /^[A-Za-z0-9._-]{1,12}$/.test(token) || /[\u3400-\u9fff]/.test(token)
      );
      if (tokenLikeQueries.length === tokens.length) {
        tokenLikeQueries.forEach(push);
      }
    }
  }
  return queries.slice(0, 20);
}

function normalizedSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRankingOptions(params = new URLSearchParams()) {
  const customKeywordText = params.get("keywords") || "";
  const focusCompanyText = params.get("focus") || "";
  const includeCashFlow = params.get("cashFlow") === "1";
  const cashFlowThresholdPct = clampNumber(params.get("cashFlowThreshold"), 25, 0, 500);
  const analysisLimit = clampNumber(params.get("limit"), ENRICH_LIMIT, 1, 500);
  return {
    analysisLimit,
    reuseAnalysis: params.get("reuse") !== "0",
    includeCashFlow,
    cashFlowThresholdPct,
    cashFlowThreshold: cashFlowThresholdPct / 100,
    customKeywordText,
    customKeywordRules: parseCustomKeywordRules(customKeywordText),
    focusCompanyText,
    focusCompanyQueries: parseCompanyQueries(focusCompanyText)
  };
}

function rankingOptionsFingerprint(options) {
  return hashKey(
    JSON.stringify({
      analysisLimit: options.analysisLimit,
      includeCashFlow: options.includeCashFlow,
      cashFlowThresholdPct: options.cashFlowThresholdPct,
      customKeywordRules: options.customKeywordRules,
      focusCompanyQueries: options.focusCompanyQueries,
      diagnosticsVersion: RANKING_DIAGNOSTICS_VERSION,
      signalPatternVersion: SIGNAL_PATTERN_VERSION
    })
  );
}

function sourceSet(...sources) {
  return [...new Set(sources.filter(Boolean))];
}

function dateRange(start, end) {
  const days = [];
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (!startDate || !endDate) return days;
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
    days.push(toDateOnly(day));
  }
  return days;
}

function stockUrl(ticker) {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`;
}

function secFilingUrl(cik, accessionNumber, primaryDocument) {
  if (!cik || !accessionNumber || !primaryDocument) return "";
  const accession = accessionNumber.replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/data/${cikPlain(cik)}/${accession}/${primaryDocument}`;
}

function zipFilings(recent) {
  if (!recent?.form) return [];
  return recent.form.map((form, index) => ({
    form,
    filingDate: recent.filingDate?.[index] || "",
    reportDate: recent.reportDate?.[index] || "",
    accessionNumber: recent.accessionNumber?.[index] || "",
    primaryDocument: recent.primaryDocument?.[index] || "",
    primaryDocDescription: recent.primaryDocDescription?.[index] || ""
  }));
}

function inDateRange(value, start, end) {
  if (!value) return false;
  return value >= start && value <= end;
}

async function loadUniverse() {
  const config = await readJson(path.join(ROOT, "config", "universe.json"));
  const symbols = [...new Set((config.symbols || []).map(normalizeTicker))];
  return { ...config, symbols };
}

async function loadTickerMap(force = false) {
  const url = "https://www.sec.gov/files/company_tickers_exchange.json";
  const payload = await cachedSecJson(url, force, DAY);
  const map = new Map();
  for (const row of payload.data || []) {
    const [cik, name, ticker, exchange] = row;
    map.set(normalizeTicker(ticker), { cik, name, ticker: normalizeTicker(ticker), exchange });
  }
  return map;
}

function resolveTickerQueries(tickerMap, queries = []) {
  const matches = new Map();
  const missing = [];
  const companies = [...tickerMap.values()];
  for (const query of queries) {
    const normalizedTickerQuery = normalizeTicker(query);
    let match =
      tickerMap.get(normalizedTickerQuery) ||
      companies.find((company) => normalizedSearchText(company.name) === normalizedSearchText(query)) ||
      companies.find((company) => normalizedSearchText(company.name).startsWith(normalizedSearchText(query))) ||
      (normalizedSearchText(query).length >= 3
        ? companies.find((company) => normalizedSearchText(company.name).includes(normalizedSearchText(query)))
        : null);
    if (!match) {
      missing.push({
        query,
        reason: "指定公司未在 SEC ticker/name 映射中匹配到"
      });
      continue;
    }
    const symbol = normalizeTicker(match.ticker);
    const existing = matches.get(symbol) || { ...match, ticker: symbol, queries: [] };
    existing.queries = sourceSet(...existing.queries, query);
    matches.set(symbol, existing);
  }
  return { matches: [...matches.values()], missing };
}

function conceptSeries(facts, metric) {
  for (const concept of metric.concepts) {
    const item = facts?.facts?.["us-gaap"]?.[concept];
    const series = item?.units?.[metric.unit];
    if (Array.isArray(series) && series.length) {
      return { concept, series: series.filter((fact) => Number.isFinite(fact.val)) };
    }
  }
  return { concept: "", series: [] };
}

function daysBetween(start, end) {
  const a = parseDate(start);
  const b = parseDate(end);
  if (!a || !b) return null;
  return Math.round((b - a) / DAY) + 1;
}

function periodPreference(form) {
  return form === "10-Q" ? 90 : 365;
}

function scoreFactCandidate(fact, filing) {
  const preferred = periodPreference(filing.form);
  const duration = daysBetween(fact.start, fact.end);
  const durationPenalty = duration ? Math.abs(duration - preferred) : 240;
  const endPenalty = filing.reportDate && fact.end === filing.reportDate ? 0 : 45;
  const frameBonus = fact.frame ? -10 : 0;
  return durationPenalty + endPenalty + frameBonus;
}

function selectCurrentFact(series, filing) {
  const matches = series
    .filter((fact) => fact.accn === filing.accessionNumber)
    .filter((fact) => fact.form === filing.form || RESULT_FORMS.has(fact.form))
    .sort((a, b) => scoreFactCandidate(a, filing) - scoreFactCandidate(b, filing));
  return matches[0] || null;
}

function targetPriorFrame(frame) {
  const quarter = /^CY(\d{4})Q([1-4])$/.exec(frame || "");
  if (quarter) return `CY${Number(quarter[1]) - 1}Q${quarter[2]}`;
  const year = /^CY(\d{4})$/.exec(frame || "");
  if (year) return `CY${Number(year[1]) - 1}`;
  return "";
}

function selectPriorFact(series, current) {
  if (!current) return null;
  const targetFrame = targetPriorFrame(current.frame);
  if (targetFrame) {
    const byFrame = series
      .filter((fact) => fact.frame === targetFrame)
      .sort((a, b) => String(b.filed || "").localeCompare(String(a.filed || "")));
    if (byFrame[0]) return byFrame[0];
  }

  const currentEnd = parseDate(current.end);
  const currentDuration = daysBetween(current.start, current.end);
  if (!currentEnd || !currentDuration) return null;
  const target = new Date(currentEnd);
  target.setUTCFullYear(target.getUTCFullYear() - 1);
  return series
    .filter((fact) => {
      const end = parseDate(fact.end);
      const duration = daysBetween(fact.start, fact.end);
      if (!end || !duration) return false;
      const endGap = Math.abs((end - target) / DAY);
      const durationGap = Math.abs(duration - currentDuration);
      return endGap <= 45 && durationGap <= 45;
    })
    .sort((a, b) => {
      const aGap = Math.abs((parseDate(a.end) - target) / DAY);
      const bGap = Math.abs((parseDate(b.end) - target) / DAY);
      return aGap - bGap;
    })[0] || null;
}

function growth(current, prior) {
  if (!current || !prior || !Number.isFinite(current.val) || !Number.isFinite(prior.val)) {
    return { pct: null, turnaround: false };
  }
  if (prior.val > 0) return { pct: (current.val - prior.val) / Math.abs(prior.val), turnaround: false };
  if (prior.val <= 0 && current.val > 0) return { pct: null, turnaround: true };
  return { pct: null, turnaround: false };
}

function pickMetric(facts, filing, metric) {
  const { concept, series } = conceptSeries(facts, metric);
  const current = selectCurrentFact(series, filing);
  const prior = selectPriorFact(series, current);
  return {
    concept,
    current,
    prior,
    growth: growth(current, prior)
  };
}

function margin(numerator, denominator) {
  if (!numerator?.val || !denominator?.val) return null;
  if (Math.abs(denominator.val) < 1) return null;
  return numerator.val / denominator.val;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  return value.toLocaleString("en-US");
}

function addGrowthScore(scoreState, key, metric, thresholds) {
  const pct = metric.growth.pct;
  if (metric.growth.turnaround) {
    scoreState.score += thresholds.turnaround || 20;
    scoreState.reasons.push(`${key} 扭亏`);
    return;
  }
  if (!Number.isFinite(pct)) return;
  for (const [limit, points, label] of thresholds.steps) {
    if (pct >= limit) {
      scoreState.score += points;
      scoreState.reasons.push(`${key} ${label}`);
      return;
    }
  }
}

function scoreMetrics(metrics, options = {}) {
  const state = { score: 0, reasons: [] };
  addGrowthScore(state, "营收", metrics.revenue, {
    steps: [
      [1, 40, "同比翻倍"],
      [0.5, 32, "同比>50%"],
      [0.25, 22, "同比>25%"],
      [0.1, 10, "同比>10%"]
    ]
  });
  addGrowthScore(state, "净利润", metrics.netIncome, {
    turnaround: 28,
    steps: [
      [1, 32, "同比翻倍"],
      [0.5, 24, "同比>50%"],
      [0.25, 14, "同比>25%"],
      [0.1, 8, "同比>10%"]
    ]
  });

  if (metrics.grossMarginDelta != null) {
    if (metrics.grossMarginDelta >= 0.05) {
      state.score += 10;
      state.reasons.push("毛利率提升>5pct");
    } else if (metrics.grossMarginDelta >= 0.02) {
      state.score += 5;
      state.reasons.push("毛利率提升>2pct");
    }
  }
  if (metrics.operatingMarginDelta != null) {
    if (metrics.operatingMarginDelta >= 0.05) {
      state.score += 12;
      state.reasons.push("经营利润率提升>5pct");
    } else if (metrics.operatingMarginDelta >= 0.02) {
      state.score += 6;
      state.reasons.push("经营利润率提升>2pct");
    }
  }
  if (options.includeCashFlow) {
    const threshold = options.cashFlowThreshold;
    const thresholdLabel = `${options.cashFlowThresholdPct}%`;
    addGrowthScore(state, "经营现金流", metrics.operatingCashFlow, {
      turnaround: 14,
      steps: [
        [Math.max(1, threshold * 3), 18, "同比翻倍"],
        [threshold, 12, `同比>${thresholdLabel}`],
        [0.1, 6, "同比>10%"]
      ]
    });
  }
  return state;
}

function customFindingsFromMetrics(metrics, options = {}) {
  const findings = [];
  if (options.includeCashFlow) {
    const cashFlow = metrics.operatingCashFlow;
    if (cashFlow?.growth?.turnaround) {
      findings.push({ label: "经营现金流扭亏", value: "turnaround" });
    } else if (
      Number.isFinite(cashFlow?.growth?.pct) &&
      cashFlow.growth.pct >= options.cashFlowThreshold
    ) {
      findings.push({
        label: "经营现金流增长",
        value: `同比 ${(cashFlow.growth.pct * 100).toFixed(1)}%`
      });
    }
  }
  return findings;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contextAround(text, index, length) {
  const start = Math.max(0, index - 130);
  const end = Math.min(text.length, index + length + 190);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function customSignalPatterns(customKeywordRules = []) {
  return customKeywordRules.map((rule) => ({
    label: `自定义：${rule.label}`,
    score: 8,
    patterns: rule.terms.map((term) => new RegExp(escapeRegExp(term), "gi"))
  }));
}

function findSignals(text, doc, customKeywordRules = []) {
  const hits = [];
  for (const signal of [...SIGNAL_PATTERNS, ...customSignalPatterns(customKeywordRules)]) {
    const signalHits = [];
    for (const pattern of signal.patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) && signalHits.length < 2) {
        signalHits.push({
          label: signal.label,
          phrase: match[0],
          context: contextAround(text, match.index, match[0].length),
          form: doc.form,
          filingDate: doc.filingDate,
          url: doc.url
        });
      }
      if (signalHits.length >= 2) break;
    }
    if (signalHits.length) {
      hits.push({ label: signal.label, score: signal.score, hits: signalHits });
    }
  }
  return hits;
}

function uniqueSignals(signals) {
  const seen = new Set();
  const output = [];
  for (const signal of signals) {
    const key = `${signal.label}-${signal.hits[0]?.phrase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(signal);
  }
  return output;
}

function docsToScan(cik, filings, rankingFiling, range) {
  const currentQuarterDocs = filings
    .filter((filing) => TEXT_FORMS.has(filing.form))
    .filter((filing) => inDateRange(filing.filingDate, range.start, range.today))
    .slice(0, 8);
  const selected = [rankingFiling, ...currentQuarterDocs]
    .filter(Boolean)
    .filter((doc) => doc.primaryDocument && doc.accessionNumber);
  const seen = new Set();
  return selected
    .filter((doc) => {
      const key = doc.accessionNumber;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map((doc) => ({ ...doc, url: secFilingUrl(cik, doc.accessionNumber, doc.primaryDocument) }));
}

function shouldScanTextSignals(metricScore, metrics) {
  const revenueGrowth = metrics.revenue.growth.pct;
  const netIncomeGrowth = metrics.netIncome.growth.pct;
  return (
    metricScore.score >= TEXT_SCAN_MIN_SCORE ||
    metrics.netIncome.growth.turnaround ||
    (Number.isFinite(revenueGrowth) && revenueGrowth >= 0.25) ||
    (Number.isFinite(netIncomeGrowth) && netIncomeGrowth >= 0.25)
  );
}

async function scanSignals(cik, filings, rankingFiling, range, force, diagnostics, symbol, options = {}) {
  const docs = docsToScan(cik, filings, rankingFiling, range);
  const allSignals = [];
  if (!docs.length && diagnostics) {
    diagnostics.textDocsMissing.push({
      symbol,
      cik,
      accessionNumber: rankingFiling?.accessionNumber || "",
      reason: "没有可扫描的 SEC 主文档"
    });
  }
  for (const doc of docs) {
    if (!doc.url) continue;
    try {
      const html = await cachedSecText(doc.url, force, TEXT_TTL);
      const text = stripHtml(html);
      allSignals.push(...findSignals(text, doc, options.customKeywordRules || []));
    } catch (error) {
      if (diagnostics) {
        diagnostics.textScanFailures.push({
          symbol,
          cik,
          form: doc.form,
          filingDate: doc.filingDate,
          accessionNumber: doc.accessionNumber,
          url: doc.url,
          error: error.message
        });
      }
    }
  }
  return uniqueSignals(allSignals);
}

function metricPayload(metric) {
  return {
    concept: metric.concept,
    current: metric.current
      ? {
          value: metric.current.val,
          display: formatNumber(metric.current.val),
          start: metric.current.start,
          end: metric.current.end,
          frame: metric.current.frame || ""
        }
      : null,
    prior: metric.prior
      ? {
          value: metric.prior.val,
          display: formatNumber(metric.prior.val),
          start: metric.prior.start,
          end: metric.prior.end,
          frame: metric.prior.frame || ""
        }
      : null,
    growthPct: Number.isFinite(metric.growth.pct) ? metric.growth.pct : null,
    turnaround: metric.growth.turnaround
  };
}

function assembleMetrics(facts, filing) {
  const revenue = pickMetric(facts, filing, METRICS.revenue);
  const netIncome = pickMetric(facts, filing, METRICS.netIncome);
  const grossProfit = pickMetric(facts, filing, METRICS.grossProfit);
  const operatingIncome = pickMetric(facts, filing, METRICS.operatingIncome);
  const epsDiluted = pickMetric(facts, filing, METRICS.epsDiluted);

  const grossMargin = margin(grossProfit.current, revenue.current);
  const grossMarginPrior = margin(grossProfit.prior, revenue.prior);
  const operatingMargin = margin(operatingIncome.current, revenue.current);
  const operatingMarginPrior = margin(operatingIncome.prior, revenue.prior);

  return {
    revenue,
    netIncome,
    grossProfit,
    operatingIncome,
    epsDiluted,
    grossMargin,
    grossMarginPrior,
    grossMarginDelta:
      grossMargin != null && grossMarginPrior != null ? grossMargin - grossMarginPrior : null,
    operatingMargin,
    operatingMarginPrior,
    operatingMarginDelta:
      operatingMargin != null && operatingMarginPrior != null
        ? operatingMargin - operatingMarginPrior
        : null
  };
}

function latestRankingFiling(filings, range) {
  return filings.find(
    (filing) =>
      RESULT_FORMS.has(filing.form) && inDateRange(filing.filingDate, range.start, range.today)
  );
}

async function analyzeCompany(symbol, company, range, force) {
  const cik = company.cik;
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPad(cik)}.json`;
  const submissions = await cachedSecJson(submissionsUrl, force);
  const filings = zipFilings(submissions.filings?.recent);
  const rankingFiling = latestRankingFiling(filings, range);
  if (!rankingFiling) return null;

  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPad(cik)}.json`;
  const facts = await cachedSecJson(factsUrl, force);
  const rawMetrics = assembleMetrics(facts, rankingFiling);
  const metricScore = scoreMetrics(rawMetrics);
  const signals = shouldScanTextSignals(metricScore, rawMetrics)
    ? await scanSignals(cik, filings, rankingFiling, range, force)
    : [];
  const signalScore = signals.reduce((sum, item) => sum + item.score, 0);
  const score = Math.min(100, Math.round(metricScore.score + Math.min(35, signalScore)));
  const highlight =
    score >= 70 ||
    signals.length >= 2 ||
    signals.some((signal) =>
      ["产品供不应求", "供给偏紧", "需求旺盛", "产品价格中枢持续上涨"].includes(signal.label)
    );

  return {
    symbol,
    name: company.name || submissions.name || symbol,
    exchange: company.exchange || "",
    score,
    highlight,
    reasons: metricScore.reasons,
    signals,
    filing: {
      form: rankingFiling.form,
      filingDate: rankingFiling.filingDate,
      reportDate: rankingFiling.reportDate,
      accessionNumber: rankingFiling.accessionNumber,
      primaryDocument: rankingFiling.primaryDocument,
      url: secFilingUrl(cik, rankingFiling.accessionNumber, rankingFiling.primaryDocument)
    },
    stockUrl: stockUrl(symbol),
    metrics: {
      revenue: metricPayload(rawMetrics.revenue),
      netIncome: metricPayload(rawMetrics.netIncome),
      epsDiluted: metricPayload(rawMetrics.epsDiluted),
      grossMargin: rawMetrics.grossMargin,
      grossMarginDelta: rawMetrics.grossMarginDelta,
      operatingMargin: rawMetrics.operatingMargin,
      operatingMarginDelta: rawMetrics.operatingMarginDelta
    }
  };
}

function frameUnit(unit) {
  return unit.replace("/", "-per-");
}

async function fetchFrameConcept(concept, unit, frame, force, diagnostics) {
  const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${concept}/${frameUnit(unit)}/${frame}.json`;
  try {
    const payload = await cachedSecJson(url, force, SEC_TTL);
    return (payload.data || []).map((fact) => ({ ...fact, concept, frame }));
  } catch (error) {
    if (diagnostics) {
      const target = String(error.message || "").startsWith("404")
        ? diagnostics.frameConceptUnavailable
        : diagnostics.frameFetchFailures;
      target.push({
        concept,
        unit,
        frame,
        url,
        error: error.message
      });
    }
    return [];
  }
}

async function fetchMetricFrameMap(metric, frame, force, diagnostics) {
  const map = new Map();
  for (const concept of metric.concepts) {
    const facts = await fetchFrameConcept(concept, metric.unit, frame, force, diagnostics);
    for (const fact of facts) {
      const cik = Number(fact.cik);
      if (!map.has(cik)) map.set(cik, fact);
    }
  }
  return map;
}

async function loadFrameMetrics(frameInfo, force, diagnostics) {
  const [
    revenueCurrent,
    revenuePrior,
    netIncomeCurrent,
    netIncomePrior,
    grossProfitCurrent,
    grossProfitPrior,
    operatingIncomeCurrent,
    operatingIncomePrior,
    operatingCashFlowCurrent,
    operatingCashFlowPrior
  ] = await Promise.all([
    fetchMetricFrameMap(METRICS.revenue, frameInfo.frame, force, diagnostics),
    fetchMetricFrameMap(METRICS.revenue, frameInfo.priorFrame, force, diagnostics),
    fetchMetricFrameMap(METRICS.netIncome, frameInfo.frame, force, diagnostics),
    fetchMetricFrameMap(METRICS.netIncome, frameInfo.priorFrame, force, diagnostics),
    fetchMetricFrameMap(METRICS.grossProfit, frameInfo.frame, force, diagnostics),
    fetchMetricFrameMap(METRICS.grossProfit, frameInfo.priorFrame, force, diagnostics),
    fetchMetricFrameMap(METRICS.operatingIncome, frameInfo.frame, force, diagnostics),
    fetchMetricFrameMap(METRICS.operatingIncome, frameInfo.priorFrame, force, diagnostics),
    fetchMetricFrameMap(METRICS.operatingCashFlow, frameInfo.frame, force, diagnostics),
    fetchMetricFrameMap(METRICS.operatingCashFlow, frameInfo.priorFrame, force, diagnostics)
  ]);

  return {
    revenue: { current: revenueCurrent, prior: revenuePrior },
    netIncome: { current: netIncomeCurrent, prior: netIncomePrior },
    grossProfit: { current: grossProfitCurrent, prior: grossProfitPrior },
    operatingIncome: { current: operatingIncomeCurrent, prior: operatingIncomePrior },
    operatingCashFlow: { current: operatingCashFlowCurrent, prior: operatingCashFlowPrior }
  };
}

function metricFromFrameMaps(frameMaps, key, cik) {
  const current = frameMaps[key].current.get(Number(cik)) || null;
  const prior = frameMaps[key].prior.get(Number(cik)) || null;
  return {
    concept: current?.concept || prior?.concept || "",
    current,
    prior,
    growth: growth(current, prior)
  };
}

function metricsFromFrames(frameMaps, cik) {
  const revenue = metricFromFrameMaps(frameMaps, "revenue", cik);
  const netIncome = metricFromFrameMaps(frameMaps, "netIncome", cik);
  const grossProfit = metricFromFrameMaps(frameMaps, "grossProfit", cik);
  const operatingIncome = metricFromFrameMaps(frameMaps, "operatingIncome", cik);
  const operatingCashFlow = metricFromFrameMaps(frameMaps, "operatingCashFlow", cik);
  const epsDiluted = { concept: "", current: null, prior: null, growth: { pct: null, turnaround: false } };
  const grossMargin = margin(grossProfit.current, revenue.current);
  const grossMarginPrior = margin(grossProfit.prior, revenue.prior);
  const operatingMargin = margin(operatingIncome.current, revenue.current);
  const operatingMarginPrior = margin(operatingIncome.prior, revenue.prior);

  return {
    revenue,
    netIncome,
    grossProfit,
    operatingIncome,
    operatingCashFlow,
    epsDiluted,
    grossMargin,
    grossMarginPrior,
    grossMarginDelta:
      grossMargin != null && grossMarginPrior != null ? grossMargin - grossMarginPrior : null,
    operatingMargin,
    operatingMarginPrior,
    operatingMarginDelta:
      operatingMargin != null && operatingMarginPrior != null
        ? operatingMargin - operatingMarginPrior
        : null
  };
}

function accessionsFromMetrics(metrics) {
  return [
    metrics.revenue.current?.accn,
    metrics.netIncome.current?.accn,
    metrics.grossProfit.current?.accn,
    metrics.operatingIncome.current?.accn
  ].filter(Boolean);
}

function latestMetricFact(metrics) {
  return [
    metrics.revenue.current,
    metrics.netIncome.current,
    metrics.grossProfit.current,
    metrics.operatingIncome.current,
    metrics.operatingCashFlow.current
  ]
    .filter(Boolean)
    .sort((a, b) => {
      const filedDiff = String(b.filed || "").localeCompare(String(a.filed || ""));
      if (filedDiff !== 0) return filedDiff;
      return String(b.end || "").localeCompare(String(a.end || ""));
    })[0] || null;
}

function latestDate(values = []) {
  return values
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
}

function sortDiagnosticsByFilingDate(items) {
  return [...items].sort((a, b) => {
    const filingDiff = String(b.filingDate || "").localeCompare(String(a.filingDate || ""));
    if (filingDiff !== 0) return filingDiff;
    const calendarDiff = String(b.calendarDates?.[0] || "").localeCompare(
      String(a.calendarDates?.[0] || "")
    );
    if (calendarDiff !== 0) return calendarDiff;
    return String(a.symbol || "").localeCompare(String(b.symbol || ""));
  });
}

function findFilingForAccessions(filings, accessions, range) {
  const set = new Set(accessions);
  return (
    filings.find(
      (filing) =>
        set.has(filing.accessionNumber) &&
        inDateRange(filing.filingDate, range.start, range.today)
    ) ||
    latestRankingFiling(filings, range) ||
    null
  );
}

function createRankingDiagnostics() {
  return {
    version: RANKING_DIAGNOSTICS_VERSION,
    calendarFetchFailures: [],
    frameFetchFailures: [],
    frameConceptUnavailable: [],
    missingSymbols: [],
    manualCompanyMissing: [],
    noCurrentFrameFacts: [],
    noPositiveScore: [],
    notEnrichedDueLimit: [],
    enrichFailures: [],
    filingMissing: [],
    filteredByDisclosureWindow: [],
    textDocsMissing: [],
    textScanFailures: [],
    analysisCacheHits: 0,
    analysisCacheMisses: 0,
    counts: {}
  };
}

function candidateSummary(candidate, reason = "") {
  return {
    symbol: candidate.symbol,
    name: candidate.company?.name || candidate.name || candidate.symbol,
    cik: candidate.cik || candidate.company?.cik || "",
    sources: candidate.sources || [],
    calendarDates: candidate.calendarDates || [],
    metricScore: candidate.metricScore?.score ?? null,
    filingDate: candidate.filing?.filingDate || "",
    reportDate: candidate.filing?.reportDate || "",
    reasons: candidate.metricScore?.reasons || [],
    reason
  };
}

function diagnosticsCounts(diagnostics) {
  return {
    calendarFetchFailures: diagnostics.calendarFetchFailures.length,
    frameFetchFailures: diagnostics.frameFetchFailures.length,
    frameConceptUnavailable: diagnostics.frameConceptUnavailable.length,
    missingSymbols: diagnostics.missingSymbols.length,
    manualCompanyMissing: diagnostics.manualCompanyMissing.length,
    noCurrentFrameFacts: diagnostics.noCurrentFrameFacts.length,
    noPositiveScore: diagnostics.noPositiveScore.length,
    notEnrichedDueLimit: diagnostics.notEnrichedDueLimit.length,
    enrichFailures: diagnostics.enrichFailures.length,
    filingMissing: diagnostics.filingMissing.length,
    filteredByDisclosureWindow: diagnostics.filteredByDisclosureWindow.length,
    textDocsMissing: diagnostics.textDocsMissing.length,
    textScanFailures: diagnostics.textScanFailures.length,
    analysisCacheHits: diagnostics.analysisCacheHits,
    analysisCacheMisses: diagnostics.analysisCacheMisses
  };
}

async function resolveCandidateFiling(candidate, range, force, diagnostics) {
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPad(candidate.cik)}.json`;
  const submissions = await cachedSecJson(submissionsUrl, force);
  const filings = zipFilings(submissions.filings?.recent);
  const filing = findFilingForAccessions(filings, candidate.accessions, range);
  if (!filing && diagnostics) {
    diagnostics.filingMissing.push({
      ...candidateSummary(candidate, "SEC submissions 中没有匹配当前披露窗口的 10-Q/10-K/20-F/40-F"),
      accessions: candidate.accessions
    });
  }
  return {
    ...candidate,
    filings,
    filing,
    submissionsName: submissions.name
  };
}

function candidateDisclosureTime(candidate) {
  const time = Date.parse(`${candidate.filing?.filingDate || ""}T00:00:00Z`);
  if (!Number.isNaN(time)) return time;
  const calendarTimes = (candidate.calendarDates || [])
    .map((date) => Date.parse(`${date}T00:00:00Z`))
    .filter((value) => !Number.isNaN(value));
  if (calendarTimes.length) return Math.max(...calendarTimes);
  const reportTime = Date.parse(`${candidate.rawMetrics?.revenue?.current?.end || candidate.rawMetrics?.netIncome?.current?.end || ""}T00:00:00Z`);
  return Number.isNaN(reportTime) ? 0 : reportTime;
}

function sortCandidatesByDisclosureTime(candidates) {
  return [...candidates].sort((a, b) => {
    const timeDiff = candidateDisclosureTime(b) - candidateDisclosureTime(a);
    if (timeDiff !== 0) return timeDiff;
    if (b.metricScore.score !== a.metricScore.score) return b.metricScore.score - a.metricScore.score;
    return a.symbol.localeCompare(b.symbol);
  });
}

function analysisCacheName(candidate, range, frameInfo, options) {
  const key = hashKey(
    JSON.stringify({
      symbol: candidate.symbol,
      cik: candidate.cik,
      forced: candidate.forced || false,
      manualQueries: candidate.manualQueries || [],
      frame: frameInfo.frame,
      rangeStart: range.start,
      rangeToday: range.today,
      accessions: candidate.accessions,
      filing: candidate.filing
        ? {
            accessionNumber: candidate.filing.accessionNumber,
            filingDate: candidate.filing.filingDate,
            primaryDocument: candidate.filing.primaryDocument
          }
        : null,
      metricScore: candidate.metricScore,
      customKeywordRules: options.customKeywordRules,
      includeCashFlow: options.includeCashFlow,
      cashFlowThresholdPct: options.cashFlowThresholdPct,
      signalPatternVersion: SIGNAL_PATTERN_VERSION,
      diagnosticsVersion: RANKING_DIAGNOSTICS_VERSION
    })
  );
  return `analysis-${frameInfo.frame}-${candidate.symbol}-${key}.json`;
}

function mergeDiagnostics(target, source = {}) {
  const listKeys = [
    "filingMissing",
    "textDocsMissing",
    "textScanFailures"
  ];
  for (const key of listKeys) {
    if (Array.isArray(source[key]) && source[key].length) {
      target[key].push(...source[key]);
    }
  }
}

function createCandidateDiagnosticsDelta() {
  return {
    filingMissing: [],
    textDocsMissing: [],
    textScanFailures: []
  };
}

async function enrichFrameCandidate(candidate, range, force, diagnostics, options) {
  const filings = candidate.filings || [];
  const filing = candidate.filing || findFilingForAccessions(filings, candidate.accessions, range);
  const signals =
    filing && shouldScanTextSignals(candidate.metricScore, candidate.rawMetrics)
      ? await scanSignals(candidate.cik, filings, filing, range, force, diagnostics, candidate.symbol, options)
      : [];
  const signalScore = signals.reduce((sum, item) => sum + item.score, 0);
  const customFindings = customFindingsFromMetrics(candidate.rawMetrics, options);
  const score = Math.min(100, Math.round(candidate.metricScore.score + Math.min(35, signalScore)));
  const highlight =
    score >= 70 ||
    customFindings.length > 0 ||
    signals.length >= 2 ||
    signals.some((signal) =>
      ["产品供不应求", "供给偏紧", "需求旺盛", "产品价格中枢持续上涨"].includes(signal.label)
    );

  const fallbackEnd =
    candidate.rawMetrics.revenue.current?.end || candidate.rawMetrics.netIncome.current?.end || "";

  return {
    symbol: candidate.symbol,
    name:
      candidate.company.name ||
      candidate.submissionsName ||
      candidate.rawMetrics.revenue.current?.entityName ||
      candidate.symbol,
    exchange: candidate.company.exchange || "",
    score,
    highlight,
    forced: candidate.forced || false,
    manualQueries: candidate.manualQueries || [],
    reasons:
      candidate.metricScore.reasons.length || !candidate.forced
        ? candidate.metricScore.reasons
        : ["指定分析：未触发亮眼条件"],
    signals,
    customFindings,
    filing: filing
      ? {
          form: filing.form,
          filingDate: filing.filingDate,
          reportDate: filing.reportDate || fallbackEnd,
          accessionNumber: filing.accessionNumber,
          primaryDocument: filing.primaryDocument,
          url: secFilingUrl(candidate.cik, filing.accessionNumber, filing.primaryDocument)
        }
      : {
          form: "SEC frame",
          filingDate: "",
          reportDate: fallbackEnd,
          accessionNumber: candidate.accessions[0] || "",
          primaryDocument: "",
          url: `https://www.sec.gov/edgar/browse/?CIK=${candidate.symbol}&owner=exclude`
        },
    stockUrl: stockUrl(candidate.symbol),
    metrics: {
      revenue: metricPayload(candidate.rawMetrics.revenue),
      netIncome: metricPayload(candidate.rawMetrics.netIncome),
      epsDiluted: metricPayload(candidate.rawMetrics.epsDiluted),
      operatingCashFlow: metricPayload(candidate.rawMetrics.operatingCashFlow),
      grossMargin: candidate.rawMetrics.grossMargin,
      grossMarginDelta: candidate.rawMetrics.grossMarginDelta,
      operatingMargin: candidate.rawMetrics.operatingMargin,
      operatingMarginDelta: candidate.rawMetrics.operatingMarginDelta
    }
  };
}

async function enrichFrameCandidateWithCache(candidate, range, force, diagnostics, options, frameInfo) {
  const cacheName = analysisCacheName(candidate, range, frameInfo, options);
  if (options.reuseAnalysis) {
    const cached = await readCache(cacheName, 30 * DAY);
    if (cached?.row) {
      diagnostics.analysisCacheHits += 1;
      mergeDiagnostics(diagnostics, cached.diagnosticsDelta);
      return {
        ...cached.row,
        forced: candidate.forced || cached.row.forced || false,
        manualQueries: candidate.manualQueries || cached.row.manualQueries || [],
        analysisCache: "hit"
      };
    }
  }
  diagnostics.analysisCacheMisses += 1;
  const diagnosticsDelta = createCandidateDiagnosticsDelta();
  const row = await enrichFrameCandidate(candidate, range, force, diagnosticsDelta, options);
  await writeCache(cacheName, {
    row,
    diagnosticsDelta,
    generatedAt: new Date().toISOString()
  });
  mergeDiagnostics(diagnostics, diagnosticsDelta);
  return { ...row, analysisCache: "fresh" };
}

async function mapLimit(items, limit, iteratee) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        output[index] = await iteratee(items[index], index);
      } catch (error) {
        output[index] = { error: error.message, item: items[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function getRankings(force = false, options = parseRankingOptions()) {
  const range = quarterRange();
  const frameInfo = reportingFrame();
  const optionsHash = rankingOptionsFingerprint(options);
  const cacheName = `rankings-${frameInfo.frame}-${range.today}-${optionsHash}.json`;
  if (!force) {
    const cached = await readCache(cacheName, RANKING_TTL);
    if (cached?.diagnostics?.version === RANKING_DIAGNOSTICS_VERSION) {
      return { ...cached, cache: "hit" };
    }
  }

  const startedAt = Date.now();
  const diagnostics = createRankingDiagnostics();
  const universe = await loadUniverse();
  const calendarUniverse = await getCalendarSymbolsForRange(range, force, diagnostics);
  const tickerMap = await loadTickerMap(force);
  const manualCompanies = resolveTickerQueries(tickerMap, options.focusCompanyQueries);
  diagnostics.manualCompanyMissing.push(...manualCompanies.missing);
  const frameMaps = await loadFrameMetrics(frameInfo, force, diagnostics);
  const universeMap = new Map();
  for (const symbol of universe.symbols) {
    universeMap.set(symbol, { symbol, sources: ["static"], calendarDates: [] });
  }
  for (const item of calendarUniverse) {
    const existing = universeMap.get(item.symbol);
    if (existing) {
      existing.sources = sourceSet(...existing.sources, "calendar");
      existing.calendarDates = sourceSet(...existing.calendarDates, ...item.calendarDates);
      existing.calendarName = item.name;
    } else {
      universeMap.set(item.symbol, {
        symbol: item.symbol,
        sources: ["calendar"],
        calendarDates: item.calendarDates,
        calendarName: item.name
      });
    }
  }
  for (const company of manualCompanies.matches) {
    const symbol = normalizeTicker(company.ticker);
    const existing = universeMap.get(symbol);
    if (existing) {
      existing.sources = sourceSet(...existing.sources, "manual");
      existing.manualQueries = sourceSet(...(existing.manualQueries || []), ...(company.queries || []));
      existing.forced = true;
      existing.calendarName = existing.calendarName || company.name;
    } else {
      universeMap.set(symbol, {
        symbol,
        sources: ["manual"],
        calendarDates: [],
        calendarName: company.name,
        manualQueries: company.queries || [],
        forced: true
      });
    }
  }
  const universeItems = [...universeMap.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const symbols = universeItems.filter((item) => tickerMap.has(item.symbol)).map((item) => item.symbol);
  const missingSymbols = universeItems.filter((item) => !tickerMap.has(item.symbol));
  diagnostics.missingSymbols = missingSymbols.map((item) => ({
    symbol: item.symbol,
    name: item.calendarName || "",
    sources: item.sources,
    calendarDates: item.calendarDates,
    reason: "未在 SEC company_tickers_exchange.json 中匹配到 CIK"
  }));

  const candidates = [];
  for (const symbol of symbols) {
    const company = tickerMap.get(symbol);
    const universeItem = universeMap.get(symbol);
    const forced = universeItem?.forced || false;
    const rawMetrics = metricsFromFrames(frameMaps, company.cik);
    const hasCurrentFacts =
      rawMetrics.revenue.current ||
      rawMetrics.netIncome.current ||
      (options.includeCashFlow && rawMetrics.operatingCashFlow.current);
    if (!hasCurrentFacts) {
      diagnostics.noCurrentFrameFacts.push({
        symbol,
        name: company.name,
        cik: company.cik,
        sources: universeItem?.sources || [],
        calendarDates: universeItem?.calendarDates || [],
        reason: `SEC frames 中没有 ${frameInfo.frame} 的当前营收、净利润或已启用自定义指标事实`
      });
      if (!forced) continue;
    }
    const metricScore = scoreMetrics(rawMetrics, options);
    if (metricScore.score <= 0) {
      const latestFact = latestMetricFact(rawMetrics);
      const disclosureDate = latestFact?.filed || latestDate(universeItem?.calendarDates) || "";
      diagnostics.noPositiveScore.push({
        symbol,
        name: company.name,
        cik: company.cik,
        sources: universeItem?.sources || [],
        calendarDates: universeItem?.calendarDates || [],
        filingDate: disclosureDate,
        filingDateSource: latestFact?.filed ? "sec-frame" : disclosureDate ? "calendar" : "",
        reportDate: latestFact?.end || "",
        frame: latestFact?.frame || frameInfo.frame,
        accessionNumber: latestFact?.accn || "",
        metricScore: metricScore.score,
        reason: forced
          ? "指定公司已强制展示；当前评分未触发营收/净利/利润率改善或自定义指标条件"
          : "已有当前期事实，但未触发营收/净利/利润率改善或自定义指标条件"
      });
      if (!forced) continue;
    }
    candidates.push({
      symbol,
      company,
      cik: company.cik,
      sources: universeItem?.sources || [],
      calendarDates: universeItem?.calendarDates || [],
      forced,
      manualQueries: universeItem?.manualQueries || [],
      rawMetrics,
      metricScore,
      accessions: accessionsFromMetrics(rawMetrics)
    });
  }
  const orderedCandidates = sortCandidatesByDisclosureTime(candidates);
  const selectedCandidates = [];
  const selectedSymbols = new Set();
  for (const candidate of orderedCandidates) {
    if (selectedCandidates.length < options.analysisLimit || candidate.forced) {
      if (!selectedSymbols.has(candidate.symbol)) {
        selectedCandidates.push(candidate);
        selectedSymbols.add(candidate.symbol);
      }
    }
  }
  diagnostics.notEnrichedDueLimit = orderedCandidates
    .filter((candidate) => !selectedSymbols.has(candidate.symbol) && !candidate.forced)
    .map((candidate) =>
      candidateSummary(
        candidate,
        `按披露时间排序后超过本次分析数量 ${options.analysisLimit}，未做 SEC 披露补全、文本扫描和最终展示`
      )
    );

  const resolvedCandidatesRaw = await mapLimit(selectedCandidates, 4, async (candidate) => {
    return resolveCandidateFiling(candidate, range, force, diagnostics);
  });
  const resolveErrors = resolvedCandidatesRaw
    .filter((row) => row?.error)
    .map((row) => ({
      ...candidateSummary(row.item, "候选公司补全 submissions/披露日期时失败"),
      error: row.error
    }));
  diagnostics.enrichFailures.push(...resolveErrors);
  const resolvedCandidates = resolvedCandidatesRaw.filter((row) => row && !row.error);
  const analysisCandidates = sortCandidatesByDisclosureTime(
    resolvedCandidates.filter((candidate) => candidate.filing?.filingDate || candidate.forced)
  );

  const rows = await mapLimit(analysisCandidates, 4, async (candidate) => {
    return enrichFrameCandidateWithCache(candidate, range, force, diagnostics, options, frameInfo);
  });

  const errors = rows
    .filter((row) => row?.error)
    .map((row) => ({
      ...candidateSummary(row.item, "候选公司补全 submissions/财报链接时失败"),
      error: row.error
    }));
  diagnostics.enrichFailures.push(...errors);

  const successfulRows = rows.filter((row) => row && !row.error);
  const rowsInDisclosureWindow = successfulRows.filter((row) => {
    if (row.forced) return true;
    if (!row.filing.filingDate) return false;
    const inWindow = inDateRange(row.filing.filingDate, range.start, range.today);
    if (!inWindow) {
      diagnostics.filteredByDisclosureWindow.push({
        symbol: row.symbol,
        name: row.name,
        form: row.filing.form,
        filingDate: row.filing.filingDate,
        reportDate: row.filing.reportDate,
        accessionNumber: row.filing.accessionNumber,
        reason: `候选财务事实属于 ${frameInfo.frame}，但未找到当前披露窗口 ${range.start} 至 ${range.today} 内的财报提交`
      });
    }
    return inWindow;
  });

  const ranked = rowsInDisclosureWindow
    .filter((row) => row.forced || row.score > 0 || row.signals.length)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.filing.filingDate).localeCompare(String(a.filing.filingDate));
    });
  diagnostics.noPositiveScore = sortDiagnosticsByFilingDate(diagnostics.noPositiveScore);
  diagnostics.counts = diagnosticsCounts(diagnostics);

  const payload = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range,
    reportingFrame: frameInfo,
    analysisOptions: {
      analysisLimit: options.analysisLimit,
      reuseAnalysis: options.reuseAnalysis,
      order: "calendarDateThenFilingDateDesc",
      method: "SEC XBRL frames + regex keyword scan",
      usesLLM: false,
      includeCashFlow: options.includeCashFlow,
      cashFlowThresholdPct: options.cashFlowThresholdPct,
      customKeywordRules: options.customKeywordRules,
      focusCompanyQueries: options.focusCompanyQueries
    },
    source: {
      filings: "SEC EDGAR frames + submissions",
      text: "SEC filing primary documents; regex/string keyword matching, no LLM",
      universe: "config/universe.json + Nasdaq earnings calendar for the current disclosure window"
    },
    totals: {
      configured: universe.symbols.length,
      calendarSymbols: calendarUniverse.length,
      combinedUniverse: universeItems.length,
      scanned: symbols.length,
      candidates: candidates.length,
      analyzable: orderedCandidates.length,
      selectedForAnalysis: selectedCandidates.length,
      enriched: analysisCandidates.length,
      ranked: ranked.length,
      forced: ranked.filter((row) => row.forced).length,
      missingSymbols,
      errors,
      diagnostics: diagnostics.counts
    },
    diagnostics,
    rows: ranked
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
}

function monthDays(month) {
  const [year, monthIndex] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, monthIndex - 1, 1));
  const days = [];
  for (let day = start; day.getUTCMonth() === monthIndex - 1; day = addDays(day, 1)) {
    days.push(toDateOnly(day));
  }
  return days;
}

function cleanNasdaqRow(row, date) {
  const symbol = normalizeTicker(row.symbol || "");
  return {
    date,
    symbol,
    name: row.name || symbol,
    marketCap: row.marketCap || "",
    time: row.time || "time-not-supplied",
    fiscalQuarterEnding: row.fiscalQuarterEnding || "",
    epsForecast: row.epsForecast || "",
    noOfEsts: row.noOfEsts || "",
    lastYearRptDt: row.lastYearRptDt || "",
    lastYearEPS: row.lastYearEPS || "",
    stockUrl: stockUrl(symbol),
    nasdaqUrl: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/earnings`
  };
}

async function fetchCalendarDay(date, force = false) {
  const cacheName = `calendar-day-${date}.json`;
  if (!force) {
    const cached = await readCache(cacheName, CALENDAR_TTL);
    if (cached) return cached;
  }
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
  const payload = await fetchNasdaqJson(url);
  const rows = (payload?.data?.rows || []).map((row) => cleanNasdaqRow(row, date));
  const result = { date, rows, fetchedAt: new Date().toISOString() };
  await writeCache(cacheName, result);
  return result;
}

function fieldValue(data, key) {
  const value = data?.[key];
  if (value && typeof value === "object" && "value" in value) return value.value || "";
  return value || "";
}

function conciseDescription(value, maxLength = 260) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function normalizedDescription(value, maxLength = 1800) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function fetchNasdaqCompanyProfile(symbol, force = false) {
  const url = `https://api.nasdaq.com/api/company/${encodeURIComponent(
    symbol
  )}/company-profile`;
  const payload = await cachedNasdaqJson(url, force, PROFILE_TTL);
  const data = payload?.data || {};
  const businessDescription = normalizedDescription(fieldValue(data, "CompanyDescription"));
  return {
    symbol,
    name: fieldValue(data, "CompanyName"),
    sector: fieldValue(data, "Sector"),
    industry: fieldValue(data, "Industry"),
    region: fieldValue(data, "Region"),
    businessDescription,
    profileSource: businessDescription ? "Nasdaq company profile" : "",
    status: businessDescription ? "ok" : "empty"
  };
}

async function fetchSecCompanyProfile(symbol, company, force = false) {
  if (!company?.cik) {
    return {
      symbol,
      businessDescription: "",
      profileSource: "",
      status: "missing-cik"
    };
  }
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPad(company.cik)}.json`;
  const submissions = await cachedSecJson(submissionsUrl, force, PROFILE_TTL);
  const sicDescription = conciseDescription(submissions.sicDescription || "");
  return {
    symbol,
    name: submissions.name || company.name || symbol,
    sector: "",
    industry: sicDescription,
    region: "",
    businessDescription: sicDescription ? `SEC 行业分类：${sicDescription}` : "",
    profileSource: sicDescription ? "SEC submissions" : "",
    status: sicDescription ? "ok" : "empty"
  };
}

async function getCompanyProfiles(symbols, force = false) {
  const normalizedSymbols = [
    ...new Set(
      String(symbols || "")
        .split(/[,，\s]+/)
        .map((symbol) => normalizeTicker(symbol.trim()))
        .filter(Boolean)
    )
  ].slice(0, 120);
  const tickerMap = await loadTickerMap(force);
  const rows = await mapLimit(normalizedSymbols, 5, async (symbol) => {
    const company = tickerMap.get(symbol);
    let profile;
    try {
      profile = await fetchNasdaqCompanyProfile(symbol, force);
    } catch {
      // Fall back to SEC below.
    }
    if (!profile?.businessDescription && !profile?.industry && !profile?.sector) {
      try {
        profile = await fetchSecCompanyProfile(symbol, company, force);
      } catch (error) {
        return {
          symbol,
          businessDescription: "",
          profileSource: "",
          status: "error",
          error: error.message
        };
      }
    }

    const sourceName = profile.name || company?.name || symbol;
    try {
      const translation = await translateToChinese(sourceName, force);
      if (translation.status === "ok") {
        profile.chineseName = translation.translatedText;
        profile.nameTranslationSource = translation.provider;
      }
    } catch {
      profile.chineseName = "";
      profile.nameTranslationSource = "";
    }
    return profile;
  });
  const profiles = {};
  for (const row of rows) {
    if (row?.error) {
      const symbol = row.item || "";
      if (!symbol) continue;
      profiles[symbol] = {
        symbol,
        businessDescription: "",
        profileSource: "",
        status: "error",
        error: row.error
      };
      continue;
    }
    if (!row?.symbol) continue;
    profiles[row.symbol] = row;
  }
  return {
    generatedAt: new Date().toISOString(),
    source: "Nasdaq company profile; SEC submissions fallback",
    requested: normalizedSymbols.length,
    profiles
  };
}

async function getChineseTranslation(text, force = false) {
  const translation = await translateToChinese(text, force);
  return {
    generatedAt: new Date().toISOString(),
    ...translation
  };
}

async function getCalendarSymbolsForRange(range, force = false, diagnostics = null) {
  const days = dateRange(range.start, range.today);
  const dayResults = await mapLimit(days, 5, (date) => fetchCalendarDay(date, force));
  const symbols = new Map();
  for (const result of dayResults) {
    if (result?.error) {
      diagnostics?.calendarFetchFailures.push({
        date: result.item || "",
        source: "Nasdaq earnings calendar",
        reason: "日历接口拉取失败，该日期公司无法并入扫描池",
        error: result.error
      });
      continue;
    }
    for (const row of result?.rows || []) {
      const symbol = normalizeTicker(row.symbol || "");
      if (!symbol) continue;
      const existing = symbols.get(symbol) || {
        symbol,
        name: row.name || symbol,
        calendarDates: []
      };
      existing.name = existing.name || row.name || symbol;
      existing.calendarDates = sourceSet(...existing.calendarDates, result.date);
      symbols.set(symbol, existing);
    }
  }
  return [...symbols.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function getCalendar(month, force = false) {
  const normalizedMonth = month || new Date().toISOString().slice(0, 7);
  const cacheName = `calendar-month-${normalizedMonth}.json`;
  if (!force) {
    const cached = await readCache(cacheName, CALENDAR_TTL);
    if (cached) return { ...cached, cache: "hit" };
  }

  const startedAt = Date.now();
  const days = monthDays(normalizedMonth);
  const dayResults = await mapLimit(days, 5, (date) => fetchCalendarDay(date, force));
  const byDate = {};
  for (const result of dayResults) {
    if (result?.date) byDate[result.date] = result.rows || [];
  }
  const totalEvents = Object.values(byDate).reduce((sum, rows) => sum + rows.length, 0);
  const payload = {
    month: normalizedMonth,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    source: "Nasdaq earnings calendar",
    totalEvents,
    byDate
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
}

function ashareReportInfo(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (month >= 11) return { date: `${year}-09-30`, label: `${year} 三季报` };
  if (month >= 9) return { date: `${year}-06-30`, label: `${year} 半年报` };
  if (month >= 5) return { date: `${year}-03-31`, label: `${year} 一季报` };
  return { date: `${year - 1}-12-31`, label: `${year - 1} 年报` };
}

function asharePeriodLabel(reportDate) {
  const value = String(reportDate || "").slice(0, 10);
  const year = value.slice(0, 4);
  if (value.endsWith("-03-31")) return `${year} 一季报`;
  if (value.endsWith("-06-30")) return `${year} 半年报`;
  if (value.endsWith("-09-30")) return `${year} 三季报`;
  if (value.endsWith("-12-31")) return `${year} 年报`;
  return value || "财报";
}

function ashareDate(value) {
  return String(value || "").slice(0, 10);
}

function isStAshareName(name) {
  return /^S?\*?ST/i.test(String(name || "").trim());
}

function isAshareRow(row) {
  return (
    /\.(SH|SZ|BJ)$/.test(row.SECUCODE || "") &&
    row.SECURITY_TYPE !== "三板股" &&
    !isStAshareName(row.SECURITY_NAME_ABBR)
  );
}

function ashareMarketPrefix(secucode) {
  if (String(secucode).endsWith(".SH")) return "SH";
  if (String(secucode).endsWith(".BJ")) return "BJ";
  return "SZ";
}

function ashareQuoteSecid(secucode) {
  const code = String(secucode || "").slice(0, 6);
  if (String(secucode).endsWith(".SH")) return `1.${code}`;
  return `0.${code}`;
}

function ashareStockUrl(secucode) {
  const code = String(secucode || "").slice(0, 6);
  const prefix = ashareMarketPrefix(secucode).toLowerCase();
  return `https://quote.eastmoney.com/${prefix}${code}.html`;
}

function ashareReportUrl(secucode) {
  const code = String(secucode || "").slice(0, 6);
  return `https://emweb.securities.eastmoney.com/PC_HSF10/FinanceAnalysis/Index?type=web&code=${ashareMarketPrefix(
    secucode
  )}${code}`;
}

function ashareMoney(value) {
  if (!Number.isFinite(Number(value))) return "";
  return formatNumber(Number(value));
}

function ashareMarketCapDisplay(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "";
  return `¥${Math.round(Number(value)).toLocaleString("en-US")}`;
}

async function fetchAshareQuotes(secucodes, force = false) {
  const wanted = new Set(secucodes.map((item) => String(item || "").slice(0, 6)).filter(Boolean));
  try {
    const latestUrl = eastmoneyDataUrl("RPT_VALUEANALYSIS_DET", {
      pageNumber: "1",
      pageSize: "1",
      sortColumns: "TRADE_DATE",
      sortTypes: "-1",
      columns: "SECURITY_CODE,TRADE_DATE"
    });
    const latest = await cachedEastmoneyJson(latestUrl, force, SEC_TTL);
    const tradeDate = ashareDate(latest?.result?.data?.[0]?.TRADE_DATE);
    if (!tradeDate) return new Map();
    const rows = await fetchEastmoneyPaged(
      "RPT_VALUEANALYSIS_DET",
      {
        pageSize: "500",
        sortColumns: "SECURITY_CODE",
        sortTypes: "1",
        columns:
          "SECURITY_CODE,SECUCODE,SECURITY_NAME_ABBR,TOTAL_MARKET_CAP,NOTLIMITED_MARKETCAP_A,BOARD_NAME,TRADE_DATE",
        filter: `(TRADE_DATE='${tradeDate}')`
      },
      force
    );
    const output = new Map();
    for (const item of rows) {
      const code = String(item.SECURITY_CODE || "").slice(0, 6);
      if (wanted.size && !wanted.has(code)) continue;
      output.set(code, {
        symbol: code,
        secucode: item.SECUCODE || "",
        name: item.SECURITY_NAME_ABBR || code,
        marketCap: Number(item.TOTAL_MARKET_CAP) || null,
        floatMarketCap: Number(item.NOTLIMITED_MARKETCAP_A) || null,
        industry: item.BOARD_NAME || "",
        tradeDate
      });
    }
    return output;
  } catch {
    return new Map();
  }
}

function priorAshareReportDate(reportDate) {
  const value = ashareDate(reportDate);
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return "";
  return `${year - 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function fetchAshareCashFlowMap(reportDate, force = false) {
  if (!reportDate) return new Map();
  const rows = await fetchEastmoneyPaged(
    "RPT_DMSK_FN_CASHFLOW",
    {
      pageSize: "500",
      sortColumns: "NOTICE_DATE,SECURITY_CODE",
      sortTypes: "-1,1",
      columns:
        "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,NOTICE_DATE,NETCASH_OPERATE",
      filter: `(REPORT_DATE='${reportDate}')`
    },
    force
  );
  const output = new Map();
  for (const row of rows) {
    if (!/\.(SH|SZ|BJ)$/.test(row.SECUCODE || "")) continue;
    const code = String(row.SECURITY_CODE || "").slice(0, 6);
    if (!code) continue;
    output.set(code, {
      value: Number(row.NETCASH_OPERATE),
      reportDate: ashareDate(row.REPORT_DATE),
      filingDate: ashareDate(row.NOTICE_DATE)
    });
  }
  return output;
}

function ashareCashFlowMetric(code, currentMap, priorMap, row) {
  const current = currentMap?.get(code);
  const prior = priorMap?.get(code);
  const metricGrowth = growth(
    Number.isFinite(current?.value) ? { val: current.value } : null,
    Number.isFinite(prior?.value) ? { val: prior.value } : null
  );
  return {
    current: current?.value,
    currentDisplay: Number.isFinite(current?.value) ? formatNumber(current.value) : row.MGJYXJJE ?? "",
    prior: prior?.value,
    priorDisplay: Number.isFinite(prior?.value) ? formatNumber(prior.value) : "",
    growthPct: metricGrowth.pct,
    turnaround: metricGrowth.turnaround
  };
}

function ashareCustomFindings(row, quote = {}, options = {}, cashFlowMetric = {}) {
  const findings = [];
  if (options.includeCashFlow) {
    if (cashFlowMetric.turnaround) {
      findings.push({ label: "经营现金流扭亏", value: "turnaround" });
    } else if (
      Number.isFinite(cashFlowMetric.growthPct) &&
      cashFlowMetric.growthPct >= options.cashFlowThreshold
    ) {
      findings.push({
        label: "经营现金流增长",
        value: `同比 ${(cashFlowMetric.growthPct * 100).toFixed(1)}%`
      });
    }
  }
  const haystack = [
    row.SECURITY_NAME_ABBR,
    row.BOARD_NAME,
    row.PUBLISHNAME,
    quote.industry
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const rule of options.customKeywordRules || []) {
    const matched = rule.terms.find((term) => haystack.includes(String(term).toLowerCase()));
    if (matched) {
      findings.push({ label: `自定义：${rule.label}`, value: `匹配 ${matched}` });
    }
  }
  return findings;
}

function scoreAshareRow(row, options = {}, cashFlowMetric = {}) {
  const state = { score: 0, reasons: [] };
  const revenueGrowth = Number(row.YSTZ);
  const profitGrowth = Number(row.SJLTZ);
  const profit = Number(row.PARENT_NETPROFIT);
  const roe = Number(row.WEIGHTAVG_ROE);
  const grossMargin = Number(row.XSMLL);
  const cashFlowPerShare = Number(row.MGJYXJJE);

  if (Number.isFinite(revenueGrowth)) {
    if (revenueGrowth >= 100) {
      state.score += 40;
      state.reasons.push("营收同比翻倍");
    } else if (revenueGrowth >= 50) {
      state.score += 32;
      state.reasons.push("营收同比>50%");
    } else if (revenueGrowth >= 25) {
      state.score += 22;
      state.reasons.push("营收同比>25%");
    } else if (revenueGrowth >= 10) {
      state.score += 10;
      state.reasons.push("营收同比>10%");
    }
  }
  if (Number.isFinite(profitGrowth)) {
    if (profitGrowth >= 100) {
      state.score += 32;
      state.reasons.push("归母净利同比翻倍");
    } else if (profitGrowth >= 50) {
      state.score += 24;
      state.reasons.push("归母净利同比>50%");
    } else if (profitGrowth >= 25) {
      state.score += 14;
      state.reasons.push("归母净利同比>25%");
    } else if (profitGrowth >= 10) {
      state.score += 8;
      state.reasons.push("归母净利同比>10%");
    }
  }
  if (Number.isFinite(profit) && profit > 0 && Number.isFinite(roe)) {
    if (roe >= 15) {
      state.score += 12;
      state.reasons.push("ROE>15%");
    } else if (roe >= 8) {
      state.score += 6;
      state.reasons.push("ROE>8%");
    }
  }
  if (Number.isFinite(grossMargin) && grossMargin >= 40) {
    state.score += 5;
    state.reasons.push("毛利率>40%");
  }
  if (options.includeCashFlow) {
    if (cashFlowMetric.turnaround) {
      state.score += 14;
      state.reasons.push("经营现金流扭亏");
    } else if (Number.isFinite(cashFlowMetric.growthPct)) {
      if (cashFlowMetric.growthPct >= Math.max(1, options.cashFlowThreshold * 3)) {
        state.score += 18;
        state.reasons.push("经营现金流同比翻倍");
      } else if (cashFlowMetric.growthPct >= options.cashFlowThreshold) {
        state.score += 12;
        state.reasons.push(`经营现金流同比>${options.cashFlowThresholdPct}%`);
      } else if (cashFlowMetric.growthPct >= 0.1) {
        state.score += 6;
        state.reasons.push("经营现金流同比>10%");
      }
    } else if (Number.isFinite(cashFlowPerShare) && cashFlowPerShare > 0) {
      state.score += 4;
      state.reasons.push("经营现金流/股为正");
    }
  }
  return state;
}

function ashareRowToRanking(row, quote = {}, options = {}, cashFlowMetric = {}, meta = {}) {
  const secucode = row.SECUCODE || `${row.SECURITY_CODE}.SZ`;
  const metricScore = scoreAshareRow(row, options, cashFlowMetric);
  const signals = [];
  const customFindings = ashareCustomFindings(row, quote, options, cashFlowMetric);
  const revenueGrowth = Number(row.YSTZ);
  const profitGrowth = Number(row.SJLTZ);
  if (Number.isFinite(revenueGrowth) && revenueGrowth >= 50) {
    signals.push({
      label: "营收高增长",
      score: 8,
      hits: [{ form: row.DATATYPE || asharePeriodLabel(row.REPORTDATE), filingDate: ashareDate(row.NOTICE_DATE), context: `营收同比 ${revenueGrowth.toFixed(1)}%`, url: ashareReportUrl(secucode) }]
    });
  }
  if (Number.isFinite(profitGrowth) && profitGrowth >= 50) {
    signals.push({
      label: "净利高增长",
      score: 8,
      hits: [{ form: row.DATATYPE || asharePeriodLabel(row.REPORTDATE), filingDate: ashareDate(row.NOTICE_DATE), context: `归母净利同比 ${profitGrowth.toFixed(1)}%`, url: ashareReportUrl(secucode) }]
    });
  }
  const score = Math.min(100, metricScore.score + Math.min(16, signals.reduce((sum, item) => sum + item.score, 0)));
  return {
    symbol: row.SECURITY_CODE,
    name: row.SECURITY_NAME_ABBR || quote.name || row.SECURITY_CODE,
    exchange: row.TRADE_MARKET || "",
    score,
    highlight: score >= 70 || signals.length >= 2,
    forced: meta.forced || false,
    manualQueries: meta.manualQueries || [],
    reasons:
      metricScore.reasons.length || !meta.forced
        ? metricScore.reasons
        : ["指定分析：未触发亮眼条件"],
    signals,
    customFindings,
    filing: {
      form: row.DATATYPE || asharePeriodLabel(row.REPORTDATE),
      filingDate: ashareDate(row.NOTICE_DATE),
      reportDate: ashareDate(row.REPORTDATE),
      accessionNumber: secucode,
      primaryDocument: "",
      url: ashareReportUrl(secucode)
    },
    stockUrl: ashareStockUrl(secucode),
    metrics: {
      revenue: {
        growthPct: Number.isFinite(Number(row.YSTZ)) ? Number(row.YSTZ) / 100 : null,
        turnaround: false,
        current: { display: ashareMoney(row.TOTAL_OPERATE_INCOME), value: row.TOTAL_OPERATE_INCOME }
      },
      netIncome: {
        growthPct: Number.isFinite(Number(row.SJLTZ)) ? Number(row.SJLTZ) / 100 : null,
        turnaround: false,
        current: { display: ashareMoney(row.PARENT_NETPROFIT), value: row.PARENT_NETPROFIT }
      },
      epsDiluted: { growthPct: null, turnaround: false, current: { display: row.BASIC_EPS ?? "" } },
      operatingCashFlow: {
        growthPct: Number.isFinite(cashFlowMetric.growthPct) ? cashFlowMetric.growthPct : null,
        turnaround: cashFlowMetric.turnaround || false,
        current: { display: cashFlowMetric.currentDisplay || (row.MGJYXJJE ?? ""), value: cashFlowMetric.current ?? null },
        prior: { display: cashFlowMetric.priorDisplay || "", value: cashFlowMetric.prior ?? null }
      },
      grossMargin: Number.isFinite(Number(row.XSMLL)) ? Number(row.XSMLL) / 100 : null,
      grossMarginDelta: null,
      operatingMargin: null,
      operatingMarginDelta: null
    }
  };
}

function resolveAshareRowQueries(rows, queries = []) {
  const matches = new Map();
  const missing = [];
  for (const query of queries) {
    const codeMatch = String(query).match(/\d{6}/);
    const code = codeMatch?.[0] || "";
    const normalizedQuery = normalizedSearchText(query);
    const match =
      (code ? rows.find((row) => String(row.SECURITY_CODE || "").slice(0, 6) === code) : null) ||
      rows.find((row) => normalizedSearchText(row.SECURITY_NAME_ABBR) === normalizedQuery) ||
      rows.find((row) => normalizedSearchText(row.SECURITY_NAME_ABBR).startsWith(normalizedQuery)) ||
      (normalizedQuery.length >= 2
        ? rows.find((row) => normalizedSearchText(row.SECURITY_NAME_ABBR).includes(normalizedQuery))
        : null);
    if (!match) {
      missing.push({
        query,
        reason: "指定公司未在当前报告期 A股财报记录中匹配到，可能尚未披露本期财报"
      });
      continue;
    }
    const symbol = String(match.SECURITY_CODE || "").slice(0, 6);
    const existing = matches.get(symbol) || { row: match, queries: [] };
    existing.queries = sourceSet(...existing.queries, query);
    matches.set(symbol, existing);
  }
  return { matches, missing };
}

async function getAshareRankings(force = false, options = parseRankingOptions()) {
  const startedAt = Date.now();
  const reportInfo = ashareReportInfo();
  const cacheName = `ashare-rankings-v${ASHARE_DATA_FILTER_VERSION}-${reportInfo.date}-${rankingOptionsFingerprint(options)}.json`;
  if (!force) {
    const cached = await readCache(cacheName, RANKING_TTL);
    if (cached) return { ...cached, cache: "hit" };
  }
  const rawRows = (
    await fetchEastmoneyPaged(
      "RPT_LICO_FN_CPD",
      {
        sortColumns: "NOTICE_DATE,SECURITY_CODE",
        sortTypes: "-1,1",
        filter: `(REPORTDATE='${reportInfo.date}')`
      },
      force
    )
  ).filter(isAshareRow);
  const deduped = new Map();
  for (const row of rawRows) {
    const key = `${ashareDate(row.NOTICE_DATE)}:${row.SECUCODE}`;
    const existing = deduped.get(key);
    if (!existing || String(row.REPORTDATE || "").localeCompare(String(existing.REPORTDATE || "")) > 0) {
      deduped.set(key, row);
    }
  }
  const rows = [...deduped.values()];
  const manualRows = resolveAshareRowQueries(rows, options.focusCompanyQueries);
  const quoteMap = await fetchAshareQuotes(rows.map((row) => row.SECUCODE), force);
  const cashFlowCurrentMap = options.includeCashFlow
    ? await fetchAshareCashFlowMap(reportInfo.date, force)
    : new Map();
  const cashFlowPriorMap = options.includeCashFlow
    ? await fetchAshareCashFlowMap(priorAshareReportDate(reportInfo.date), force)
    : new Map();
  const allRanked = rows
    .map((row) => {
      const code = String(row.SECURITY_CODE || "").slice(0, 6);
      const manual = manualRows.matches.get(code);
      return ashareRowToRanking(
        row,
        quoteMap.get(code),
        options,
        ashareCashFlowMetric(code, cashFlowCurrentMap, cashFlowPriorMap, row),
        {
          forced: Boolean(manual),
          manualQueries: manual?.queries || []
        }
      );
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.filing.filingDate).localeCompare(String(a.filing.filingDate));
    });
  const positive = allRanked.filter((row) => row.score > 0);
  const rankedMap = new Map();
  for (const row of positive.slice(0, options.analysisLimit)) rankedMap.set(row.symbol, row);
  for (const row of allRanked.filter((item) => item.forced)) rankedMap.set(row.symbol, row);
  const ranked = [...rankedMap.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.filing.filingDate).localeCompare(String(a.filing.filingDate));
  });
  const diagnostics = {
    version: 1,
    counts: {
      manualCompanyMissing: manualRows.missing.length,
      noPositiveScore: allRanked.length - positive.length,
      notEnrichedDueLimit: positive.filter((row) => !rankedMap.has(row.symbol) && !row.forced).length,
      marketDataMissing: rows.filter((row) => !quoteMap.has(String(row.SECURITY_CODE || "").slice(0, 6))).length,
      analysisCacheHits: 0,
      analysisCacheMisses: ranked.length
    },
    manualCompanyMissing: manualRows.missing,
    marketDataMissing: rows
      .filter((row) => !quoteMap.has(String(row.SECURITY_CODE || "").slice(0, 6)))
      .slice(0, 500)
      .map((row) => ({
        symbol: row.SECURITY_CODE,
        name: row.SECURITY_NAME_ABBR || row.SECURITY_CODE,
        filingDate: ashareDate(row.NOTICE_DATE),
        reportDate: ashareDate(row.REPORTDATE),
        reason: "东方财富估值数据未返回该公司，市值和行业可能缺失"
      })),
    noPositiveScore: allRanked
      .filter((row) => row.score <= 0)
      .slice(0, 500)
      .map((row) => ({
        symbol: row.symbol,
        name: row.name,
        filingDate: row.filing.filingDate,
        reportDate: row.filing.reportDate,
        reason: row.forced
          ? "指定公司已强制展示；有财报数据但未触发亮眼条件"
          : "有财报数据，但未触发营收/归母净利/ROE/毛利率/现金流亮眼条件"
      })),
    notEnrichedDueLimit: positive
      .filter((row) => !rankedMap.has(row.symbol) && !row.forced)
      .slice(0, 500)
      .map((row) => ({
        symbol: row.symbol,
        name: row.name,
        filingDate: row.filing.filingDate,
        reportDate: row.filing.reportDate,
        metricScore: row.score,
        reason: `超过本次分析数量 ${options.analysisLimit}，未展示在榜单中`
      }))
  };
  const payload = {
    market: "cn",
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range: { label: reportInfo.label, start: reportInfo.date, end: reportInfo.date, today: toDateOnly(new Date()) },
    reportingFrame: { label: reportInfo.label, frame: reportInfo.date },
    analysisOptions: {
      analysisLimit: options.analysisLimit,
      reuseAnalysis: options.reuseAnalysis,
      method: "东方财富业绩表现结构化数据 + 规则评分",
      usesLLM: false,
      includeCashFlow: options.includeCashFlow,
      cashFlowThresholdPct: options.cashFlowThresholdPct,
      customKeywordRules: options.customKeywordRules,
      focusCompanyQueries: options.focusCompanyQueries
    },
    source: {
      filings: "东方财富数据中心 RPT_LICO_FN_CPD",
      text: "当前 A股版本使用结构化指标与公司资料，不调用大模型",
      universe: "东方财富 A股财报数据"
    },
    totals: {
      configured: rows.length,
      scanned: rows.length,
      candidates: positive.length,
      analyzable: positive.length,
      selectedForAnalysis: ranked.length,
      enriched: ranked.length,
      ranked: ranked.length,
      forced: ranked.filter((row) => row.forced).length,
      diagnostics: diagnostics.counts
    },
    diagnostics,
    rows: ranked
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
}

async function getAshareCalendar(month, force = false) {
  const normalizedMonth = month || new Date().toISOString().slice(0, 7);
  const cacheName = `ashare-calendar-v${ASHARE_DATA_FILTER_VERSION}-${normalizedMonth}.json`;
  if (!force) {
    const cached = await readCache(cacheName, CALENDAR_TTL);
    if (cached) return { ...cached, cache: "hit" };
  }
  const startedAt = Date.now();
  const start = `${normalizedMonth}-01`;
  const [year, monthIndex] = normalizedMonth.split("-").map(Number);
  const end = toDateOnly(new Date(Date.UTC(year, monthIndex, 0)));
  const calendarRowsRaw = (
    await fetchEastmoneyPaged(
      "RPT_LICO_FN_CPD",
      {
        sortColumns: "NOTICE_DATE,SECURITY_CODE",
        sortTypes: "1,1",
        filter: `(NOTICE_DATE>='${start}')(NOTICE_DATE<='${end}')`
      },
      force
    )
  ).filter(isAshareRow);
  const calendarRowsByCompany = new Map();
  for (const row of calendarRowsRaw) {
    const key = `${ashareDate(row.NOTICE_DATE)}:${row.SECUCODE}`;
    const existing = calendarRowsByCompany.get(key);
    if (!existing || String(row.REPORTDATE || "").localeCompare(String(existing.REPORTDATE || "")) > 0) {
      calendarRowsByCompany.set(key, row);
    }
  }
  const rows = [...calendarRowsByCompany.values()];
  const quoteMap = await fetchAshareQuotes(rows.map((row) => row.SECUCODE), force);
  const byDate = {};
  for (const row of rows) {
    const date = ashareDate(row.NOTICE_DATE);
    const quote = quoteMap.get(row.SECURITY_CODE) || {};
    const secucode = row.SECUCODE;
    const event = {
      date,
      symbol: row.SECURITY_CODE,
      name: row.SECURITY_NAME_ABBR || quote.name || row.SECURITY_CODE,
      marketCap: ashareMarketCapDisplay(quote.marketCap),
      marketCapCurrency: "¥",
      time: "time-not-supplied",
      fiscalQuarterEnding: asharePeriodLabel(row.REPORTDATE),
      metricLabel: `EPS ${row.BASIC_EPS ?? "--"}`,
      epsForecast: row.BASIC_EPS ?? "",
      noOfEsts: "",
      lastYearRptDt: "",
      lastYearEPS: "",
      industry: quote.industry || row.BOARD_NAME || row.PUBLISHNAME || "",
      stockUrl: ashareStockUrl(secucode),
      nasdaqUrl: ashareReportUrl(secucode),
      calendarLabel: "财报页"
    };
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(event);
  }
  for (const events of Object.values(byDate)) {
    events.sort((a, b) => Number(String(b.marketCap).replace(/[^0-9.-]/g, "")) - Number(String(a.marketCap).replace(/[^0-9.-]/g, "")));
  }
  const totalEvents = Object.values(byDate).reduce((sum, events) => sum + events.length, 0);
  const payload = {
    market: "cn",
    month: normalizedMonth,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    source: "东方财富业绩表现公告日",
    totalEvents,
    byDate
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
}

async function fetchAshareCompanyProfile(symbol, force = false) {
  const code = normalizeTicker(symbol).slice(0, 6);
  const secucode =
    code.startsWith("6") ? `${code}.SH` : code.startsWith("8") || code.startsWith("9") ? `${code}.BJ` : `${code}.SZ`;
  const params = new URLSearchParams({
    pageNumber: "1",
    pageSize: "1",
    source: "HSF10",
    client: "PC",
    reportName: "RPT_F10_ORG_BASICINFO",
    columns: "ALL",
    filter: `(SECUCODE="${secucode}")`
  });
  const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?${params.toString()}`;
  const payload = await cachedEastmoneyJson(url, force, PROFILE_TTL);
  const data = payload?.result?.data?.[0] || {};
  const quoteMap = await fetchAshareQuotes([secucode], force);
  const quote = quoteMap.get(code) || {};
  return {
    symbol: code,
    name: data.SECURITY_NAME_ABBR || quote.name || code,
    chineseName: data.ORG_NAME || "",
    sector: data.EM2016 || "",
    industry: quote.industry || data.MAIN_BUSINESS || "",
    region: data.REGIONBK || "",
    marketCap: ashareMarketCapDisplay(quote.marketCap),
    businessDescription: normalizedDescription(
      [data.MAIN_BUSINESS ? `主营业务：${data.MAIN_BUSINESS}` : "", data.ORG_PROFIE || ""]
        .filter(Boolean)
        .join("。"),
      1800
    ),
    profileSource: "东方财富 F10 公司资料",
    status: data.SECURITY_CODE ? "ok" : "empty"
  };
}

async function getAshareCompanyProfiles(symbols, force = false) {
  const normalizedSymbols = [
    ...new Set(
      String(symbols || "")
        .split(/[,，\s]+/)
        .map((symbol) => symbol.trim().slice(0, 6))
        .filter(Boolean)
    )
  ].slice(0, 120);
  const rows = await mapLimit(normalizedSymbols, 5, (symbol) => fetchAshareCompanyProfile(symbol, force));
  const profiles = {};
  for (const row of rows) {
    if (row?.error) {
      profiles[row.item || ""] = { symbol: row.item || "", status: "error", businessDescription: "", error: row.error };
    } else if (row?.symbol) {
      profiles[row.symbol] = row;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    source: "东方财富 F10 公司资料",
    requested: normalizedSymbols.length,
    profiles
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream"
  );
}

async function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  if (filePath === "/ranking") filePath = "/index.html";
  if (filePath === "/calendar") filePath = "/calendar.html";
  if (filePath === "/ashare") filePath = "/ashare.html";
  if (filePath === "/ashare-calendar") filePath = "/ashare-calendar.html";
  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await fs.readFile(resolved);
    res.writeHead(200, {
      "Content-Type": contentType(resolved),
      "Cache-Control": "no-cache"
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function route(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (requestUrl.pathname === "/api/rankings") {
      const force = requestUrl.searchParams.get("force") === "1";
      const options = parseRankingOptions(requestUrl.searchParams);
      sendJson(res, 200, await getRankings(force, options));
      return;
    }
    if (requestUrl.pathname === "/api/ashare-rankings") {
      const force = requestUrl.searchParams.get("force") === "1";
      const options = parseRankingOptions(requestUrl.searchParams);
      sendJson(res, 200, await getAshareRankings(force, options));
      return;
    }
    if (requestUrl.pathname === "/api/calendar") {
      const force = requestUrl.searchParams.get("force") === "1";
      const month = requestUrl.searchParams.get("month");
      sendJson(res, 200, await getCalendar(month, force));
      return;
    }
    if (requestUrl.pathname === "/api/ashare-calendar") {
      const force = requestUrl.searchParams.get("force") === "1";
      const month = requestUrl.searchParams.get("month");
      sendJson(res, 200, await getAshareCalendar(month, force));
      return;
    }
    if (requestUrl.pathname === "/api/company-profiles") {
      const force = requestUrl.searchParams.get("force") === "1";
      const symbols = requestUrl.searchParams.get("symbols") || "";
      sendJson(res, 200, await getCompanyProfiles(symbols, force));
      return;
    }
    if (requestUrl.pathname === "/api/ashare-company-profiles") {
      const force = requestUrl.searchParams.get("force") === "1";
      const symbols = requestUrl.searchParams.get("symbols") || "";
      sendJson(res, 200, await getAshareCompanyProfiles(symbols, force));
      return;
    }
    if (requestUrl.pathname === "/api/translate") {
      const force = requestUrl.searchParams.get("force") === "1";
      const text = requestUrl.searchParams.get("text") || "";
      sendJson(res, 200, await getChineseTranslation(text, force));
      return;
    }
    if (requestUrl.pathname === "/api/status") {
      const universe = await loadUniverse();
      sendJson(res, 200, {
        ok: true,
        port: PORT,
        universeSize: universe.symbols.length,
        secUserAgent: SEC_USER_AGENT,
        now: new Date().toISOString()
      });
      return;
    }
    await serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    sendJson(res, 500, {
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
}

const server = http.createServer(route);
server.listen(PORT, () => {
  console.log(`Earnings radar running at http://localhost:${PORT}`);
});

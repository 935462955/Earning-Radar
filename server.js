const http = require("node:http");
const path = require("node:path");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const { PDFParse } = require("pdf-parse");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const CACHE_DIR = path.join(ROOT, ".cache");
const AI_CONFIG = readAiConfig();
const ANALYSIS_CONTEXT = readAnalysisContextConfig();
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
const LLM_ANALYSIS_TTL = 7 * DAY;
const ANALYSIS_CACHE_TTL = Number(process.env.ANALYSIS_CACHE_TTL_DAYS || 3650) * DAY;
const RELEASE_CANDIDATE_CACHE_TTL = Number(process.env.RELEASE_CANDIDATE_CACHE_TTL_DAYS || 3650) * DAY;
const NEXT_EARNINGS_TTL = 6 * 60 * 60 * 1000;
const WEB_CONTEXT_TTL = 12 * 60 * 60 * 1000;
const NEXT_EARNINGS_LOOKAHEAD_DAYS = Number(process.env.NEXT_EARNINGS_LOOKAHEAD_DAYS || 90);
const EARNINGS_RELEASE_LOOKBACK_DAYS = Number(process.env.EARNINGS_RELEASE_LOOKBACK_DAYS || 10);
const SEC_REQUEST_DELAY_MS = Number(process.env.SEC_REQUEST_DELAY_MS || 140);
const TEXT_SCAN_MIN_SCORE = Number(process.env.TEXT_SCAN_MIN_SCORE || 20);
const NET_INCOME_TURNAROUND_MIN_VALUE = Number(process.env.NET_INCOME_TURNAROUND_MIN_VALUE || 1000000);
const NET_INCOME_TURNAROUND_MIN_MARGIN = Number(process.env.NET_INCOME_TURNAROUND_MIN_MARGIN || 0.03);
const WEB_CONTEXT_RESULTS_LIMIT = Number(process.env.WEB_CONTEXT_RESULTS_LIMIT || 6);
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 100);
const RANKING_DIAGNOSTICS_VERSION = 18;
const RELEASE_CANDIDATE_CACHE_VERSION = 2;
const SIGNAL_PATTERN_VERSION = 5;
const ASHARE_DATA_FILTER_VERSION = 3;
const ASHARE_CALENDAR_VERSION = 3;
const OPENAI_SETTINGS = AI_CONFIG.openai || {};
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || OPENAI_SETTINGS.apiKey || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || OPENAI_SETTINGS.model || "gpt-4.1-mini";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || OPENAI_SETTINGS.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || OPENAI_SETTINGS.timeoutMs || 60000);
const CODEX_SETTINGS = AI_CONFIG.codex || {};
const ANALYSIS_PROVIDER = String(
  process.env.AI_ANALYSIS_PROVIDER || AI_CONFIG.analysisProvider || (OPENAI_API_KEY ? "openai" : "codex")
).toLowerCase();
const CODEX_COMMAND = process.env.CODEX_COMMAND || CODEX_SETTINGS.command || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || CODEX_SETTINGS.model || "";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || CODEX_SETTINGS.timeoutMs || 180000);
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || CODEX_SETTINGS.sandbox || "read-only";

const RESULT_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F"]);
const EARNINGS_RELEASE_FORMS = new Set(["8-K", "6-K"]);
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

const COMPANY_QUERY_ALIASES = new Map([
  ["美光", "MU"],
  ["美光科技", "MU"],
  ["英伟达", "NVDA"],
  ["辉达", "NVDA"],
  ["苹果", "AAPL"],
  ["微软", "MSFT"],
  ["特斯拉", "TSLA"],
  ["谷歌", "GOOGL"],
  ["亚马逊", "AMZN"],
  ["脸书", "META"],
  ["Meta", "META"],
  ["博通", "AVGO"],
  ["超威", "AMD"],
  ["台积电", "TSM"]
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
    label: "Net income attributable to parent",
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
      /demand\s+(?:continues\s+to\s+)?(?:exceeds|exceeded|outpaces|outpaced|exceeding|outpacing)\s+(?:our\s+)?supply/gi,
      /demand(?:\s+\w+){0,10}\s+(?:exceeds|exceeded|outpaces|outpaced|exceeding|outpacing)(?:\s+\w+){0,12}\s+supply(?:\s+growth)?/gi,
      /demand[^.。；;]{0,140}(?:exceeds|exceeded|outpaces|outpaced|exceeding|outpacing|outstrips|outstripped)[^.。；;]{0,80}supply(?:\s+growth)?/gi,
      /growth[^.。；;]{0,120}(?:exceeds|exceeded|exceeding|outpaces|outpaced|outpacing)[^.。；;]{0,60}(?:our\s+)?supply\s+growth/gi,
      /market\s+demand(?:\s+\w+){0,4}\s+exceed(?:s|ed|ing)?(?:\s+\w+){0,4}\s+industry\s+supply/gi,
      /unable\s+to\s+meet\s+(?:customer\s+)?demand/gi,
      /supply\s+constrained|capacity\s+constrained/gi,
      /sold\s+out|oversubscribed/gi,
      /供不应求|需求(?:持续)?超过(?:行业)?供给|供给(?:无法|不能)满足需求/gi,
      /(?:产能|供应|供给)(?:不足|受限|瓶颈)|供需(?:趋紧|偏紧|紧张)/gi
    ]
  },
  {
    label: "行业高景气度上行",
    score: 14,
    patterns: [
      /industry\s+(?:upcycle|tailwinds?|momentum)/gi,
      /favorable\s+(?:industry|market)\s+conditions/gi,
      /robust\s+(?:industry|market)\s+demand/gi,
      /secular\s+growth\s+(?:trend|opportunit(?:y|ies))/gi,
      /行业(?:进入|处于|维持|保持)?(?:新一轮)?景气(?:周期)?(?:上行|上升|向上|高景气)/gi,
      /行业上行(?:周期|机遇)|存储行业景气度上行|市场呈现(?:出)?(?:高景气|景气度上行)/gi,
      /受益于[^。；;]{0,80}行业[^。；;]{0,40}(?:高景气|上行|景气周期)/gi
    ]
  },
  {
    label: "市场超预期拓展",
    score: 14,
    patterns: [
      /(?:market|customer)\s+(?:adoption|expansion)\s+(?:has\s+)?(?:exceeded|outpaced)\s+(?:our\s+)?expectations/gi,
      /better\s+than\s+expected\s+(?:demand|adoption|growth)/gi,
      /expanded\s+(?:into|across)\s+new\s+markets/gi,
      /accelerated\s+(?:customer\s+)?adoption/gi,
      /市场(?:与业务)?(?:成长突破|拓展|开拓)|大力拓展(?:全球)?(?:头部)?客户/gi,
      /(?:客户|市场)(?:导入|拓展)[^。；;]{0,80}(?:突破|增长|提升)/gi,
      /进入(?:了)?全球[^。；;]{0,50}供应链体系|市场份额(?:同比)?(?:有所)?(?:提升|增长)/gi
    ]
  },
  {
    label: "新品上市持续超预期",
    score: 14,
    patterns: [
      /new\s+product\s+(?:launch|ramp|introduction)[^.]{0,120}(?:exceeded|ahead\s+of|better\s+than)\s+(?:our\s+)?expectations/gi,
      /(?:launch|ramp)\s+(?:continues\s+to\s+)?(?:exceed|outperform)\s+(?:our\s+)?expectations/gi,
      /strong\s+(?:initial\s+)?demand\s+for\s+(?:our\s+)?new\s+products?/gi,
      /(?:新品|新产品|新兴[^。；;]{0,12}产品)[^。；;]{0,80}(?:放量|导入|量产|爬坡|增长|突破)/gi,
      /AI[^。；;]{0,20}(?:新品|新产品|新兴[^。；;]{0,12}产品)[^。；;]{0,80}(?:收入|放量|增长)/gi
    ]
  },
  {
    label: "产品价格中枢持续上涨",
    score: 14,
    patterns: [
      /higher\s+(?:average\s+)?selling\s+prices?/gi,
      /average\s+selling\s+price(?:s|\s+\(asp\))?\s+(?:increased|rose|expanded)/gi,
      /\bASP\b\s+(?:increased|rose|expanded)/gi,
      /\b(?:implemented|realized|benefited\s+from)\s+price\s+increases?\b/gi,
      /\bpricing\s+(?:improved|increased|expanded|strength|power)\b|\bfavorable\s+pricing\b/gi,
      /产品价格(?:持续)?(?:上涨|普涨|提升)|价格(?:持续)?(?:大幅)?上涨/gi,
      /销售价格[^。；;]{0,30}(?:增加|上涨|提升)|产品单价[^。；;]{0,30}(?:提升|上涨)|均价[^。；;]{0,30}(?:提升|上涨)/gi,
      /全面调价|全面价格调整|价格调整[^。；;]{0,50}(?:收入|毛利率|盈利)/gi
    ]
  },
  {
    label: "供给偏紧",
    score: 14,
    patterns: [
      /supply\s+(?:remains|remained|is)\s+tight/gi,
      /tight\s+supply|limited\s+supply/gi,
      /inventory\s+(?:remains|remained|is)\s+(?:lean|low)/gi,
      /constraints?\s+on\s+(?:supply|capacity|production)/gi,
      /供需(?:趋紧|偏紧|紧张)|供应(?:偏紧|紧张|受限)|供给(?:偏紧|紧张|受限)/gi,
      /锁定[^。；;]{0,40}供应链|核心供应链资源|产能(?:紧张|受限|瓶颈)/gi,
      /为保障销售订单交付进行备货|预收客户[^。；;]{0,30}货款/gi
    ]
  },
  {
    label: "需求旺盛",
    score: 14,
    patterns: [
      /strong\s+(?:customer\s+)?demand/gi,
      /strong\s+(?:industry\s+)?demand\s+growth/gi,
      /rapidly\s+growing\s+(?:customer\s+)?demand/gi,
      /customers?[^.。；;]{0,100}rapidly\s+growing\s+demand/gi,
      /accelerated\s+demand\s+for/gi,
      /demand\s+growth\s+(?:accelerated|accelerates|accelerating)/gi,
      /increasing\s+demand\s+for|continued\s+strong\s+demand\s+for/gi,
      /robust\s+(?:customer\s+)?demand/gi,
      /demand\s+(?:remains|remained|is)\s+(?:strong|robust|healthy)/gi,
      /record\s+(?:orders|bookings|backlog)/gi,
      /市场需求(?:旺盛|强劲|稳步增长|持续攀升)|需求(?:爆发|旺盛|强劲|持续攀升)/gi,
      /算力需求[^。；;]{0,40}(?:持续攀升|强劲)|AI[^。；;]{0,30}需求[^。；;]{0,40}(?:爆发|驱动|增长)/gi,
      /终端客户[^。；;]{0,40}强劲投入|订单(?:饱满|充足|持续增长)|出货(?:持续)?增长/gi
    ]
  }
];

function isLikelyNegativeSignal(label, phrase, context) {
  const text = `${phrase} ${context}`.toLowerCase();
  if (label === "产品价格中枢持续上涨") {
    return (
      /\bunfavorable pricing\b/i.test(text) ||
      /not be able to fully offset[^.。；;]{0,120}price increases?/i.test(text) ||
      /energy price increases? or shortages?/i.test(text) ||
      /tariffs?[^.。；;]{0,120}price increases?/i.test(text) ||
      /costs?[^.。；;]{0,80}inflationary[^.。；;]{0,120}price increases?/i.test(text)
    );
  }
  if (label === "行业高景气度上行") {
    return /unfavorable market conditions|adverse market conditions|market risk/i.test(text);
  }
  return false;
}

let secQueue = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashKey(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function readAiConfig() {
  const candidates = [
    process.env.AI_CONFIG_FILE,
    path.join(ROOT, "config", "ai.local.json")
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fsSync.existsSync(file)) continue;
      const body = fsSync.readFileSync(file, "utf8");
      return JSON.parse(body);
    } catch (error) {
      console.warn(`Failed to read AI config ${file}: ${error.message}`);
      return {};
    }
  }
  return {};
}

function readAnalysisContextConfig() {
  const candidates = [
    process.env.ANALYSIS_CONTEXT_FILE,
    path.join(ROOT, "config", "analysis-context.local.json"),
    path.join(ROOT, "config", "analysis-context.json")
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fsSync.existsSync(file)) continue;
      const body = fsSync.readFileSync(file, "utf8");
      return JSON.parse(body);
    } catch (error) {
      console.warn(`Failed to read analysis context ${file}: ${error.message}`);
      return {};
    }
  }
  return {};
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
  const ticket = secQueue.then(async () => {
    await delay(SEC_REQUEST_DELAY_MS);
  });
  secQueue = ticket.catch(() => undefined);
  await ticket;
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

async function cachedPublicText(url, force = false, ttl = WEB_CONTEXT_TTL, headers = {}) {
  const name = `public-text-${hashKey(url)}.json`;
  if (!force) {
    const cached = await readCache(name, ttl);
    if (cached?.text) return cached.text;
  }
  const response = await fetchWithTimeout(url, {
    timeoutMs: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 earnings-radar/0.1",
      Accept: "text/html,text/plain,application/xhtml+xml,*/*",
      ...headers
    }
  });
  const text = await response.text();
  await writeCache(name, { text, url, fetchedAt: new Date().toISOString() });
  return text;
}

function decodeHtmlEntities(value = "") {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function textFromHtmlFragment(value = "") {
  return decodeHtmlEntities(String(value).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseFredCsv(text, seriesId, label) {
  const lines = String(text || "").trim().split(/\r?\n/);
  if (!/^observation_date,/i.test(lines[0] || "")) return null;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const [date, rawValue] = lines[index].split(",");
    const value = Number(rawValue);
    if (!date || !Number.isFinite(value)) continue;
    return {
      id: seriesId,
      label,
      date,
      value,
      display: `${value}`,
      source: "FRED"
    };
  }
  return null;
}

async function fetchFredSeries(seriesId, label, force = false) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const text = await cachedPublicText(url, force, WEB_CONTEXT_TTL, {
    Accept: "text/csv,text/plain,*/*"
  });
  const parsed = parseFredCsv(text, seriesId, label);
  if (!parsed) throw new Error(`FRED ${seriesId} 返回内容不可解析`);
  return { ...parsed, url };
}

function duckDuckGoTargetUrl(href) {
  const decoded = decodeHtmlEntities(href).replace(/^\/\//, "https://");
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.href;
  } catch {
    return decoded;
  }
}

function parseDuckDuckGoLiteResults(html, limit = WEB_CONTEXT_RESULTS_LIMIT) {
  const results = [];
  const linkPattern = /<a\b([^>]*\bclass=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) && results.length < limit) {
    const href = match[1].match(/\bhref=['"]([^'"]+)['"]/i)?.[1] || "";
    const start = linkPattern.lastIndex;
    const next = html.slice(start).search(/<a[^>]+class=['"]result-link['"]/i);
    const block = next >= 0 ? html.slice(start, start + next) : html.slice(start, start + 1600);
    const snippetMatch = block.match(/<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
    const title = textFromHtmlFragment(match[2]);
    const snippet = textFromHtmlFragment(snippetMatch?.[1] || "");
    const url = duckDuckGoTargetUrl(href);
    if (!title || !url) continue;
    results.push({
      title,
      url,
      snippet,
      source: "DuckDuckGo Lite"
    });
  }
  return results;
}

async function fetchWebSearchResults(query, force = false, limit = WEB_CONTEXT_RESULTS_LIMIT) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const html = await cachedPublicText(url, force, WEB_CONTEXT_TTL, {
    Accept: "text/html,application/xhtml+xml,*/*"
  });
  return {
    query,
    url,
    results: parseDuckDuckGoLiteResults(html, limit)
  };
}

function flattenWebSearchResults(searches = []) {
  const webResults = [];
  const failures = [];
  for (const item of searches || []) {
    const query = item?.query || item?.item || "";
    if (item?.error) {
      failures.push({ query, reason: item.error });
      continue;
    }
    const results = Array.isArray(item?.results) ? item.results : [];
    if (!Array.isArray(item?.results)) {
      failures.push({ query, reason: "搜索结果结构缺少 results 数组" });
    }
    for (const result of results) {
      webResults.push({ ...result, query });
    }
  }
  return {
    webResults: webResults.slice(0, WEB_CONTEXT_RESULTS_LIMIT),
    failures
  };
}

async function cachedPdfText(url, force = false, ttl = TEXT_TTL) {
  const name = `pdf-text-${hashKey(url)}.json`;
  if (!force) {
    const cached = await readCache(name, ttl);
    if (cached?.text) return cached.text;
  }
  const response = await fetchWithTimeout(url, {
    timeoutMs: 60000,
    headers: {
      "User-Agent": SEC_USER_AGENT,
      Accept: "application/pdf,*/*"
    }
  });
  const data = new Uint8Array(await response.arrayBuffer());
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ first: 1, last: 45 });
    const text = normalizeSignalText(result.text || "");
    await writeCache(name, {
      text,
      url,
      pages: result.total || null,
      fetchedAt: new Date().toISOString()
    });
    return text;
  } finally {
    await parser.destroy?.();
  }
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

async function cachedEastmoneyJsonWithStats(url, force = false, ttl = CALENDAR_TTL) {
  const name = `eastmoney-json-${hashKey(url)}.json`;
  if (!force) {
    const cached = await readCache(name, ttl);
    if (cached) return { payload: cached, apiCalls: 0, cache: "hit" };
  }
  const payload = await fetchEastmoneyJson(url);
  await writeCache(name, payload);
  return { payload, apiCalls: 1, cache: "fresh" };
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

function eastmoneyAnnouncementUrl(params = {}) {
  const query = new URLSearchParams({
    sr: "-1",
    page_size: "100",
    page_index: "1",
    ann_type: "A",
    client_source: "web",
    f_node: "0",
    s_node: "0",
    ...params
  });
  return `https://np-anotice-stock.eastmoney.com/api/security/ann?${query.toString()}`;
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

async function fetchEastmoneyPagedWithStats(reportName, params = {}, force = false, ttl = CALENDAR_TTL) {
  const pageSize = Number(params.pageSize || 500);
  const firstUrl = eastmoneyDataUrl(reportName, { ...params, pageNumber: "1", pageSize });
  const firstResult = await cachedEastmoneyJsonWithStats(firstUrl, force, ttl);
  const result = firstResult.payload?.result || {};
  const rows = [...(result.data || [])];
  const pages = Math.min(Number(result.pages || 1), 50);
  let apiCalls = firstResult.apiCalls;
  if (pages <= 1) return { rows, pages, apiCalls };
  const rest = await mapLimit(
    Array.from({ length: pages - 1 }, (_, index) => index + 2),
    4,
    async (pageNumber) => {
      const url = eastmoneyDataUrl(reportName, { ...params, pageNumber, pageSize });
      return cachedEastmoneyJsonWithStats(url, force, ttl);
    }
  );
  for (const page of rest) {
    if (page?.error) continue;
    apiCalls += page.apiCalls || 0;
    rows.push(...(page.payload?.result?.data || []));
  }
  return { rows, pages, apiCalls };
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
    const looksLikeTickerList = tokens.length > 1 && tokens.every((token) => /^[A-Z0-9._-]{1,8}$/.test(token));
    if (looksLikeTickerList) {
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

function usStockSymbol(ticker) {
  return normalizeTicker(String(ticker || "")).replace(/[^A-Z0-9.-]/g, "");
}

function eastmoneyUsStockUrl(ticker) {
  return `https://quote.eastmoney.com/us/${encodeURIComponent(usStockSymbol(ticker))}.html`;
}

function xueqiuUsStockUrl(ticker) {
  return `https://xueqiu.com/S/${encodeURIComponent(usStockSymbol(ticker))}`;
}

function sinaUsStockUrl(ticker) {
  return `https://stock.finance.sina.com.cn/usstock/quotes/${encodeURIComponent(usStockSymbol(ticker))}.html`;
}

function usStockLinks(ticker) {
  return [
    { label: "东财", url: eastmoneyUsStockUrl(ticker) },
    { label: "雪球", url: xueqiuUsStockUrl(ticker) },
    { label: "新浪", url: sinaUsStockUrl(ticker) }
  ];
}

function stockUrl(ticker) {
  return eastmoneyUsStockUrl(ticker);
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
    const aliasTicker =
      COMPANY_QUERY_ALIASES.get(query.trim()) ||
      COMPANY_QUERY_ALIASES.get(normalizedSearchText(query));
    const normalizedTickerQuery = normalizeTicker(aliasTicker || query);
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
  if (metric.growth.turnaround && !metric.growth.turnaroundSuppressed) {
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

function suppressImmaterialNetIncomeTurnaround(metrics) {
  const netIncome = metrics.netIncome;
  if (!netIncome?.growth?.turnaround || netIncome.growth.turnaroundSuppressed) return;

  const currentNetIncome = Number(netIncome.current?.val);
  if (!Number.isFinite(currentNetIncome) || currentNetIncome <= 0) return;

  const currentRevenue = Number(metrics.revenue?.current?.val);
  const netMargin =
    Number.isFinite(currentRevenue) && Math.abs(currentRevenue) >= 1
      ? currentNetIncome / Math.abs(currentRevenue)
      : null;
  const hasMaterialValue = currentNetIncome >= NET_INCOME_TURNAROUND_MIN_VALUE;
  const hasMaterialMargin =
    Number.isFinite(netMargin) && netMargin >= NET_INCOME_TURNAROUND_MIN_MARGIN;

  if (!hasMaterialValue && !hasMaterialMargin) {
    netIncome.growth.turnaroundSuppressed = true;
    netIncome.growth.turnaroundReason = `归母净利润为正但金额低于 ${formatNumber(NET_INCOME_TURNAROUND_MIN_VALUE)}，且归母净利率低于 ${(
      NET_INCOME_TURNAROUND_MIN_MARGIN * 100
    ).toFixed(1)}%`;
  }
}

function scoreMetrics(metrics, options = {}) {
  suppressImmaterialNetIncomeTurnaround(metrics);
  const state = { score: 0, reasons: [] };
  addGrowthScore(state, "营收", metrics.revenue, {
    steps: [
      [1, 40, "同比翻倍"],
      [0.5, 32, "同比>50%"],
      [0.25, 22, "同比>25%"],
      [0.1, 10, "同比>10%"]
    ]
  });
  addGrowthScore(state, "归母净利", metrics.netIncome, {
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

function normalizeSignalText(text) {
  return String(text || "")
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function customSignalPatterns(customKeywordRules = []) {
  return customKeywordRules.map((rule) => ({
    label: `自定义：${rule.label}`,
    score: 8,
    patterns: rule.terms.map((term) => new RegExp(escapeRegExp(term), "gi"))
  }));
}

function findSignals(text, doc, customKeywordRules = []) {
  const normalizedText = normalizeSignalText(text);
  const hits = [];
  for (const signal of [...SIGNAL_PATTERNS, ...customSignalPatterns(customKeywordRules)]) {
    const signalHits = [];
    for (const pattern of signal.patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(normalizedText)) && signalHits.length < 2) {
        const context = contextAround(normalizedText, match.index, match[0].length);
        if (isLikelyNegativeSignal(signal.label, match[0], context)) continue;
        signalHits.push({
          label: signal.label,
          phrase: match[0],
          context,
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
  const netIncomeTurnaround =
    metrics.netIncome.growth.turnaround && !metrics.netIncome.growth.turnaroundSuppressed;
  return (
    metricScore.score >= TEXT_SCAN_MIN_SCORE ||
    netIncomeTurnaround ||
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
    turnaround: metric.growth.turnaround && !metric.growth.turnaroundSuppressed,
    turnaroundSuppressed: Boolean(metric.growth.turnaroundSuppressed),
    turnaroundReason: metric.growth.turnaroundReason || ""
  };
}

function monthNameToNumber(month) {
  const key = String(month || "").slice(0, 3).toLowerCase();
  return {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12"
  }[key] || "";
}

function parseUsLongDate(text) {
  const match = String(text || "").match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})\b/i);
  if (!match) return "";
  const month = monthNameToNumber(match[1]);
  if (!month) return "";
  return `${match[3]}-${month}-${String(match[2]).padStart(2, "0")}`;
}

function addYearsToDateString(date, years) {
  const parsed = parseDate(date);
  if (!parsed) return "";
  parsed.setUTCFullYear(parsed.getUTCFullYear() + years);
  return toDateOnly(parsed);
}

function rowNumberTokenToValue(token, scale = 1) {
  const raw = String(token || "").trim();
  if (!raw || raw === "--" || raw === "—") return null;
  const negative = raw.startsWith("(") && raw.endsWith(")");
  const number = Number(raw.replace(/[,$()%]/g, ""));
  if (!Number.isFinite(number)) return null;
  return (negative ? -number : number) * scale;
}

function numericValuesFromRow(rowText) {
  const values = [];
  const pattern = /\(?\$?\d[\d,]*(?:\.\d+)?\)?/g;
  let match;
  while ((match = pattern.exec(rowText)) && values.length < 12) {
    const value = rowNumberTokenToValue(match[0]);
    if (value == null) continue;
    values.push(value);
  }
  return values;
}

function htmlTableRows(html) {
  return [...String(html || "").matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((match) => textFromHtmlFragment(match[0]))
    .map((row) => row.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function findFinancialRow(rows, labelPattern) {
  return rows.find((row) => labelPattern.test(row)) || "";
}

function releaseFact(value, filing, reportDate, concept) {
  if (!Number.isFinite(value)) return null;
  return {
    val: value,
    start: "",
    end: reportDate || filing.reportDate || "",
    filed: filing.filingDate || "",
    form: filing.form || "8-K",
    accn: filing.accessionNumber || "",
    frame: "earnings-release",
    concept
  };
}

function releaseMetricFromValues(values, filing, reportDate, priorReportDate, concept, scale = 1000000) {
  if (!values.length) {
    return { concept, current: null, prior: null, growth: { pct: null, turnaround: false } };
  }
  const current = releaseFact(values[0] * scale, filing, reportDate, concept);
  const prior = values.length >= 3
    ? releaseFact(values[2] * scale, filing, priorReportDate, concept)
    : null;
  return {
    concept,
    current,
    prior,
    growth: growth(current, prior)
  };
}

function releaseMetricFromBillionMention(text, pattern, filing, reportDate, priorReportDate, concept) {
  const match = String(text || "").match(pattern);
  if (!match) {
    return { concept, current: null, prior: null, growth: { pct: null, turnaround: false } };
  }
  const current = releaseFact(rowNumberTokenToValue(match[1], 1000000000), filing, reportDate, concept);
  const prior = match[3]
    ? releaseFact(rowNumberTokenToValue(match[3], 1000000000), filing, priorReportDate, concept)
    : null;
  return {
    concept,
    current,
    prior,
    growth: growth(current, prior)
  };
}

function extractEarningsReleaseMetricsFromHtml(html, filing) {
  const plain = textFromHtmlFragment(html);
  if (!/results for|financial results|quarterly financial results|reports record results|revenue of \$/i.test(plain)) {
    return null;
  }
  const reportDate =
    parseUsLongDate(plain.match(/quarter[^.]{0,120}?ended\s+([A-Z][a-z]+\s+\d{1,2},\s*20\d{2})/i)?.[1]) ||
    filing.reportDate ||
    filing.filingDate ||
    "";
  const priorReportDate = addYearsToDateString(reportDate, -1);
  const rows = htmlTableRows(html);
  const revenueRow = findFinancialRow(rows, /^Revenue\b/i);
  const grossProfitRow = findFinancialRow(rows, /^Gross margin\b/i);
  const operatingIncomeRow = findFinancialRow(rows, /^Operating income\b/i);
  const netIncomeRow = findFinancialRow(rows, /^Net income\b/i);
  const epsRow = findFinancialRow(rows, /^Diluted (?:earnings|income) per share\b/i);
  const cashFlowMetric = releaseMetricFromBillionMention(
    plain,
    /Operating cash flow of \$([\d,.]+)\s*billion(?:\s+versus\s+\$([\d,.]+)\s*billion[^.]{0,160}?\$([\d,.]+)\s*billion)?/i,
    filing,
    reportDate,
    priorReportDate,
    "EarningsReleaseOperatingCashFlow"
  );
  const rawMetrics = {
    revenue: releaseMetricFromValues(numericValuesFromRow(revenueRow), filing, reportDate, priorReportDate, "EarningsReleaseRevenue"),
    netIncome: releaseMetricFromValues(numericValuesFromRow(netIncomeRow), filing, reportDate, priorReportDate, "EarningsReleaseNetIncome"),
    grossProfit: releaseMetricFromValues(numericValuesFromRow(grossProfitRow), filing, reportDate, priorReportDate, "EarningsReleaseGrossProfit"),
    operatingIncome: releaseMetricFromValues(numericValuesFromRow(operatingIncomeRow), filing, reportDate, priorReportDate, "EarningsReleaseOperatingIncome"),
    operatingCashFlow: cashFlowMetric,
    epsDiluted: releaseMetricFromValues(numericValuesFromRow(epsRow), filing, reportDate, priorReportDate, "EarningsReleaseDilutedEPS", 1)
  };
  const hasCoreMetrics = rawMetrics.revenue.current || rawMetrics.netIncome.current;
  if (!hasCoreMetrics) return null;
  const grossMargin = margin(rawMetrics.grossProfit.current, rawMetrics.revenue.current);
  const grossMarginPrior = margin(rawMetrics.grossProfit.prior, rawMetrics.revenue.prior);
  const operatingMargin = margin(rawMetrics.operatingIncome.current, rawMetrics.revenue.current);
  const operatingMarginPrior = margin(rawMetrics.operatingIncome.prior, rawMetrics.revenue.prior);
  return {
    rawMetrics: {
      ...rawMetrics,
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
    },
    reportDate,
    priorReportDate
  };
}

function releaseExhibitUrls(cik, filing, html) {
  const urls = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtmlEntities(match[1]);
    const label = textFromHtmlFragment(match[2]);
    if (!/(ex-?99|ex991|pressrelease|press-release|earnings|results)/i.test(`${href} ${label}`)) continue;
    const url = secFilingUrl(cik, filing.accessionNumber, href);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls.slice(0, 3);
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

function latestEarningsReleaseFilings(filings, range) {
  return filings
    .filter((filing) => EARNINGS_RELEASE_FORMS.has(filing.form))
    .filter((filing) => inDateRange(filing.filingDate, range.start, range.today))
    .slice(0, 6);
}

async function parseEarningsReleaseFiling(cik, filing, force = false) {
  if (!filing?.primaryDocument || !filing?.accessionNumber) return null;
  const primaryUrl = secFilingUrl(cik, filing.accessionNumber, filing.primaryDocument);
  const primaryHtml = await cachedSecText(primaryUrl, force, TEXT_TTL);
  const urls = [primaryUrl, ...releaseExhibitUrls(cik, filing, primaryHtml)];
  const seen = new Set();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const html = url === primaryUrl ? primaryHtml : await cachedSecText(url, force, TEXT_TTL);
    const parsed = extractEarningsReleaseMetricsFromHtml(html, filing);
    if (!parsed) continue;
    const primaryDocument = decodeURIComponent(url.split("/").pop() || filing.primaryDocument);
    return {
      ...parsed,
      filing: {
        ...filing,
        primaryDocument,
        reportDate: parsed.reportDate || filing.reportDate,
        sourcePrimaryDocument: filing.primaryDocument,
        sourceUrl: url
      }
    };
  }
  return null;
}

function latestFormalFilingAfter(filings = [], releaseFiling, range) {
  if (!releaseFiling?.filingDate) return null;
  return (
    filings
      .filter((filing) => RESULT_FORMS.has(filing.form))
      .filter((filing) => inDateRange(filing.filingDate, range.start, range.today))
      .filter((filing) => String(filing.filingDate || "") >= String(releaseFiling.filingDate || ""))
      .filter((filing) => filing.primaryDocument && filing.accessionNumber)
      .sort((a, b) => String(b.filingDate || "").localeCompare(String(a.filingDate || "")))[0] || null
  );
}

function releaseCandidateCacheName(symbol, range, releaseFilings = [], formalFiling = null) {
  const signature = hashKey(
    JSON.stringify({
      releaseAccessions: releaseFilings.slice(0, 6).map((filing) => ({
        accessionNumber: filing.accessionNumber,
        filingDate: filing.filingDate,
        primaryDocument: filing.primaryDocument
      })),
      formalFiling: formalFiling
        ? {
            accessionNumber: formalFiling.accessionNumber,
            filingDate: formalFiling.filingDate,
            primaryDocument: formalFiling.primaryDocument
          }
        : null
    })
  );
  return `release-candidate-v${RELEASE_CANDIDATE_CACHE_VERSION}-${range.start}-${range.end}-${normalizeTicker(symbol)}-${signature}.json`;
}

function hydrateEarningsReleaseCandidate(cached, universeItem, company, options) {
  if (!cached?.rawMetrics || !cached?.filing) return null;
  const metricScore = scoreMetrics(cached.rawMetrics, options);
  if (metricScore.score <= 0 && !universeItem?.forced) return null;
  return {
    symbol: universeItem.symbol,
    company,
    cik: company.cik,
    sources: sourceSet(...(universeItem.sources || []), "earnings-release"),
    calendarDates: universeItem.calendarDates || [],
    forced: universeItem.forced || false,
    manualQueries: universeItem.manualQueries || [],
    rawMetrics: cached.rawMetrics,
    metricScore,
    accessions: cached.accessions || [cached.filing.accessionNumber].filter(Boolean),
    filings: [],
    filing: cached.filing,
    submissionsName: cached.submissionsName || company.name,
    releaseSource: cached.releaseSource || "SEC 8-K/6-K earnings release",
    releaseFiling: cached.releaseFiling || null,
    releaseCache: "hit"
  };
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
    stockLinks: usStockLinks(symbol),
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
  const filing =
    candidate.filing?.accessionNumber && inDateRange(candidate.filing.filingDate, range.start, range.today)
      ? candidate.filing
      : findFilingForAccessions(filings, candidate.accessions, range);
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

async function buildEarningsReleaseCandidate(universeItem, company, range, force, options) {
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPad(company.cik)}.json`;
  const submissions = await cachedSecJson(submissionsUrl, force);
  const filings = zipFilings(submissions.filings?.recent);
  const releaseFilings = latestEarningsReleaseFilings(filings, range);
  const latestFormalFiling = latestFormalFilingAfter(filings, releaseFilings[0], range);
  const cacheName = releaseCandidateCacheName(universeItem.symbol, range, releaseFilings, latestFormalFiling);
  if (options.reuseAnalysis) {
    const cached = await readCache(cacheName, RELEASE_CANDIDATE_CACHE_TTL);
    const candidate = hydrateEarningsReleaseCandidate(cached, universeItem, company, options);
    if (candidate) return candidate;
  }
  for (const filing of releaseFilings) {
    const parsed = await parseEarningsReleaseFiling(company.cik, filing, force);
    if (!parsed?.rawMetrics) continue;
    const metricScore = scoreMetrics(parsed.rawMetrics, options);
    if (metricScore.score <= 0 && !universeItem?.forced) continue;
    const formalFiling = latestFormalFilingAfter(filings, filing, range);
    const displayFiling = formalFiling || parsed.filing;
    const candidate = {
      symbol: universeItem.symbol,
      company,
      cik: company.cik,
      sources: sourceSet(...(universeItem.sources || []), "earnings-release"),
      calendarDates: universeItem.calendarDates || [],
      forced: universeItem.forced || false,
      manualQueries: universeItem.manualQueries || [],
      rawMetrics: parsed.rawMetrics,
      metricScore,
      accessions: [filing.accessionNumber],
      filings,
      filing: displayFiling,
      submissionsName: submissions.name,
      releaseSource: "SEC 8-K/6-K earnings release",
      releaseFiling: parsed.filing,
      releaseCache: "fresh"
    };
    if (options.reuseAnalysis) {
      await writeCache(cacheName, {
        symbol: universeItem.symbol,
        cik: company.cik,
        rawMetrics: parsed.rawMetrics,
        filing: displayFiling,
        releaseFiling: parsed.filing,
        accessions: [filing.accessionNumber],
        submissionsName: submissions.name,
        releaseSource: "SEC 8-K/6-K earnings release",
        generatedAt: new Date().toISOString()
      });
    }
    return candidate;
  }
  return null;
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
    const releaseDiff = Number(Boolean(b.releaseSource)) - Number(Boolean(a.releaseSource));
    if (releaseDiff !== 0) return releaseDiff;
    const filingDiff = Number(Boolean(b.filing?.filingDate)) - Number(Boolean(a.filing?.filingDate));
    if (filingDiff !== 0) return filingDiff;
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
      rangeEnd: range.end,
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
    stockLinks: usStockLinks(candidate.symbol),
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
    const cached = await readCache(cacheName, ANALYSIS_CACHE_TTL);
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

function metricFromFinancialPoints(points, key, concept = key) {
  const sorted = sortFinancialPoints(points).filter((point) => finiteOrNull(point[key]) != null);
  const currentPoint = sorted[sorted.length - 1] || null;
  const priorPoint =
    currentPoint?.quarter != null
      ? sorted.find((point) => point.year === currentPoint.year - 1 && point.quarter === currentPoint.quarter)
      : sorted[sorted.length - 2] || null;
  const current =
    currentPoint && finiteOrNull(currentPoint[key]) != null
      ? {
          val: Number(currentPoint[key]),
          start: "",
          end: currentPoint.date || "",
          frame: currentPoint.periodLabel || financialPointLabel(currentPoint)
        }
      : null;
  const prior =
    priorPoint && finiteOrNull(priorPoint[key]) != null
      ? {
          val: Number(priorPoint[key]),
          start: "",
          end: priorPoint.date || "",
          frame: priorPoint.periodLabel || financialPointLabel(priorPoint)
        }
      : null;
  return { concept, current, prior, growth: growth(current, prior) };
}

function focusedMetricScore(rawMetrics, options) {
  const score = scoreMetrics(rawMetrics, options);
  if (score.reasons.length) return score;
  return { ...score, reasons: ["指定分析：未触发当前亮眼条件，仍展示财务评分"] };
}

async function focusedUsRankingRow(company, options, force = false, diagnostics = null) {
  const symbol = normalizeTicker(company.ticker);
  const range = quarterRange();
  try {
    const releaseCandidate = await buildEarningsReleaseCandidate(
      {
        symbol,
        sources: ["manual"],
        calendarDates: [],
        forced: true,
        manualQueries: company.queries || []
      },
      company,
      range,
      force,
      options
    );
    if (releaseCandidate) {
      return {
        ...(await enrichFrameCandidate(releaseCandidate, range, force, diagnostics, options)),
        analysisCache: "focused-release"
      };
    }
  } catch (error) {
    if (diagnostics) {
      diagnostics.enrichFailures.push({
        symbol,
        name: company.name || symbol,
        reason: "指定公司扫描 8-K/6-K earnings release 失败，已回退到 SEC companyfacts",
        error: error.message
      });
    }
  }
  const financials = await getUsFinancials(symbol, force);
  const points = sortFinancialPoints(financials.quarterly?.length ? financials.quarterly : financials.annual || []);
  const revenue = metricFromFinancialPoints(points, "revenue", "revenue");
  const netIncome = metricFromFinancialPoints(points, "netIncome", "netIncome");
  const operatingIncome = metricFromFinancialPoints(points, "operatingProfit", "operatingProfit");
  const operatingCashFlow = metricFromFinancialPoints(points, "operatingCashFlow", "operatingCashFlow");
  const rawMetrics = {
    revenue,
    netIncome,
    grossProfit: { concept: "grossProfit", current: null, prior: null, growth: { pct: null, turnaround: false } },
    operatingIncome,
    operatingCashFlow,
    epsDiluted: { concept: "epsDiluted", current: null, prior: null, growth: { pct: null, turnaround: false } },
    grossMargin: null,
    grossMarginPrior: null,
    grossMarginDelta: null,
    operatingMargin: margin(operatingIncome.current, revenue.current),
    operatingMarginPrior: margin(operatingIncome.prior, revenue.prior)
  };
  rawMetrics.operatingMarginDelta =
    rawMetrics.operatingMargin != null && rawMetrics.operatingMarginPrior != null
      ? rawMetrics.operatingMargin - rawMetrics.operatingMarginPrior
      : null;
  const metricScore = focusedMetricScore(rawMetrics, options);
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPad(company.cik)}.json`;
  const submissions = await cachedSecJson(submissionsUrl, force, PROFILE_TTL);
  const filings = zipFilings(submissions.filings?.recent);
  const filing = latestFilingByForms(filings, ["10-Q", "10-K", "20-F", "40-F"]);
  const signals = filing
    ? await scanSignals(company.cik, filings, filing, range, force, diagnostics, symbol, options)
    : [];
  const signalScore = signals.reduce((sum, item) => sum + item.score, 0);
  const customFindings = customFindingsFromMetrics(rawMetrics, options);
  const score = Math.min(100, Math.round(metricScore.score + Math.min(35, signalScore)));
  const highlight =
    score >= 70 ||
    customFindings.length > 0 ||
    signals.length >= 2 ||
    signals.some((signal) =>
      ["产品供不应求", "供给偏紧", "需求旺盛", "产品价格中枢持续上涨"].includes(signal.label)
    );
  const fallbackEnd = revenue.current?.end || netIncome.current?.end || "";
  return {
    symbol,
    name: financials.name || company.name || symbol,
    exchange: company.exchange || "",
    score: Math.min(100, Math.max(0, score)),
    highlight,
    forced: true,
    manualQueries: company.queries || [],
    reasons: metricScore.reasons,
    signals,
    customFindings,
    filing: filing
      ? {
          form: filing.form,
          filingDate: filing.filingDate,
          reportDate: filing.reportDate || fallbackEnd,
          accessionNumber: filing.accessionNumber,
          primaryDocument: filing.primaryDocument,
          url: secFilingUrl(company.cik, filing.accessionNumber, filing.primaryDocument)
        }
      : {
          form: "SEC companyfacts",
          filingDate: "",
          reportDate: fallbackEnd,
          accessionNumber: "",
          primaryDocument: "",
          url: `https://www.sec.gov/edgar/browse/?CIK=${company.cik}&owner=exclude`
        },
    stockUrl: stockUrl(symbol),
    stockLinks: usStockLinks(symbol),
    metrics: {
      revenue: metricPayload(revenue),
      netIncome: metricPayload(netIncome),
      epsDiluted: metricPayload(rawMetrics.epsDiluted),
      operatingCashFlow: metricPayload(operatingCashFlow),
      grossMargin: null,
      grossMarginDelta: null,
      operatingMargin: rawMetrics.operatingMargin,
      operatingMarginDelta: rawMetrics.operatingMarginDelta
    },
    analysisCache: "focused"
  };
}

async function getFocusedUsRankings(force = false, options = parseRankingOptions(), progress = null) {
  const startedAt = Date.now();
  const range = quarterRange();
  const frameInfo = reportingFrame();
  emitProgress(progress, "ticker", "解析指定公司并匹配 SEC CIK");
  const tickerMap = await loadTickerMap(force);
  const manualCompanies = resolveTickerQueries(tickerMap, options.focusCompanyQueries);
  const diagnostics = createRankingDiagnostics();
  emitProgress(progress, "focused-analysis", `分析指定公司 ${manualCompanies.matches.length} 家`, {
    requested: options.focusCompanyQueries.length,
    matched: manualCompanies.matches.length
  });
  const rowsRaw = await mapLimit(manualCompanies.matches, 3, (company) =>
    focusedUsRankingRow(company, options, force, diagnostics)
  );
  const rows = rowsRaw
    .filter((row) => !row?.error)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const nextEarnings = await getNextNasdaqEarningsMap(
    rows.map((row) => row.symbol),
    force,
    progress
  );
  for (const row of rows) {
    row.nextEarnings =
      nextEarnings.bySymbol[row.symbol] ||
      emptyNextEarnings(
        "Nasdaq earnings calendar",
        `未来 ${NEXT_EARNINGS_LOOKAHEAD_DAYS} 天 Nasdaq 日历未找到下一次财报日期`
      );
  }
  const failures = rowsRaw
    .filter((row) => row?.error)
    .map((row) => ({
      query: row.item?.queries?.join(", ") || row.item?.ticker || "",
      symbol: row.item?.ticker || "",
      reason: row.error
    }));
  diagnostics.manualCompanyMissing.push(...manualCompanies.missing, ...failures);
  diagnostics.counts = diagnosticsCounts(diagnostics);
  return {
    market: "us",
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    range,
    reportingFrame: frameInfo,
    analysisOptions: {
      analysisLimit: options.analysisLimit,
      reuseAnalysis: options.reuseAnalysis,
      method: "指定公司快速分析：8-K/6-K earnings-release fallback + SEC companyfacts + submissions",
      usesLLM: false,
      includeCashFlow: options.includeCashFlow,
      cashFlowThresholdPct: options.cashFlowThresholdPct,
      customKeywordRules: options.customKeywordRules,
      focusCompanyQueries: options.focusCompanyQueries
    },
    source: {
      filings: "SEC 8-K/6-K earnings-release exhibits + companyfacts + submissions",
      text: "指定公司快速路径扫描匹配公司的 SEC 主文档文本",
      universe: "manual focus companies",
      nextEarnings: "Nasdaq earnings calendar"
    },
    nextEarningsStats: nextEarnings.stats,
    totals: {
      configured: manualCompanies.matches.length,
      staticUniverse: 0,
      calendarUniverse: 0,
      combinedUniverse: manualCompanies.matches.length,
      scanned: manualCompanies.matches.length,
      candidates: rows.length,
      analyzable: rows.length,
      selectedForAnalysis: rows.length,
      enriched: rows.length,
      ranked: rows.length,
      forced: rows.length,
      diagnostics: diagnostics.counts
    },
    diagnostics,
    rows,
    cache: "fresh"
  };
}

async function getRankings(force = false, options = parseRankingOptions(), progress = null) {
  if (options.focusCompanyQueries.length) {
    return getFocusedUsRankings(force, options, progress);
  }
  const range = quarterRange();
  const frameInfo = reportingFrame();
  const optionsHash = rankingOptionsFingerprint(options);
  const cacheName = `rankings-${frameInfo.frame}-${range.today}-${optionsHash}.json`;
  emitProgress(progress, "cache", force ? "强制刷新：跳过排名缓存" : "检查排名缓存");
  if (!force) {
    const cached = await readCache(cacheName, RANKING_TTL);
    if (cached?.diagnostics?.version === RANKING_DIAGNOSTICS_VERSION) {
      emitProgress(progress, "cache", "命中排名缓存，准备返回结果", {
        ranked: cached.totals?.ranked || 0,
        generatedAt: cached.generatedAt
      });
      return { ...cached, cache: "hit" };
    }
  }

  const startedAt = Date.now();
  const diagnostics = createRankingDiagnostics();
  emitProgress(progress, "universe", "读取静态股票池");
  const universe = await loadUniverse();
  emitProgress(progress, "calendar", `读取当前披露窗口 Nasdaq 日历：${range.start} 至 ${range.today}`);
  const calendarUniverse = await getCalendarSymbolsForRange(range, force, diagnostics, progress);
  emitProgress(progress, "ticker", "读取 SEC ticker/CIK 映射");
  const tickerMap = await loadTickerMap(force);
  const manualCompanies = resolveTickerQueries(tickerMap, options.focusCompanyQueries);
  diagnostics.manualCompanyMissing.push(...manualCompanies.missing);
  emitProgress(progress, "frames", `读取 SEC frames 指标：${frameInfo.frame} / ${frameInfo.priorFrame}`);
  const frameMaps = await loadFrameMetrics(frameInfo, force, diagnostics);
  emitProgress(progress, "score", "合并股票池并计算增长评分", {
    staticSymbols: universe.symbols.length,
    calendarSymbols: calendarUniverse.length
  });
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
  let scannedForScore = 0;
  for (const symbol of symbols) {
    scannedForScore += 1;
    if (scannedForScore === 1 || scannedForScore % 500 === 0 || scannedForScore === symbols.length) {
      emitProgress(progress, "score", `计算财务增长评分 ${scannedForScore}/${symbols.length} 家`, {
        scanned: scannedForScore,
        total: symbols.length,
        candidates: candidates.length
      });
    }
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
  const releaseFallbackStart = toDateOnly(
    addDays(parseDate(range.today) || new Date(), -EARNINGS_RELEASE_LOOKBACK_DAYS)
  );
  const releaseUniverseItems = universeItems.filter(
    (item) =>
      tickerMap.has(item.symbol) &&
      (item.forced ||
        item.sources.includes("static") ||
        (item.sources.includes("calendar") && latestDate(item.calendarDates) >= releaseFallbackStart))
  );
  emitProgress(progress, "earnings-release", `扫描最近 ${EARNINGS_RELEASE_LOOKBACK_DAYS} 天 8-K/6-K 业绩新闻稿：${releaseUniverseItems.length} 家`, {
    candidates: releaseUniverseItems.length,
    since: releaseFallbackStart
  });
  let releaseScanned = 0;
  let releaseMatched = 0;
  let releaseFailed = 0;
  let releaseCacheHits = 0;
  let releaseCacheMisses = 0;
  const releaseCandidatesRaw = await mapLimit(releaseUniverseItems, 4, async (item) => {
    const company = tickerMap.get(item.symbol);
    try {
      const candidate = await buildEarningsReleaseCandidate(item, company, range, force, options);
      if (candidate) {
        releaseMatched += 1;
        if (candidate.releaseCache === "hit") releaseCacheHits += 1;
        else releaseCacheMisses += 1;
      }
      return candidate;
    } catch (error) {
      releaseFailed += 1;
      return { error: error.message, item };
    } finally {
      releaseScanned += 1;
      if (
        releaseScanned === 1 ||
        releaseScanned % 20 === 0 ||
        releaseScanned === releaseUniverseItems.length
      ) {
        emitProgress(
          progress,
          "earnings-release",
          `扫描最近 ${EARNINGS_RELEASE_LOOKBACK_DAYS} 天 8-K/6-K 业绩新闻稿 ${releaseScanned}/${releaseUniverseItems.length} 家`,
          {
            scanned: releaseScanned,
            total: releaseUniverseItems.length,
            matched: releaseMatched,
            failed: releaseFailed,
            cacheHits: releaseCacheHits,
            cacheMisses: releaseCacheMisses,
            since: releaseFallbackStart
          }
        );
      }
    }
  });
  const releaseErrors = releaseCandidatesRaw
    .filter((row) => row?.error)
    .map((row) => ({
      symbol: row.item?.symbol || "",
      name: row.item?.calendarName || row.item?.symbol || "",
      sources: row.item?.sources || [],
      calendarDates: row.item?.calendarDates || [],
      reason: "扫描 8-K/6-K earnings release 失败",
      error: row.error
    }));
  diagnostics.enrichFailures.push(...releaseErrors);
  const releaseCandidates = releaseCandidatesRaw.filter((row) => row && !row.error);
  if (releaseCandidates.length) {
    const releaseSymbols = new Set(releaseCandidates.map((candidate) => candidate.symbol));
    diagnostics.noCurrentFrameFacts = diagnostics.noCurrentFrameFacts.filter(
      (item) => !releaseSymbols.has(item.symbol)
    );
    candidates.push(...releaseCandidates);
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

  emitProgress(progress, "filings", `补全候选公司 SEC submissions 和披露日期：${selectedCandidates.length} 家`, {
    candidates: candidates.length,
    selected: selectedCandidates.length
  });
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

  emitProgress(progress, "text", `解析候选财报文本和景气度信号：${analysisCandidates.length} 家`, {
    analysisCandidates: analysisCandidates.length
  });
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
  const nextEarnings = await getNextNasdaqEarningsMap(
    ranked.map((row) => row.symbol),
    force,
    progress
  );
  for (const row of ranked) {
    row.nextEarnings =
      nextEarnings.bySymbol[row.symbol] ||
      emptyNextEarnings(
        "Nasdaq earnings calendar",
        `未来 ${NEXT_EARNINGS_LOOKAHEAD_DAYS} 天 Nasdaq 日历未找到下一次财报日期`
      );
  }
  diagnostics.noPositiveScore = sortDiagnosticsByFilingDate(diagnostics.noPositiveScore);
  emitProgress(progress, "diagnostics", "整理覆盖与异常列表");
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
      method: `SEC XBRL frames + recent ${EARNINGS_RELEASE_LOOKBACK_DAYS}d 8-K/6-K earnings-release fallback + regex keyword scan`,
      usesLLM: false,
      includeCashFlow: options.includeCashFlow,
      cashFlowThresholdPct: options.cashFlowThresholdPct,
      customKeywordRules: options.customKeywordRules,
      focusCompanyQueries: options.focusCompanyQueries
    },
    source: {
      filings: "SEC EDGAR frames + submissions + 8-K/6-K earnings-release exhibits",
      text: "SEC filing primary documents; regex/string keyword matching, no LLM",
      universe: "config/universe.json + Nasdaq earnings calendar for the current disclosure window",
      nextEarnings: "Nasdaq earnings calendar"
    },
    nextEarningsStats: nextEarnings.stats,
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
    stockLinks: usStockLinks(symbol),
    nasdaqUrl: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/earnings`
  };
}

async function fetchCalendarDay(date, force = false) {
  const cacheName = `calendar-day-${date}.json`;
  if (!force) {
    const cached = await readCache(cacheName, CALENDAR_TTL);
    if (cached) return { ...cached, cache: "hit", apiCalls: 0 };
  }
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
  const payload = await fetchNasdaqJson(url);
  const rows = (payload?.data?.rows || []).map((row) => cleanNasdaqRow(row, date));
  const result = { date, rows, fetchedAt: new Date().toISOString() };
  await writeCache(cacheName, result);
  return { ...result, cache: "fresh", apiCalls: 1 };
}

function emptyNextEarnings(source, note = "") {
  return {
    date: "",
    reportDate: "",
    label: "",
    source,
    status: "not-found",
    note
  };
}

function upcomingDateWindow(days = NEXT_EARNINGS_LOOKAHEAD_DAYS) {
  const today = toDateOnly(new Date());
  return {
    start: today,
    end: toDateOnly(addDays(new Date(), days)),
    days: dateRange(today, toDateOnly(addDays(new Date(), days)))
  };
}

async function getNextNasdaqEarningsMap(symbols, force = false, progress = null) {
  const normalizedSymbols = [
    ...new Set((symbols || []).map((symbol) => normalizeTicker(String(symbol || ""))).filter(Boolean))
  ].sort();
  const window = upcomingDateWindow();
  const cacheName = `next-nasdaq-earnings-v1-${window.start}-${NEXT_EARNINGS_LOOKAHEAD_DAYS}-${hashKey(
    normalizedSymbols.join(",")
  )}.json`;
  if (!force) {
    const cached = await readCache(cacheName, NEXT_EARNINGS_TTL);
    if (cached) {
      return {
        ...cached,
        cache: "hit",
        stats: {
          ...(cached.stats || {}),
          apiCalls: 0,
          cachedApiCalls: cached.stats?.apiCalls || 0
        }
      };
    }
  }

  const wanted = new Set(normalizedSymbols);
  const bySymbol = {};
  const fetchFailures = [];
  let calendarDayRequests = 0;
  let apiCalls = 0;
  const batchSize = 10;
  for (let index = 0; index < window.days.length && Object.keys(bySymbol).length < wanted.size; index += batchSize) {
    const batch = window.days.slice(index, index + batchSize);
    emitProgress(
      progress,
      "next-earnings",
      `扫描未来财报日历 ${Math.min(index + batch.length, window.days.length)}/${window.days.length} 天，已匹配 ${Object.keys(bySymbol).length}/${wanted.size} 家`,
      {
        completedDays: index,
        totalDays: window.days.length,
        matchedSymbols: Object.keys(bySymbol).length,
        requestedSymbols: wanted.size,
        from: batch[0],
        to: batch[batch.length - 1]
      }
    );
    calendarDayRequests += batch.length;
    const dayResults = await mapLimit(batch, 5, (date) => fetchCalendarDay(date, force));
    for (const result of dayResults) {
      apiCalls += result?.apiCalls || 0;
      if (result?.error) {
        fetchFailures.push({ date: result.item || "", error: result.error });
        continue;
      }
      for (const row of result?.rows || []) {
        const symbol = normalizeTicker(row.symbol || "");
        if (!wanted.has(symbol) || bySymbol[symbol]) continue;
        bySymbol[symbol] = {
          date: result.date,
          reportDate: row.fiscalQuarterEnding || "",
          label: row.fiscalQuarterEnding ? `${row.fiscalQuarterEnding} 财报` : "财报",
          time: row.time || "",
          epsForecast: row.epsForecast || "",
          source: "Nasdaq earnings calendar",
          status: "scheduled",
          url: row.nasdaqUrl || stockUrl(symbol)
        };
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    bySymbol,
    missing: normalizedSymbols.filter((symbol) => !bySymbol[symbol]),
    stats: {
      source: "Nasdaq earnings calendar",
      method: "future daily calendar scan",
      lookaheadDays: NEXT_EARNINGS_LOOKAHEAD_DAYS,
      startDate: window.start,
      endDate: window.end,
      calendarDayRequests,
      apiCalls,
      requestedSymbols: normalizedSymbols.length,
      matchedSymbols: Object.keys(bySymbol).length,
      fetchFailures
    }
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
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

const FINANCIAL_METRICS = [
  { key: "revenue", label: "营收", kind: "flow", unit: "money" },
  { key: "netIncome", label: "归母净利润", kind: "flow", unit: "money" },
  { key: "operatingCashFlow", label: "经营现金流", kind: "flow", unit: "money" },
  { key: "operatingProfit", label: "经营利润", kind: "flow", unit: "money" },
  { key: "contractLiabilities", label: "预收/合同负债", kind: "stock", unit: "money" },
  { key: "accountsReceivable", label: "应收账款", kind: "stock", unit: "money" },
  { key: "inventory", label: "存货", kind: "stock", unit: "money" },
  { key: "totalAssets", label: "总资产", kind: "stock", unit: "money" },
  { key: "totalLiabilities", label: "总负债", kind: "stock", unit: "money" },
  { key: "debtAssetRatio", label: "资产负债率", kind: "ratio", unit: "percent" }
];

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function yearFromReportDate(value) {
  const date = ashareDate(value);
  return date ? Number(date.slice(0, 4)) : null;
}

function quarterFromReportDate(value) {
  const date = ashareDate(value);
  const month = Number(date.slice(5, 7));
  if (month === 3) return 1;
  if (month === 6) return 2;
  if (month === 9) return 3;
  if (month === 12) return 4;
  return null;
}

function fiscalPeriodLabel(year, quarter) {
  return year && quarter ? `${year}Q${quarter}` : String(year || "");
}

function pctFromEastmoney(value) {
  const number = finiteOrNull(value);
  return number == null ? null : number / 100;
}

function mergeFinancialRows(...rowSets) {
  const byDate = new Map();
  for (const rows of rowSets) {
    for (const row of rows || []) {
      const reportDate = ashareDate(row.REPORT_DATE || row.REPORTDATE);
      if (!reportDate) continue;
      byDate.set(reportDate, { ...(byDate.get(reportDate) || {}), ...row, reportDate });
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.reportDate).localeCompare(String(b.reportDate)));
}

function normalizeAshareFinancialPoint(row) {
  const year = yearFromReportDate(row.reportDate);
  const quarter = quarterFromReportDate(row.reportDate);
  return {
    date: row.reportDate,
    year,
    quarter,
    periodLabel: fiscalPeriodLabel(year, quarter),
    reportType: row.DATE_TYPE_CODE || "",
    revenue: finiteOrNull(row.TOTAL_OPERATE_INCOME),
    netIncome: finiteOrNull(row.PARENT_NETPROFIT),
    deductedNetIncome: finiteOrNull(row.DEDUCT_PARENT_NETPROFIT),
    operatingProfit: finiteOrNull(row.OPERATE_PROFIT),
    operatingCashFlow: finiteOrNull(row.NETCASH_OPERATE),
    investingCashFlow: finiteOrNull(row.NETCASH_INVEST),
    financingCashFlow: finiteOrNull(row.NETCASH_FINANCE),
    capex: finiteOrNull(row.CONSTRUCT_LONG_ASSET),
    totalAssets: finiteOrNull(row.TOTAL_ASSETS),
    totalLiabilities: finiteOrNull(row.TOTAL_LIABILITIES),
    totalEquity: finiteOrNull(row.TOTAL_EQUITY),
    cash: finiteOrNull(row.MONETARYFUNDS),
    accountsReceivable: finiteOrNull(row.ACCOUNTS_RECE),
    inventory: finiteOrNull(row.INVENTORY),
    accountsPayable: finiteOrNull(row.ACCOUNTS_PAYABLE),
    contractLiabilities: finiteOrNull(row.ADVANCE_RECEIVABLES),
    debtAssetRatio: pctFromEastmoney(row.DEBT_ASSET_RATIO),
    currentRatio: pctFromEastmoney(row.CURRENT_RATIO)
  };
}

const ASHARE_CUMULATIVE_FLOW_KEYS = [
  "revenue",
  "netIncome",
  "deductedNetIncome",
  "operatingProfit",
  "operatingCashFlow",
  "investingCashFlow",
  "financingCashFlow",
  "capex"
];

function deriveAshareSingleQuarterPoints(points) {
  const sorted = [...points].filter((point) => point.year && point.quarter).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byPeriod = new Map(sorted.map((point) => [`${point.year}Q${point.quarter}`, point]));
  return sorted.map((point) => {
    const output = {
      ...point,
      sourcePeriodType: "single-quarter",
      derivation: point.quarter === 1 ? "Q1 uses disclosed period amount" : "single-quarter amount = current cumulative amount - prior cumulative amount"
    };
    for (const key of ASHARE_CUMULATIVE_FLOW_KEYS) {
      const current = finiteOrNull(point[key]);
      if (point.quarter === 1) {
        output[key] = current;
        continue;
      }
      const previous = byPeriod.get(`${point.year}Q${point.quarter - 1}`);
      const prior = finiteOrNull(previous?.[key]);
      output[key] = current != null && prior != null ? current - prior : null;
    }
    return output;
  });
}

async function fetchAshareFinancialStatementRows(reportName, code, force = false) {
  return fetchEastmoneyPaged(
    reportName,
    {
      pageSize: "100",
      sortColumns: "REPORT_DATE",
      sortTypes: "-1",
      filter: `(SECURITY_CODE="${code}")`
    },
    force
  );
}

async function getAshareFinancials(symbol, force = false) {
  const code = String(symbol || "").replace(/\D/g, "").slice(0, 6);
  if (!code) throw new Error("缺少 A股代码");
  const cacheName = `ashare-financials-v2-${code}.json`;
  if (!force) {
    const cached = await readCache(cacheName, SEC_TTL);
    if (cached) return { ...cached, cache: "hit" };
  }

  const [incomeRows, cashRows, balanceRows] = await Promise.all([
    fetchAshareFinancialStatementRows("RPT_DMSK_FN_INCOME", code, force),
    fetchAshareFinancialStatementRows("RPT_DMSK_FN_CASHFLOW", code, force),
    fetchAshareFinancialStatementRows("RPT_DMSK_FN_BALANCE", code, force)
  ]);
  const merged = mergeFinancialRows(incomeRows, cashRows, balanceRows);
  const points = merged.map(normalizeAshareFinancialPoint).filter((point) => point.year);
  const quarterly = deriveAshareSingleQuarterPoints(points);
  const annual = points.filter((point) => String(point.date).endsWith("-12-31"));
  const sourceRow = incomeRows[0] || cashRows[0] || balanceRows[0] || {};
  const payload = {
    market: "cn",
    symbol: code,
    name: sourceRow.SECURITY_NAME_ABBR || code,
    generatedAt: new Date().toISOString(),
    source: "东方财富三大财务报表 RPT_DMSK_FN_INCOME/CASHFLOW/BALANCE",
    currency: "CNY",
    unitDivisor: 100000000,
    unitLabel: "亿元",
    metrics: FINANCIAL_METRICS,
    accuracyNotes: [
      "A股利润表和现金流量表的季报原始值通常是年初至报告期末累计口径；页面展示的季度流量按同一年相邻报告期差额拆分，缺上一期时不强行估算。",
      "资产负债表项目是报告期末时点余额，直接使用披露值；资产负债率直接使用东方财富结构化字段。"
    ],
    annual: annual.length ? annual : points,
    quarterly,
    recent: quarterly.slice(-16).reverse()
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
}

const US_FINANCIAL_CONCEPTS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet"
  ],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  operatingProfit: ["OperatingIncomeLoss"],
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"
  ],
  contractLiabilities: [
    "ContractWithCustomerLiabilityCurrent",
    "ContractWithCustomerLiability",
    "DeferredRevenueCurrent",
    "DeferredRevenue"
  ],
  totalAssets: ["Assets"],
  totalLiabilities: ["Liabilities"],
  totalEquity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  accountsReceivable: ["AccountsReceivableNetCurrent", "AccountsReceivableNet"],
  inventory: ["InventoryNet"]
};

function unitFactsForConcept(facts, concept, unit = "USD") {
  return facts?.facts?.["us-gaap"]?.[concept]?.units?.[unit] || [];
}

function pickUsAnnualFacts(facts, concepts, unit = "USD") {
  const yearly = new Map();
  for (const concept of concepts) {
    const rows = unitFactsForConcept(facts, concept, unit)
      .filter((fact) => Number.isFinite(Number(fact.val)))
      .filter((fact) => ["10-K", "20-F", "40-F"].includes(fact.form))
      .filter((fact) => fact.fp === "FY" && fact.end)
      .filter((fact) => {
        const duration = daysBetween(fact.start, fact.end);
        return !duration || duration >= 250;
      })
      .sort((a, b) => String(b.filed || "").localeCompare(String(a.filed || "")));
    for (const fact of rows) {
      const year = Number(String(fact.end).slice(0, 4));
      const current = yearly.get(year);
      if (!current || String(fact.filed || "").localeCompare(String(current.filed || "")) > 0) {
        yearly.set(year, {
          year,
          date: fact.end,
          value: Number(fact.val),
          concept,
          filed: fact.filed || ""
        });
      }
    }
  }
  return yearly;
}

function pickUsQuarterlyFacts(facts, concepts, options = {}) {
  const unit = options.unit || "USD";
  const instant = options.instant === true;
  const quarterly = new Map();
  const framePattern = instant ? /^CY(\d{4})Q([1-4])I$/ : /^CY(\d{4})Q([1-4])$/;
  for (const concept of concepts) {
    const rows = unitFactsForConcept(facts, concept, unit)
      .filter((fact) => Number.isFinite(Number(fact.val)))
      .filter((fact) => ["10-Q", "10-K", "20-F", "40-F"].includes(fact.form))
      .filter((fact) => framePattern.test(fact.frame || ""))
      .sort((a, b) => String(b.filed || "").localeCompare(String(a.filed || "")));
    for (const fact of rows) {
      const match = framePattern.exec(fact.frame || "");
      if (!match) continue;
      const year = Number(match[1]);
      const quarter = Number(match[2]);
      const key = `${year}Q${quarter}`;
      const current = quarterly.get(key);
      if (!current || String(fact.filed || "").localeCompare(String(current.filed || "")) > 0) {
        quarterly.set(key, {
          year,
          quarter,
          periodLabel: key,
          date: fact.end || `${year}-12-31`,
          value: Number(fact.val),
          concept,
          filed: fact.filed || ""
        });
      }
    }
  }
  return quarterly;
}

function normalizeUsFinancialPoint(year, maps) {
  const value = (key) => maps[key]?.get(year)?.value ?? null;
  const assets = value("totalAssets");
  const liabilities = value("totalLiabilities");
  return {
    year,
    date: maps.revenue?.get(year)?.date || maps.netIncome?.get(year)?.date || `${year}-12-31`,
    revenue: value("revenue"),
    netIncome: value("netIncome"),
    operatingProfit: value("operatingProfit"),
    operatingCashFlow: value("operatingCashFlow"),
    contractLiabilities: value("contractLiabilities"),
    totalAssets: assets,
    totalLiabilities: liabilities,
    totalEquity: value("totalEquity"),
    cash: value("cash"),
    accountsReceivable: value("accountsReceivable"),
    inventory: value("inventory"),
    debtAssetRatio: assets && liabilities ? liabilities / assets : null
  };
}

function normalizeUsQuarterlyPoint(periodKey, maps) {
  const value = (key) => maps[key]?.get(periodKey)?.value ?? null;
  const revenuePoint = maps.revenue?.get(periodKey);
  const netIncomePoint = maps.netIncome?.get(periodKey);
  const source = revenuePoint || netIncomePoint || maps.totalAssets?.get(periodKey) || {};
  const year = source.year || Number(periodKey.slice(0, 4));
  const quarter = source.quarter || Number(periodKey.slice(-1));
  const assets = value("totalAssets");
  const liabilities = value("totalLiabilities");
  return {
    year,
    quarter,
    periodLabel: fiscalPeriodLabel(year, quarter),
    date: source.date || "",
    revenue: value("revenue"),
    netIncome: value("netIncome"),
    operatingProfit: value("operatingProfit"),
    operatingCashFlow: value("operatingCashFlow"),
    contractLiabilities: value("contractLiabilities"),
    totalAssets: assets,
    totalLiabilities: liabilities,
    totalEquity: value("totalEquity"),
    cash: value("cash"),
    accountsReceivable: value("accountsReceivable"),
    inventory: value("inventory"),
    debtAssetRatio: assets && liabilities ? liabilities / assets : null,
    sourcePeriodType: "reported-quarter-frame",
    derivation: "SEC companyfacts explicit quarterly frame"
  };
}

async function getUsFinancials(symbol, force = false) {
  const normalized = normalizeTicker(symbol || "");
  if (!normalized) throw new Error("缺少美股代码");
  const cacheName = `us-financials-v3-${normalized}.json`;
  if (!force) {
    const cached = await readCache(cacheName, SEC_TTL);
    if (cached) return { ...cached, cache: "hit" };
  }
  const tickerMap = await loadTickerMap(force);
  const company = tickerMap.get(normalized);
  if (!company?.cik) throw new Error(`未找到 ${normalized} 的 CIK`);
  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPad(company.cik)}.json`;
  const facts = await cachedSecJson(factsUrl, force, SEC_TTL);
  const maps = Object.fromEntries(
    Object.entries(US_FINANCIAL_CONCEPTS).map(([key, concepts]) => [
      key,
      pickUsAnnualFacts(facts, concepts)
    ])
  );
  const quarterlyMaps = Object.fromEntries(
    Object.entries(US_FINANCIAL_CONCEPTS).map(([key, concepts]) => [
      key,
      pickUsQuarterlyFacts(facts, concepts, {
        instant: ["contractLiabilities", "totalAssets", "totalLiabilities", "totalEquity", "cash", "accountsReceivable", "inventory"].includes(key)
      })
    ])
  );
  const years = [
    ...new Set(
      Object.values(maps).flatMap((map) => [...map.keys()])
    )
  ].sort((a, b) => a - b);
  const annual = years.map((year) => normalizeUsFinancialPoint(year, maps));
  const quarterKeys = [
    ...new Set(Object.values(quarterlyMaps).flatMap((map) => [...map.keys()]))
  ].sort((a, b) => {
    const ay = Number(a.slice(0, 4));
    const by = Number(b.slice(0, 4));
    if (ay !== by) return ay - by;
    return Number(a.slice(-1)) - Number(b.slice(-1));
  });
  const quarterly = quarterKeys.map((key) => normalizeUsQuarterlyPoint(key, quarterlyMaps));
  const payload = {
    market: "us",
    symbol: normalized,
    name: company.name || facts.entityName || normalized,
    generatedAt: new Date().toISOString(),
    source: "SEC companyfacts XBRL 年度事实与明确季度 frame",
    currency: "USD",
    unitDivisor: 1000000000,
    unitLabel: "十亿美元",
    metrics: FINANCIAL_METRICS,
    accuracyNotes: [
      "美股季度数据优先使用 SEC companyfacts 中带明确季度 frame 的 XBRL 事实；缺少明确季度 frame 的指标不会被猜算。",
      "年度数据来自 10-K/20-F/40-F 年度事实，季度图表和年度表分开保留口径。"
    ],
    annual,
    quarterly,
    recent: (quarterly.length ? quarterly : annual).slice(-16).reverse()
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
}

async function getFinancials(market, symbol, force = false) {
  return market === "cn" ? getAshareFinancials(symbol, force) : getUsFinancials(symbol, force);
}

const LLM_ANALYSIS_METRIC_KEYS = [
  "revenue",
  "netIncome",
  "operatingProfit",
  "operatingCashFlow",
  "contractLiabilities",
  "accountsReceivable",
  "inventory",
  "debtAssetRatio"
];

function sortFinancialPoints(points = []) {
  return [...points]
    .filter((point) => point.year)
    .sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return (a.quarter || 0) - (b.quarter || 0);
    });
}

function financialPointLabel(point) {
  return point?.periodLabel || (point?.quarter ? `${point.year}Q${point.quarter}` : String(point?.year || point?.date || ""));
}

function formatFinancialForAnalysis(value, financials, metric) {
  const number = finiteOrNull(value);
  if (number == null) return null;
  if (metric?.unit === "percent") return `${(number * 100).toFixed(2)}%`;
  return `${(number / (financials.unitDivisor || 1)).toFixed(2)}${financials.unitLabel || ""}`;
}

function financialChangeForAnalysis(current, prior, metric) {
  const currentValue = finiteOrNull(current);
  const priorValue = finiteOrNull(prior);
  if (currentValue == null || priorValue == null) return null;
  if (metric?.unit === "percent") {
    const changePctPoints = (currentValue - priorValue) * 100;
    return {
      mode: "percentage-point",
      value: Number(changePctPoints.toFixed(2)),
      display: `${changePctPoints >= 0 ? "+" : ""}${changePctPoints.toFixed(2)}pct`
    };
  }
  if (Math.abs(priorValue) < 1) return null;
  const change = (currentValue - priorValue) / Math.abs(priorValue);
  return {
    mode: "percent-change",
    value: Number(change.toFixed(4)),
    display: `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`
  };
}

function valueObjectForAnalysis(point, key, financials, metricMap) {
  const metric = metricMap[key] || { key, unit: "money" };
  const value = finiteOrNull(point?.[key]);
  return {
    raw: value,
    display: formatFinancialForAnalysis(value, financials, metric)
  };
}

function metricSnapshotForAnalysis(points, key, financials, metricMap) {
  const metric = metricMap[key] || { key, label: key, unit: "money" };
  const latest = points[points.length - 1] || {};
  const prior = points[points.length - 2] || {};
  const priorYear = latest.quarter
    ? points.find((point) => point.year === latest.year - 1 && point.quarter === latest.quarter)
    : points[points.length - 2];
  return {
    key,
    label: metric.label,
    unit: metric.unit,
    latestPeriod: financialPointLabel(latest),
    latest: valueObjectForAnalysis(latest, key, financials, metricMap),
    quarterOverQuarter: financialChangeForAnalysis(latest[key], prior[key], metric),
    yearOverYear: financialChangeForAnalysis(latest[key], priorYear?.[key], metric)
  };
}

function pickIndustryContext(profile = {}) {
  const views = ANALYSIS_CONTEXT.industryViews || {};
  const targetText = [profile.sector, profile.industry, profile.businessDescription].filter(Boolean).join(" ").toLowerCase();
  for (const [key, value] of Object.entries(views)) {
    if (key === "default") continue;
    if (targetText.includes(String(key).toLowerCase())) {
      return { key, ...value };
    }
  }
  return views.default ? { key: "default", ...views.default } : {};
}

function pickCompanyOverride(financials) {
  const overrides = ANALYSIS_CONTEXT.companyOverrides || {};
  const keys = [
    `${financials.market}:${financials.symbol}`,
    `${financials.market}:${String(financials.symbol || "").toUpperCase()}`,
    String(financials.symbol || ""),
    String(financials.symbol || "").toUpperCase(),
    String(financials.name || "")
  ];
  for (const key of keys) {
    if (overrides[key]) return { key, ...overrides[key] };
  }
  return {};
}

function defaultMacroPolicyContext(financials = {}) {
  const isChina = financials.market === "cn";
  return {
    key: `${financials.market || "global"}:auto-framework`,
    status: "partial",
    source: "系统默认分析框架，未拉取实时央行/统计局/FRED 数据",
    summary: isChina
      ? "未配置实时中国宏观和货币政策数据；本段只能作为A股分析框架，不能替代最新央行、统计局、财政部或交易所披露。"
      : "未配置实时美国宏观和货币政策数据；本段只能作为美股分析框架，不能替代最新FOMC、FRED、公司电话会或行业数据。",
    monetaryPolicy: isChina
      ? "关注社融/信贷扩张、LPR/MLF/逆回购利率、财政支出节奏、地产政策和汇率环境对需求、估值与融资成本的影响。"
      : "关注联邦基金利率路径、长端美债收益率、美元流动性和信用利差对估值、融资成本和下游资本开支的影响。",
    liquidity: isChina
      ? "流动性判断需要结合最新公开市场操作、社融、M2、信用利差和北向/ETF资金数据；当前输入未提供这些实时指标。"
      : "流动性判断需要结合最新FOMC表态、准备金、信用利差和美债收益率曲线；当前输入未提供这些实时指标。",
    demandEnvironment: isChina
      ? "需求环境需结合内需、出口、地产链、制造业PMI和行业订单数据；当前只能从公司财报和经营指标侧面验证。"
      : "需求环境需结合消费、企业IT/资本开支、PMI、库存周期和行业订单；当前只能从公司财报和经营指标侧面验证。",
    riskFreeRate: isChina
      ? "未提供实时国债收益率，无法量化无风险利率变化对估值中枢的影响。"
      : "未提供实时美债收益率，无法量化无风险利率变化对估值中枢的影响。",
    notes: [
      "这是默认框架，不是实时宏观结论。",
      "若需要明确结论，请在 config/analysis-context.local.json 填写最新宏观政策、利率、流动性和需求环境。"
    ]
  };
}

function inferIndustryTheme(profile = {}) {
  const text = [profile.sector, profile.industry, profile.businessDescription].filter(Boolean).join(" ").toLowerCase();
  const hasAny = (terms) => terms.some((term) => text.includes(term));
  if (hasAny(["memory", "dram", "nand", "storage", "semiconductor", "chip", "半导体", "存储", "芯片"])) {
    return {
      key: "auto:存储/半导体",
      cycleStage: "自动识别为存储/半导体链条；该行业通常强周期，景气度需要结合DRAM/NAND/HBM价格、库存周期、资本开支纪律和下游AI/服务器需求验证。",
      ceiling: "行业天花板主要取决于AI服务器和数据中心需求、终端设备换机周期、先进制程/封装能力，以及供给端扩产节奏；当前未接入实时价格和库存数据，不能直接判断周期顶部。",
      demandDrivers: ["AI服务器和数据中心内存/存储需求", "PC/手机/汽车电子库存回补", "高带宽内存和高性能存储升级"],
      supplyConstraints: ["先进制程和高端产品良率爬坡", "资本开支纪律", "行业集中度和产能释放节奏"],
      risks: ["存储价格回落", "下游库存重新累积", "扩产导致供给压力", "客户资本开支放缓"]
    };
  }
  if (hasAny(["pcb", "printed circuit", "electronic component", "电子元件", "印制电路", "连接器", "消费电子"])) {
    return {
      key: "auto:电子元件/PCB",
      cycleStage: "自动识别为电子元件/PCB或消费电子链条；景气度需要结合AI服务器、汽车电子、消费电子复苏、客户订单和产能利用率验证。",
      ceiling: "行业天花板取决于高端产品占比、核心客户份额、技术升级和下游新品周期；当前未接入实时订单和价格数据，不能直接判断周期顶部。",
      demandDrivers: ["AI服务器和高速通信硬件升级", "汽车电子渗透", "消费电子新品周期", "核心客户份额提升"],
      supplyConstraints: ["高端产线认证和良率", "核心客户导入节奏", "原材料和产能瓶颈"],
      risks: ["消费电子需求不及预期", "客户集中度高", "价格竞争", "扩产后产能利用率下降"]
    };
  }
  if (hasAny(["software", "cloud", "saas", "软件", "云", "互联网"])) {
    return {
      key: "auto:软件/云服务",
      cycleStage: "自动识别为软件/云服务链条；景气度需要结合企业IT预算、续费率、净收入留存、云迁移和AI产品商业化验证。",
      ceiling: "行业天花板取决于可服务市场、客户渗透率、ARPU提升和产品平台化能力；当前未接入实时行业预算数据。",
      demandDrivers: ["企业数字化和AI应用", "云迁移", "续费和交叉销售", "成本优化后的IT预算恢复"],
      supplyConstraints: ["产品研发效率", "算力和云成本", "销售渠道扩张"],
      risks: ["客户预算收缩", "竞争加剧", "获客成本上升", "AI投入短期压制利润率"]
    };
  }
  if (hasAny(["pharma", "biotech", "drug", "medical", "制药", "生物", "医疗"])) {
    return {
      key: "auto:医药/生物科技",
      cycleStage: "自动识别为医药或生物科技链条；景气度需要结合核心产品放量、临床/审批节点、医保/支付政策和研发管线验证。",
      ceiling: "行业天花板取决于适应症空间、竞争格局、专利保护和商业化能力；当前未接入实时临床和政策数据。",
      demandDrivers: ["核心产品放量", "新适应症拓展", "临床或审批进展", "支付覆盖改善"],
      supplyConstraints: ["产能和质量体系", "专利与独占期", "渠道和准入"],
      risks: ["临床失败", "竞品冲击", "价格/支付压力", "专利悬崖"]
    };
  }
  return {
    key: "auto:通用行业框架",
    cycleStage: "未匹配到专门行业上下文；只能基于公司行业分类、主营简介和财务指标做框架性判断。",
    ceiling: "行业天花板需结合公司可服务市场、需求增速、竞争格局、供给扩张和价格趋势；当前未接入实时行业数据库。",
    demandDrivers: ["收入增速", "订单/客户需求", "新品或新市场拓展", "行业资本开支或消费周期"],
    supplyConstraints: ["产能", "技术壁垒", "渠道和客户认证", "原材料或人力成本"],
    risks: ["需求不及预期", "竞争加剧", "价格下行", "扩产或费用投入压制利润"]
  };
}

function defaultIndustryContext(profile = {}) {
  const theme = inferIndustryTheme(profile);
  return {
    status: "partial",
    source: "系统根据公司行业、主营简介和通用行业框架自动生成，未接入实时行业数据库",
    sector: profile.sector || "",
    industry: profile.industry || "",
    ...theme,
    notes: [
      "这是默认行业框架，不是实时行业景气结论。",
      "若需要更强结论，请在 config/analysis-context.local.json 为对应行业填写 cycleStage、ceiling、demandDrivers、supplyConstraints 和 risks。"
    ]
  };
}

const US_MACRO_FRED_SERIES = [
  { id: "FEDFUNDS", label: "联邦基金有效利率（月度）" },
  { id: "DGS10", label: "10年期美国国债收益率（日度）" },
  { id: "T10Y2Y", label: "10年-2年美债期限利差（日度）" },
  { id: "CPIAUCSL", label: "美国CPI指数（月度）" },
  { id: "UNRATE", label: "美国失业率（月度）" }
];

function needsWebSupplement(context) {
  return !hasMeaningfulContext(context) || context.status === "partial" || context.status === "missing";
}

function latestIndicator(indicators, id) {
  return indicators.find((item) => item.id === id);
}

function fredIndicatorText(indicator, suffix = "%") {
  if (!indicator) return "";
  return `${indicator.label} ${indicator.value}${suffix}（${indicator.date}，${indicator.source}）`;
}

async function fetchUsMacroPolicySupplement(force = false) {
  const fetched = await mapLimit(US_MACRO_FRED_SERIES, 3, async (series) => {
    try {
      return await fetchFredSeries(series.id, series.label, force);
    } catch (error) {
      return { id: series.id, label: series.label, error: error.message, source: "FRED" };
    }
  });
  const indicators = fetched.filter((item) => Number.isFinite(item.value));
  const failures = fetched.filter((item) => !Number.isFinite(item.value));
  const fedFunds = latestIndicator(indicators, "FEDFUNDS");
  const tenYear = latestIndicator(indicators, "DGS10");
  const curve = latestIndicator(indicators, "T10Y2Y");
  const cpi = latestIndicator(indicators, "CPIAUCSL");
  const unemployment = latestIndicator(indicators, "UNRATE");
  if (!indicators.length) {
    return {
      status: "partial",
      source: "FRED public CSV",
      generatedAt: new Date().toISOString(),
      summary: "尝试联网补充美国宏观数据，但 FRED 指标暂不可用。",
      failures
    };
  }
  return {
    status: "ok",
    source: "FRED public CSV",
    generatedAt: new Date().toISOString(),
    summary: `已联网补充美国宏观指标：${[
      fredIndicatorText(fedFunds),
      fredIndicatorText(tenYear),
      fredIndicatorText(curve),
      cpi ? `${cpi.label} ${cpi.value}（${cpi.date}，${cpi.source}）` : "",
      fredIndicatorText(unemployment)
    ].filter(Boolean).join("；")}。`,
    monetaryPolicy: fedFunds
      ? `联邦基金有效利率为 ${fedFunds.value}%（${fedFunds.date}，FRED），用于判断短端政策利率约束。`
      : "未能取得联邦基金有效利率。",
    liquidity: curve
      ? `10年-2年美债期限利差为 ${curve.value}pct（${curve.date}，FRED），可作为收益率曲线和流动性压力的背景变量。`
      : "未能取得收益率曲线指标。",
    demandEnvironment: [unemployment, cpi]
      .filter(Boolean)
      .map((item) => `${item.label} ${item.value}（${item.date}）`)
      .join("；") || "未能取得失业率或通胀指标。",
    riskFreeRate: tenYear
      ? `10年期美国国债收益率为 ${tenYear.value}%（${tenYear.date}，FRED），可作为美股估值无风险利率背景。`
      : "未能取得10年期美国国债收益率。",
    indicators,
    failures,
    notes: [
      "FRED 指标存在发布频率和节假日滞后，不能替代实时盘口利率。",
      "宏观结论仍需结合公司行业和财报证据交叉验证。"
    ]
  };
}

async function fetchChinaMacroPolicySupplement(force = false) {
  const queries = [
    "中国 货币政策 LPR 社融 M2 PMI 2026 最新",
    "China monetary policy LPR M2 PMI credit growth 2026 latest"
  ];
  const searches = await mapLimit(queries, 2, (query) => fetchWebSearchResults(query, force, 4));
  const { webResults, failures } = flattenWebSearchResults(searches);
  return {
    status: webResults.length ? "ok" : "partial",
    source: "DuckDuckGo Lite public web search snippets",
    generatedAt: new Date().toISOString(),
    summary: webResults.length
      ? "已联网检索中国货币政策、LPR、社融、M2 和 PMI 相关公开网页摘要；AI 应把这些摘要作为待验证背景变量。"
      : "尝试联网检索中国宏观数据，但未获得可用摘要。",
    monetaryPolicy: "联网摘要见 webResults；需关注 LPR/MLF/逆回购、社融信贷和财政支出节奏。",
    liquidity: "联网摘要见 webResults；需结合社融、M2、信用利差和资本市场流动性验证。",
    demandEnvironment: "联网摘要见 webResults；需结合 PMI、出口、地产链和消费需求验证。",
    riskFreeRate: "未接入稳定的中国国债收益率结构化接口，需以外部摘要或本地配置补充。",
    queries,
    webResults,
    failures,
    notes: ["公开搜索摘要可能有滞后或噪声，不能替代央行/统计局/交易所原文。"]
  };
}

function industrySearchQueries(financials, profile = {}) {
  const year = new Date().getFullYear();
  const name = [profile.name, financials.name, financials.symbol].filter(Boolean).join(" ");
  const industry = [profile.sector, profile.industry].filter(Boolean).join(" ");
  const description = String(profile.businessDescription || "").slice(0, 160);
  const text = [industry, description].join(" ").toLowerCase();
  const queries = [];
  if (financials.market === "cn") {
    queries.push(`${financials.name || financials.symbol} ${industry} 行业景气 订单 价格 供需 ${year}`);
    queries.push(`${industry || financials.name || financials.symbol} 行业 天花板 竞争格局 需求 ${year}`);
  } else {
    queries.push(`${name} ${industry} demand pricing supply industry outlook ${year}`);
    if (/memory|dram|nand|hbm|storage|semiconductor|chip|半导体|存储|芯片/i.test(text)) {
      queries.push(`${name} DRAM NAND HBM pricing supply demand outlook ${year}`);
    } else {
      queries.push(`${industry || name} industry outlook demand supply pricing ${year}`);
    }
  }
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 3);
}

async function fetchIndustryWebSupplement(financials, profile = {}, force = false) {
  const queries = industrySearchQueries(financials, profile);
  const searches = await mapLimit(queries, 2, (query) => fetchWebSearchResults(query, force, 5));
  const { webResults, failures } = flattenWebSearchResults(searches);
  const status = webResults.length ? "ok" : "partial";
  return {
    status,
    source: "DuckDuckGo Lite public web search snippets",
    generatedAt: new Date().toISOString(),
    sector: profile.sector || "",
    industry: profile.industry || "",
    key: "web:industry-search",
    cycleStage: webResults.length
      ? "已联网检索行业公开网页摘要；AI 需要基于 webResults 中的标题、摘要、来源链接判断景气阶段，不能把搜索结果当作已验证事实。"
      : "未获得可用行业网页摘要，仍只能使用本地默认行业框架和公司财报证据。",
    ceiling: webResults.length
      ? "行业天花板和周期位置需要结合 webResults、公司财报、价格/订单/库存/产能证据交叉验证。"
      : "缺少可用联网行业上下文，无法判断行业天花板。",
    demandDrivers: webResults.map((item) => item.snippet || item.title).filter(Boolean).slice(0, 5),
    supplyConstraints: webResults
      .filter((item) => /supply|capacity|shortage|constraint|库存|供给|产能|供应/i.test(`${item.title} ${item.snippet}`))
      .map((item) => item.snippet || item.title)
      .slice(0, 5),
    risks: webResults
      .filter((item) => /risk|competition|slowdown|price|库存|风险|竞争|价格|回落/i.test(`${item.title} ${item.snippet}`))
      .map((item) => item.snippet || item.title)
      .slice(0, 5),
    queries,
    webResults,
    failures,
    notes: ["搜索摘要只作为外部上下文线索，关键结论仍需优先引用公司财报和公告原文。"]
  };
}

async function supplementExternalAnalysisContext(financials, profile, baseExternal, force = false) {
  const external = baseExternal || externalAnalysisContext(financials, profile);
  const tasks = [];
  tasks.push(
    needsWebSupplement(external.macroPolicy)
      ? financials.market === "cn"
        ? fetchChinaMacroPolicySupplement(force)
        : fetchUsMacroPolicySupplement(force)
      : Promise.resolve(null)
  );
  tasks.push(
    needsWebSupplement(external.industryView)
      ? fetchIndustryWebSupplement(financials, profile, force)
      : Promise.resolve(null)
  );
  const [macroSupplement, industrySupplement] = await Promise.all(tasks);
  return {
    ...external,
    source: macroSupplement || industrySupplement
      ? "local analysis context config + public web supplement"
      : external.source,
    generatedAt: new Date().toISOString(),
    macroPolicy: macroSupplement?.status === "ok"
      ? { ...external.macroPolicy, ...macroSupplement, baseContext: external.macroPolicy }
      : external.macroPolicy,
    industryView: industrySupplement?.status === "ok"
      ? { ...external.industryView, ...industrySupplement, baseContext: external.industryView }
      : external.industryView,
    webSupplement: {
      generatedAt: new Date().toISOString(),
      macroPolicy: macroSupplement,
      industryView: industrySupplement
    },
    missingContextPolicy:
      "若 macroPolicy 或 industryView 来自 public web supplement，可以作为联网补充证据；若仍为 partial，必须说明缺少实时原始数据，不能编造。companyOverride 为空时不能凭空判断公司竞争格局。"
  };
}

async function getFinancialCompanyContext(financials) {
  try {
    if (financials.market === "cn") {
      return await fetchAshareCompanyProfile(financials.symbol, false);
    }
    const normalized = normalizeTicker(financials.symbol);
    const tickerMap = await loadTickerMap(false);
    const company = tickerMap.get(normalized);
    let profile;
    try {
      profile = await fetchNasdaqCompanyProfile(normalized, false);
    } catch {
      // Fall back to SEC below.
    }
    if (!profile?.businessDescription && !profile?.industry && !profile?.sector) {
      profile = await fetchSecCompanyProfile(normalized, company, false);
    }
    return profile || { symbol: normalized, status: "empty" };
  } catch (error) {
    return {
      symbol: financials.symbol,
      status: "error",
      error: error.message,
      businessDescription: ""
    };
  }
}

function externalAnalysisContext(financials, profile) {
  const configuredMacro = ANALYSIS_CONTEXT.macroPolicy || {};
  const configuredIndustry = pickIndustryContext(profile);
  return {
    source: "local analysis context config",
    generatedAt: ANALYSIS_CONTEXT.generatedAt || "",
    macroPolicy: hasMeaningfulContext(configuredMacro)
      ? { source: "config/analysis-context.local.json", status: "ok", ...configuredMacro }
      : defaultMacroPolicyContext(financials),
    industryView: hasMeaningfulContext(configuredIndustry)
      ? { source: "config/analysis-context.local.json", status: "ok", ...configuredIndustry }
      : defaultIndustryContext(profile),
    companyOverride: pickCompanyOverride(financials),
    missingContextPolicy:
      "如果 macroPolicy 或 industryView 的 status 为 partial，必须说明这是默认框架而非实时外部结论；companyOverride 为空时不能凭空判断公司竞争格局。"
  };
}

function hasMeaningfulContext(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulContext);
  if (typeof value === "object") {
    return Object.entries(value).some(([key, item]) => key !== "key" && hasMeaningfulContext(item));
  }
  return Boolean(value);
}

const ANALYSIS_EVIDENCE_PATTERNS = [
  { label: "需求/订单", pattern: /(?:demand|orders?|bookings?|backlog|客户需求|订单|在手订单|需求旺盛|供不应求)/gi },
  { label: "定价权/价格", pattern: /(?:pricing|price increases?|average selling price|ASP|gross margin|价格|涨价|单价|毛利率|定价)/gi },
  { label: "竞争/壁垒", pattern: /(?:competition|competitive|competitors?|market share|moat|barrier|substitute|竞争|市占率|替代|壁垒|垄断|寡头)/gi },
  { label: "产能/供给", pattern: /(?:capacity|supply|production|inventory|utilization|产能|供给|库存|稼动率|扩产)/gi },
  { label: "客户/集中度", pattern: /(?:customer concentration|major customers?|top customers?|客户集中|前五大客户|主要客户|大客户)/gi },
  { label: "持续性/展望", pattern: /(?:guidance|outlook|expect|forecast|sustainable|visibility|展望|预计|指引|持续|可持续|确定性)/gi },
  { label: "现金流/回款", pattern: /(?:cash flow|receivables?|collection|working capital|现金流|应收|回款|营运资金)/gi }
];

function evidenceExcerpts(text, doc = {}, limit = 10) {
  const output = [];
  const seen = new Set();
  for (const item of ANALYSIS_EVIDENCE_PATTERNS) {
    item.pattern.lastIndex = 0;
    let match;
    while ((match = item.pattern.exec(text)) && output.length < limit) {
      const context = contextAround(text, match.index, match[0].length);
      const key = `${item.label}:${context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        label: item.label,
        phrase: match[0],
        context,
        form: doc.form || "",
        filingDate: doc.filingDate || "",
        url: doc.url || ""
      });
      break;
    }
    if (output.length >= limit) break;
  }
  return output;
}

function latestFilingByForms(filings = [], forms = [], options = {}) {
  const formSet = new Set(forms);
  return filings
    .filter((filing) => formSet.has(filing.form))
    .filter((filing) => !options.since || String(filing.filingDate || "") >= options.since)
    .filter((filing) => filing.primaryDocument && filing.accessionNumber)
    .sort((a, b) => String(b.filingDate || "").localeCompare(String(a.filingDate || "")))[0] || null;
}

async function secDocumentEvidence(cik, filing, category, force = false) {
  if (!filing) {
    return {
      category,
      status: "missing",
      title: category,
      reason: "未找到匹配的 SEC 文件"
    };
  }
  const url = secFilingUrl(cik, filing.accessionNumber, filing.primaryDocument);
  const base = {
    category,
    status: "ok",
    title: `${filing.form} ${filing.filingDate || ""}`,
    form: filing.form,
    filingDate: filing.filingDate || "",
    reportDate: filing.reportDate || "",
    accessionNumber: filing.accessionNumber || "",
    primaryDocument: filing.primaryDocument || "",
    url
  };
  try {
    const html = await cachedSecText(url, force, TEXT_TTL);
    const text = stripHtml(html);
    const excerpts = evidenceExcerpts(text, base);
    return {
      ...base,
      excerptCount: excerpts.length,
      excerpts,
      textSample: text.slice(0, 900)
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      reason: error.message,
      excerpts: []
    };
  }
}

async function buildUsEvidencePackage(financials, profile, force = false) {
  const normalized = normalizeTicker(financials.symbol);
  const tickerMap = await loadTickerMap(force);
  const company = tickerMap.get(normalized);
  if (!company?.cik) {
    return {
      coverage: [
        { category: "companyProfile", status: profile?.status === "ok" ? "ok" : "partial", title: "公司资料" },
        { category: "secFilings", status: "failed", title: "SEC 文件", reason: "未找到 CIK，无法拉取 SEC 文件" }
      ],
      documents: [],
      failures: [{ category: "secFilings", reason: "未找到 CIK" }]
    };
  }
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPad(company.cik)}.json`;
  const submissions = await cachedSecJson(submissionsUrl, force, PROFILE_TTL);
  const filings = zipFilings(submissions.filings?.recent);
  const latestReport = latestFilingByForms(filings, ["10-Q", "10-K", "20-F", "40-F"]);
  const prospectus = latestFilingByForms(filings, ["S-1", "S-1/A", "F-1", "F-1/A", "424B4", "424B5"]);
  const release = latestFilingByForms(filings, ["8-K", "6-K"], { since: addDays(new Date(), -240).toISOString().slice(0, 10) });
  const documents = await mapLimit(
    [
      { filing: latestReport, category: "financialReport" },
      { filing: prospectus, category: "prospectus" },
      { filing: release, category: "earningsRelease" }
    ],
    2,
    (item) => secDocumentEvidence(company.cik, item.filing, item.category, force)
  );
  const coverage = [
    {
      category: "companyProfile",
      status: profile?.businessDescription ? "ok" : "partial",
      title: "公司主营/行业资料",
      source: profile?.profileSource || "",
      reason: profile?.businessDescription ? "" : "公司简介较少，产品和竞争格局证据不足"
    },
    ...documents.map((doc) => ({
      category: doc.category,
      status: doc.status,
      title: doc.title,
      url: doc.url || "",
      reason: doc.reason || "",
      excerptCount: doc.excerptCount || 0
    }))
  ];
  return {
    source: "SEC submissions primary documents",
    coverage,
    documents,
    failures: coverage.filter((item) => item.status !== "ok")
  };
}

async function fetchAshareNoticesForEvidence(code, secucode, force = false) {
  const end = toDateOnly(new Date());
  const begin = "2000-01-01";
  const pageSize = 100;
  const first = await cachedEastmoneyJson(
    eastmoneyAnnouncementUrl({
      page_size: String(pageSize),
      page_index: "1",
      stock_list: code,
      begin_time: begin,
      end_time: end
    }),
    force,
    PROFILE_TTL
  );
  const notices = [...(first?.data?.list || [])];
  const total = Number(first?.data?.total_hits || notices.length);
  const pageCount = Math.min(Math.ceil(total / pageSize), 12);
  if (pageCount > 1) {
    const pages = await mapLimit(
      Array.from({ length: pageCount - 1 }, (_, index) => index + 2),
      3,
      (pageIndex) =>
        cachedEastmoneyJson(
          eastmoneyAnnouncementUrl({
            page_size: String(pageSize),
            page_index: String(pageIndex),
            stock_list: code,
            begin_time: begin,
            end_time: end
          }),
          force,
          PROFILE_TTL
        )
    );
    for (const page of pages) notices.push(...(page?.data?.list || []));
  }
  return notices
    .filter((notice) => (notice.codes || []).some((item) => String(item.stock_code || "").slice(0, 6) === code))
    .map((notice) => ({
      ...notice,
      secucode
    }));
}

function ashareEvidenceDoc(notices, category, pattern) {
  const notice = notices
    .filter((item) => pattern.test(ashareNoticeText(item)))
    .sort((a, b) => String(b.notice_date || b.display_time || "").localeCompare(String(a.notice_date || a.display_time || "")))[0];
  if (!notice) {
    return {
      category,
      status: "missing",
      title: category,
      reason: "未在东方财富公告列表中找到匹配公告"
    };
  }
  const artCode = notice.art_code;
  return {
    category,
    status: "partial",
    title: notice.title_ch || notice.title || category,
    filingDate: ashareDate(notice.notice_date || notice.display_time || notice.sort_date),
    url: ashareReportPdfUrl(artCode),
    noticePageUrl: ashareNoticePageUrl(artCode),
    reason: "已获取公告链接，当前版本暂未解析 PDF 正文",
    excerpts: []
  };
}

async function buildAshareEvidencePackage(financials, profile, force = false) {
  const code = normalizeTicker(financials.symbol).slice(0, 6);
  const secucode = code.startsWith("6") ? `${code}.SH` : code.startsWith("8") || code.startsWith("9") ? `${code}.BJ` : `${code}.SZ`;
  let notices = [];
  try {
    notices = await fetchAshareNoticesForEvidence(code, secucode, force);
  } catch (error) {
    return {
      source: "东方财富公告列表",
      coverage: [
        { category: "companyProfile", status: profile?.businessDescription ? "ok" : "partial", title: "公司主营/行业资料" },
        { category: "announcements", status: "failed", title: "公告列表", reason: error.message }
      ],
      documents: [],
      failures: [{ category: "announcements", reason: error.message }]
    };
  }
  const documents = [
    ashareEvidenceDoc(notices, "financialReport", /(?:年度报告|一季度报告|半年度报告|三季度报告)(?!摘要)|报告全文/),
    ashareEvidenceDoc(notices, "prospectus", /招股说明书/),
    ashareEvidenceDoc(notices, "investorRelations", /投资者关系活动记录|调研|业绩说明会/)
  ];
  const coverage = [
    {
      category: "companyProfile",
      status: profile?.businessDescription ? "ok" : "partial",
      title: "公司主营/行业资料",
      source: profile?.profileSource || "",
      reason: profile?.businessDescription ? "" : "公司简介较少，产品和竞争格局证据不足"
    },
    ...documents.map((doc) => ({
      category: doc.category,
      status: doc.status,
      title: doc.title,
      url: doc.url || doc.noticePageUrl || "",
      reason: doc.reason || ""
    }))
  ];
  return {
    source: "东方财富公告列表",
    coverage,
    documents,
    failures: coverage.filter((item) => item.status !== "ok")
  };
}

async function buildAnalysisEvidencePackage(financials, profile, force = false, externalContext = null) {
  const external = externalContext || externalAnalysisContext(financials, profile);
  const packagePayload =
    financials.market === "cn"
      ? await buildAshareEvidencePackage(financials, profile, force)
      : await buildUsEvidencePackage(financials, profile, force);
  const macroStatus = hasMeaningfulContext(external.macroPolicy)
    ? external.macroPolicy.status === "partial"
      ? "partial"
      : "ok"
    : "missing";
  const industryStatus = hasMeaningfulContext(external.industryView)
    ? external.industryView.status === "partial"
      ? "partial"
      : "ok"
    : "missing";
  const macroCoverage = {
    category: "macroPolicy",
    status: macroStatus,
    title: "当前经济/货币政策上下文",
    source: external.macroPolicy?.source || "",
    reason: macroStatus === "ok"
      ? ""
      : macroStatus === "partial"
        ? "未填写本地宏观配置，已使用默认分析框架；不能替代实时政策和利率数据"
      : "config/analysis-context.local.json 未填写宏观和货币政策，AI 不能凭空判断"
  };
  const industryCoverage = {
    category: "industryContext",
    status: industryStatus,
    title: "行业景气/天花板上下文",
    source: external.industryView?.source || "",
    reason: industryStatus === "ok"
      ? ""
      : industryStatus === "partial"
        ? "未匹配本地行业配置，已根据行业/主营生成默认框架；不能替代实时价格、订单和库存数据"
      : "config/analysis-context.local.json 未匹配到行业上下文，AI 只能基于财务和公司资料判断"
  };
  return {
    ...packagePayload,
    coverage: [...(packagePayload.coverage || []), macroCoverage, industryCoverage],
    failures: [...(packagePayload.failures || []), macroCoverage, industryCoverage].filter((item) => item.status !== "ok")
  };
}

function compactAnalysisText(value, maxLength = 420) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function compactWebResultForAnalysis(result = {}) {
  return {
    title: compactAnalysisText(result.title, 160),
    url: result.url || "",
    snippet: compactAnalysisText(result.snippet, 260),
    source: result.source || "",
    query: compactAnalysisText(result.query, 140)
  };
}

function compactEvidencePackageForAnalysis(packagePayload = {}) {
  return {
    ...packagePayload,
    coverage: Array.isArray(packagePayload.coverage) ? packagePayload.coverage : [],
    failures: Array.isArray(packagePayload.failures) ? packagePayload.failures : [],
    documents: (Array.isArray(packagePayload.documents) ? packagePayload.documents : []).map((doc) => ({
      ...doc,
      textSample: compactAnalysisText(doc.textSample, 360),
      excerpts: (Array.isArray(doc.excerpts) ? doc.excerpts : []).slice(0, 6).map((excerpt) => ({
        ...excerpt,
        context: compactAnalysisText(excerpt.context, 360)
      }))
    }))
  };
}

function compactExternalContextSection(section = {}) {
  if (!section || typeof section !== "object") return section || {};
  return {
    ...section,
    summary: compactAnalysisText(section.summary, 520),
    monetaryPolicy: compactAnalysisText(section.monetaryPolicy, 420),
    liquidity: compactAnalysisText(section.liquidity, 420),
    demandEnvironment: compactAnalysisText(section.demandEnvironment, 420),
    riskFreeRate: compactAnalysisText(section.riskFreeRate, 300),
    cycleStage: compactAnalysisText(section.cycleStage, 520),
    ceiling: compactAnalysisText(section.ceiling, 420),
    demandDrivers: (Array.isArray(section.demandDrivers) ? section.demandDrivers : []).slice(0, 5).map((item) => compactAnalysisText(item, 240)),
    supplyConstraints: (Array.isArray(section.supplyConstraints) ? section.supplyConstraints : []).slice(0, 5).map((item) => compactAnalysisText(item, 240)),
    risks: (Array.isArray(section.risks) ? section.risks : []).slice(0, 5).map((item) => compactAnalysisText(item, 240)),
    notes: (Array.isArray(section.notes) ? section.notes : []).slice(0, 5).map((item) => compactAnalysisText(item, 220)),
    webResults: (Array.isArray(section.webResults) ? section.webResults : []).slice(0, 4).map(compactWebResultForAnalysis)
  };
}

function compactExternalContextForAnalysis(externalContext = {}) {
  return {
    ...externalContext,
    macroPolicy: compactExternalContextSection(externalContext.macroPolicy),
    industryView: compactExternalContextSection(externalContext.industryView),
    companyOverride: compactExternalContextSection(externalContext.companyOverride),
    webSupplement: externalContext.webSupplement
      ? {
          generatedAt: externalContext.webSupplement.generatedAt || "",
          macroPolicy: compactExternalContextSection(externalContext.webSupplement.macroPolicy),
          industryView: compactExternalContextSection(externalContext.webSupplement.industryView)
        }
      : undefined
  };
}

function stableAnalysisInputForHash(value) {
  if (Array.isArray(value)) return value.map(stableAnalysisInputForHash);
  if (!value || typeof value !== "object") return value;
  const volatileKeys = new Set(["cache", "generatedAt", "sourceUpdatedAt"]);
  return Object.keys(value)
    .sort()
    .reduce((output, key) => {
      if (volatileKeys.has(key)) return output;
      output[key] = stableAnalysisInputForHash(value[key]);
      return output;
    }, {});
}

function buildFinancialAnalysisContext(financials, extras = {}) {
  const quarterlyPoints = Array.isArray(financials.quarterly) ? financials.quarterly : [];
  const annualPoints = Array.isArray(financials.annual) ? financials.annual : [];
  const metricList = Array.isArray(financials.metrics) && financials.metrics.length ? financials.metrics : FINANCIAL_METRICS;
  const sourcePoints = quarterlyPoints.length ? quarterlyPoints : annualPoints;
  const points = sortFinancialPoints(sourcePoints);
  const annual = sortFinancialPoints(annualPoints);
  const metricMap = Object.fromEntries(metricList.map((metric) => [metric.key, metric]));
  const selectedPoints = points.slice(-16);
  const periodRows = selectedPoints.map((point) => {
    const metrics = {};
    for (const key of LLM_ANALYSIS_METRIC_KEYS) {
      metrics[key] = valueObjectForAnalysis(point, key, financials, metricMap);
    }
    return {
      period: financialPointLabel(point),
      reportDate: point.date || "",
      sourcePeriodType: point.sourcePeriodType || "",
      derivation: point.derivation || "",
      metrics
    };
  });
  return {
    company: {
      market: financials.market,
      symbol: financials.symbol,
      name: financials.name,
      currency: financials.currency,
      displayUnit: financials.unitLabel,
      profile: {
        name: extras.profile?.name || "",
        chineseName: extras.profile?.chineseName || "",
        sector: extras.profile?.sector || "",
        industry: extras.profile?.industry || "",
        region: extras.profile?.region || "",
        marketCap: extras.profile?.marketCap || "",
        businessDescription: extras.profile?.businessDescription || "",
        profileSource: extras.profile?.profileSource || "",
        status: extras.profile?.status || ""
      }
    },
    generatedAt: new Date().toISOString(),
    source: financials.source,
    sourceUpdatedAt: financials.generatedAt,
    periodType: quarterlyPoints.length ? "quarterly" : "annual",
    latestPeriod: financialPointLabel(points[points.length - 1]),
    accuracyNotes: financials.accuracyNotes || [],
    requiredRules: [
      "只能基于本 JSON 中的 raw/display 数值、period 和 accuracyNotes 做分析。",
      "商业质量分析必须基于 company.profile、evidencePackage、externalContext.companyOverride、财务指标之间的交叉验证；没有证据时必须写无法判断。",
      "当前经济、货币政策和行业景气天花板只能基于 externalContext.macroPolicy 与 externalContext.industryView；未提供时不能编造。",
      "如果 externalContext.macroPolicy 或 industryView 的 status 为 partial，必须把结论表述为分析框架或待验证变量，不能表述为实时确定结论。",
      "如果 evidencePackage.coverage 中某类资料为 missing、partial 或 failed，相关结论必须降级为证据不足，并在 dataQuality 或对应章节说明还缺什么。",
      "缺失值为 null 时必须说明无法判断，不能补全或猜测。",
      "A股 flow 指标如标注 single-quarter，表示已经从累计值差分为单季值；stock 指标为期末余额。",
      "美股季度数据只包含 SEC companyfacts 明确季度 frame 的事实。"
    ],
    externalContext: compactExternalContextForAnalysis(extras.externalContext || {}),
    evidencePackage: compactEvidencePackageForAnalysis(extras.evidencePackage || {}),
    metrics: LLM_ANALYSIS_METRIC_KEYS.map((key) => metricSnapshotForAnalysis(points, key, financials, metricMap)),
    periods: periodRows,
    annualReference: annual.slice(-6).map((point) => ({
      period: financialPointLabel(point),
      reportDate: point.date || "",
      revenue: valueObjectForAnalysis(point, "revenue", financials, metricMap),
      netIncome: valueObjectForAnalysis(point, "netIncome", financials, metricMap),
      operatingCashFlow: valueObjectForAnalysis(point, "operatingCashFlow", financials, metricMap),
      debtAssetRatio: valueObjectForAnalysis(point, "debtAssetRatio", financials, metricMap)
    }))
  };
}

function financialAnalysisResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "overall",
      "growth",
      "profitability",
      "cashFlow",
      "balanceSheet",
      "productMoat",
      "pricingPower",
      "durability",
      "macroPolicy",
      "industryCeiling",
      "growthCertainty",
      "risks",
      "watchItems",
      "dataQuality",
      "disclaimer"
    ],
    properties: {
      summary: { type: "string" },
      overall: { type: "string" },
      growth: { type: "array", items: { type: "string" } },
      profitability: { type: "array", items: { type: "string" } },
      cashFlow: { type: "array", items: { type: "string" } },
      balanceSheet: { type: "array", items: { type: "string" } },
      productMoat: { type: "array", items: { type: "string" } },
      pricingPower: { type: "array", items: { type: "string" } },
      durability: { type: "array", items: { type: "string" } },
      macroPolicy: { type: "array", items: { type: "string" } },
      industryCeiling: { type: "array", items: { type: "string" } },
      growthCertainty: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      watchItems: { type: "array", items: { type: "string" } },
      dataQuality: { type: "array", items: { type: "string" } },
      disclaimer: { type: "string" }
    }
  };
}

function extractOpenAiText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function parseAnalysisJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("分析结果为空");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch?.[0]) return JSON.parse(objectMatch[0]);
    throw new Error("分析结果不是有效 JSON");
  }
}

function isExecutableFile(filePath) {
  try {
    return fsSync.statSync(filePath).isFile() && fsSync.accessSync(filePath, fsSync.constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

function commandHasPath(command) {
  return String(command || "").includes("/") || String(command || "").includes("\\");
}

function executableFromPath(command, extraDirs = []) {
  if (!command || commandHasPath(command)) return "";
  const dirs = [...new Set([...(process.env.PATH || "").split(path.delimiter), ...extraDirs].filter(Boolean))];
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return "";
}

function codexCommandCandidates() {
  return [
    executableFromPath("codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(process.env.HOME || "", ".local/bin/codex"),
    path.join(process.env.HOME || "", ".codex/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ].filter(Boolean);
}

function resolveCodexCommand(command = CODEX_COMMAND) {
  const configured = String(command || "codex").trim() || "codex";
  if (commandHasPath(configured)) return configured;
  const fromPath = executableFromPath(configured);
  if (fromPath) return fromPath;
  if (configured === "codex") {
    const candidate = codexCommandCandidates().find(isExecutableFile);
    if (candidate) return candidate;
  }
  return configured;
}

function codexCommandSetupHint(command = CODEX_COMMAND) {
  const candidate = codexCommandCandidates().find(isExecutableFile);
  if (candidate) {
    return `无法启动 Codex CLI：找不到命令 ${command}。可以把 config/ai.local.json 里的 codex.command 改为绝对路径：${candidate}`;
  }
  return `无法启动 Codex CLI：找不到命令 ${command}。请先安装 Codex CLI，或在 config/ai.local.json 的 codex.command 填写可执行文件绝对路径。`;
}

function spawnWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Codex 分析超时，已超过 ${(options.timeoutMs || CODEX_TIMEOUT_MS) / 1000} 秒`));
    }, options.timeoutMs || CODEX_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT" && options.enoentHint) {
        finish(new Error(options.enoentHint));
        return;
      }
      finish(error);
    });
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        finish(new Error(`Codex exec 失败，退出码 ${code}: ${err || out}`));
        return;
      }
      finish(null, { stdout: out, stderr: err });
    });
    child.stdin.end(input);
  });
}

async function fetchOpenAiResponse(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function callCodexFinancialAnalysis(context) {
  await ensureCacheDir();
  const inputHash = hashKey(JSON.stringify(context));
  const schemaFile = path.join(CACHE_DIR, "financial-analysis.schema.json");
  const outputFile = path.join(CACHE_DIR, `codex-financial-analysis-${inputHash}-${Date.now()}.json`);
  await fs.writeFile(schemaFile, JSON.stringify(financialAnalysisResponseSchema(), null, 2));
  const prompt = [
    "你是严谨的财务报表分析助手。",
    "这是只读分析任务：不要修改文件，不要运行命令，不要联网检索，不要给买卖建议或目标价。",
    "只能基于下面 JSON 中的结构化财务数据、evidencePackage、period、raw/display 数值和 accuracyNotes 做分析。",
    "必须额外分析：产品或服务是否有垄断性/寡头格局/替代风险，是否有定价权，业绩持续性，当前经济与货币政策约束，行业景气天花板，以及业绩增速确定性。",
    "产品壁垒和定价权需要结合 company.profile、evidencePackage.documents/excerpts、毛利/经营利润/现金流、应收/存货/合同负债等证据；证据不足必须写无法判断。",
    "当前经济、货币政策、行业天花板只允许引用 externalContext 中提供的信息；没有提供就写缺少实时外部上下文，不能凭空判断。",
    "externalContext 可能包含服务端预先联网抓取的 FRED 指标和 DuckDuckGo Lite 搜索摘要；引用时必须说明来源和日期，搜索摘要只能作为线索，不能当作已验证事实。",
    "如果 externalContext.macroPolicy 或 industryView 的 status 为 partial，必须明确这是默认框架或待验证变量，不能当作实时宏观/行业结论。",
    "缺失值为 null 时必须说明无法判断，不能补全或猜测。",
    "请用中文输出，并严格返回符合 output schema 的 JSON。",
    "",
    JSON.stringify(context)
  ].join("\n");
  const args = [
    "exec",
    "--cd",
    ROOT,
    "--sandbox",
    CODEX_SANDBOX,
    "--ephemeral",
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outputFile,
    "--color",
    "never"
  ];
  if (CODEX_MODEL) args.push("--model", CODEX_MODEL);
  args.push("-");
  const resolvedCommand = resolveCodexCommand(CODEX_COMMAND);
  const result = await spawnWithInput(resolvedCommand, args, prompt, {
    timeoutMs: CODEX_TIMEOUT_MS,
    enoentHint: codexCommandSetupHint(CODEX_COMMAND)
  });
  let output = "";
  try {
    output = await fs.readFile(outputFile, "utf8");
  } catch {
    output = result.stdout;
  }
  return parseAnalysisJson(output);
}

async function callFinancialAnalysisModel(context) {
  const body = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "你是严谨的财务报表分析助手。必须用中文输出，只能分析用户提供的结构化财务数据和外部上下文。不得给出买入、卖出、目标价或保证性结论。"
      },
      {
        role: "user",
        content:
          "请基于下面 JSON 分析公司的季度财务表现、产品壁垒、定价权、持续性、宏观货币政策影响、行业景气天花板和业绩增速确定性。所有财务结论都必须引用具体报告期和具体数值；商业质量和宏观行业结论必须引用 company.profile、evidencePackage 或 externalContext。externalContext 可能包含服务端预先联网抓取的 FRED 指标和 DuckDuckGo Lite 搜索摘要；引用时必须说明来源和日期，搜索摘要只能作为线索，不能当作已验证事实。缺失值、资料缺失或缺少上下文必须说明无法判断，并指出还需要哪类资料。请返回符合 schema 的 JSON。\n\n" +
          JSON.stringify(context)
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "financial_statement_analysis",
        strict: true,
        schema: financialAnalysisResponseSchema()
      }
    },
    max_output_tokens: 1800
  };
  const response = await fetchOpenAiResponse(body);
  const text = extractOpenAiText(response);
  if (!text) throw new Error("OpenAI 返回为空");
  return JSON.parse(text);
}

async function callConfiguredFinancialAnalysisProvider(context) {
  if (ANALYSIS_PROVIDER === "codex") {
    return {
      provider: "codex",
      model: CODEX_MODEL || "codex default",
      analysis: await callCodexFinancialAnalysis(context)
    };
  }
  if (ANALYSIS_PROVIDER === "openai") {
    if (!OPENAI_API_KEY) {
      return {
        disabled: true,
        message: "未配置 OpenAI API Key。可在 config/ai.local.json 的 openai.apiKey 中填写，或启动服务时设置 OPENAI_API_KEY。",
        setup: "也可以把 analysisProvider 改成 codex，使用本地 Codex CLI 分析。"
      };
    }
    return {
      provider: "openai",
      model: OPENAI_MODEL,
      analysis: await callFinancialAnalysisModel(context)
    };
  }
  return {
    disabled: true,
    message: `未知 AI 分析 provider：${ANALYSIS_PROVIDER}`,
    setup: "请在 config/ai.local.json 中设置 analysisProvider 为 codex 或 openai。"
  };
}

async function getFinancialLlmAnalysis(market, symbol, force = false) {
  const financials = await getFinancials(market, symbol, false);
  const profile = await getFinancialCompanyContext(financials);
  const externalContext = await supplementExternalAnalysisContext(
    financials,
    profile,
    externalAnalysisContext(financials, profile),
    force
  );
  const evidencePackage = await buildAnalysisEvidencePackage(financials, profile, force, externalContext);
  const context = buildFinancialAnalysisContext(financials, {
    profile,
    externalContext,
    evidencePackage
  });
  const inputHash = hashKey(JSON.stringify(stableAnalysisInputForHash(context)));
  const cacheName = `llm-financial-analysis-v2-${ANALYSIS_PROVIDER}-${market}-${normalizeTicker(symbol) || symbol}-${inputHash}.json`;
  if (!force) {
    const cached = await readCache(cacheName, LLM_ANALYSIS_TTL);
    if (cached) return { ...cached, cache: "hit" };
  }
  const providerResult = await callConfiguredFinancialAnalysisProvider(context);
  if (providerResult.disabled) {
    return {
      status: "disabled",
      provider: ANALYSIS_PROVIDER,
      generatedAt: new Date().toISOString(),
      message: providerResult.message,
      setup: providerResult.setup
    };
  }
  const payload = {
    status: "ok",
    provider: providerResult.provider,
    model: providerResult.model,
    generatedAt: new Date().toISOString(),
    inputHash,
    market,
    symbol: financials.symbol,
    name: financials.name,
    latestPeriod: context.latestPeriod,
    periodType: context.periodType,
    source: financials.source,
    accuracyNotes: financials.accuracyNotes || [],
    evidencePackage,
    analysis: providerResult.analysis,
    cache: "fresh"
  };
  await writeCache(cacheName, payload);
  return payload;
}

async function getChineseTranslation(text, force = false) {
  const translation = await translateToChinese(text, force);
  return {
    generatedAt: new Date().toISOString(),
    ...translation
  };
}

function emitProgress(progress, stage, message, detail = {}) {
  if (typeof progress === "function") progress({ stage, message, detail });
}

async function getCalendarSymbolsForRange(range, force = false, diagnostics = null, progress = null) {
  const days = dateRange(range.start, range.today);
  const dayResults = [];
  const batchSize = 10;
  for (let index = 0; index < days.length; index += batchSize) {
    const batch = days.slice(index, index + batchSize);
    emitProgress(
      progress,
      "calendar",
      `读取 Nasdaq 财报日历 ${Math.min(index + batch.length, days.length)}/${days.length} 天`,
      { completedDays: index, totalDays: days.length, from: batch[0], to: batch[batch.length - 1] }
    );
    const batchResults = await mapLimit(batch, 5, (date) => fetchCalendarDay(date, force));
    dayResults.push(...batchResults);
  }
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

function nextAshareReportInfo(reportDate) {
  const value = ashareDate(reportDate);
  const year = Number(value.slice(0, 4));
  if (!year) return ashareReportInfo();
  if (value.endsWith("-03-31")) return { date: `${year}-06-30`, label: `${year} 半年报` };
  if (value.endsWith("-06-30")) return { date: `${year}-09-30`, label: `${year} 三季报` };
  if (value.endsWith("-09-30")) return { date: `${year}-12-31`, label: `${year} 年报` };
  return { date: `${year + 1}-03-31`, label: `${year + 1} 一季报` };
}

function ashareDate(value) {
  return String(value || "").slice(0, 10);
}

function ashareAppointmentDate(row) {
  return (
    ashareDate(row?.APPOINT_PUBLISH_DATE) ||
    ashareDate(row?.THIRD_CHANGE_DATE) ||
    ashareDate(row?.SECOND_CHANGE_DATE) ||
    ashareDate(row?.FIRST_CHANGE_DATE) ||
    ashareDate(row?.FIRST_APPOINT_DATE) ||
    ashareDate(row?.ACTUAL_PUBLISH_DATE)
  );
}

function ashareForecastNoticeDate(row) {
  return ashareDate(row?.NOTICE_DATE || row?.display_time || row?.date);
}

function ashareForecastReportDate(row) {
  return ashareDate(row?.REPORT_DATE || row?.REPORTDATE || row?.reportDate);
}

function ashareForecastGroupKey(row) {
  return `${String(row?.SECURITY_CODE || "").slice(0, 6)}:${ashareForecastNoticeDate(row)}:${ashareForecastReportDate(row)}`;
}

function ashareForecastPriority(row) {
  const financeCode = String(row?.PREDICT_FINANCE_CODE || "");
  const financeName = String(row?.PREDICT_FINANCE || "");
  if (financeCode === "004" || /归属于上市公司股东的净利润/.test(financeName)) return 0;
  if (financeCode === "005" || /扣除非经常性损益/.test(financeName)) return 1;
  if (financeCode === "003" || /每股收益/.test(financeName)) return 2;
  return 3;
}

function groupAshareForecastRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = ashareForecastGroupKey(row);
    const existing = groups.get(key);
    if (!existing || ashareForecastPriority(row) < ashareForecastPriority(existing)) {
      groups.set(key, row);
    }
  }
  return [...groups.values()].sort((a, b) => {
    const dateDiff = String(ashareForecastNoticeDate(a)).localeCompare(String(ashareForecastNoticeDate(b)));
    if (dateDiff !== 0) return dateDiff;
    return String(a.SECURITY_CODE || "").localeCompare(String(b.SECURITY_CODE || ""));
  });
}

function isAsharePerformanceNotice(notice) {
  const title = String(notice?.title_ch || notice?.title || "");
  const columns = (notice?.columns || []).map((column) => column.column_name).join(",");
  return /业绩预告|业绩快报/.test(`${title} ${columns}`);
}

async function fetchAsharePerformanceNoticeMap(rows = [], force = false) {
  const groups = new Map();
  for (const row of rows) {
    const code = String(row.SECURITY_CODE || "").slice(0, 6);
    const noticeDate = ashareForecastNoticeDate(row);
    const reportDate = ashareForecastReportDate(row);
    if (!code || !noticeDate) continue;
    const key = `${code}:${noticeDate}:${reportDate}`;
    if (!groups.has(key)) groups.set(key, { code, noticeDate, reportDate });
  }
  const entries = await mapLimit([...groups.values()], 4, async (item) => {
    const noticeDate = parseDate(item.noticeDate);
    const beginDate = noticeDate ? toDateOnly(addDays(noticeDate, -1)) : item.noticeDate;
    const payload = await cachedEastmoneyJson(
      eastmoneyAnnouncementUrl({
        page_size: "30",
        page_index: "1",
        stock_list: item.code,
        begin_time: beginDate,
        end_time: item.noticeDate
      }),
      force,
      CALENDAR_TTL
    );
    const notice = (payload?.data?.list || [])
      .filter(isAsharePerformanceNotice)
      .sort((a, b) => String(b.display_time || b.notice_date || "").localeCompare(String(a.display_time || a.notice_date || "")))[0];
    if (!notice) return null;
    const artCode = notice.art_code || "";
    return {
      key: `${item.code}:${item.noticeDate}:${item.reportDate}`,
      title: notice.title_ch || notice.title || "",
      displayTime: notice.display_time || notice.notice_date || "",
      displayDate: ashareDate(notice.display_time || notice.notice_date),
      noticeDate: ashareDate(notice.notice_date),
      noticePageUrl: artCode ? ashareNoticePageUrl(artCode) : "",
      pdfUrl: artCode ? ashareReportPdfUrl(artCode) : "",
      columns: (notice.columns || []).map((column) => column.column_name)
    };
  });
  return new Map(entries.filter(Boolean).map((entry) => [entry.key, entry]));
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

async function getNextAshareAppointmentMap(symbols, currentReportDate, force = false) {
  const normalizedSymbols = [
    ...new Set((symbols || []).map((symbol) => String(symbol || "").replace(/\D/g, "").slice(0, 6)).filter(Boolean))
  ].sort();
  const nextReport = nextAshareReportInfo(currentReportDate);
  const cacheName = `ashare-next-appointments-v1-${nextReport.date}.json`;
  if (!force) {
    const cached = await readCache(cacheName, NEXT_EARNINGS_TTL);
    if (cached) {
      return {
        ...cached,
        cache: "hit",
        stats: {
          ...(cached.stats || {}),
          apiCalls: 0,
          cachedApiCalls: cached.stats?.apiCalls || 0
        }
      };
    }
  }

  const result = await fetchEastmoneyPagedWithStats(
    "RPT_PUBLIC_BS_APPOIN",
    {
      pageSize: "500",
      sortColumns: "FIRST_APPOINT_DATE,SECURITY_CODE",
      sortTypes: "1,1",
      filter: `(REPORT_DATE='${nextReport.date}')`
    },
    force,
    NEXT_EARNINGS_TTL
  );
  const wanted = new Set(normalizedSymbols);
  const bySymbol = {};
  for (const row of result.rows.filter(isAshareRow)) {
    const symbol = String(row.SECURITY_CODE || "").slice(0, 6);
    if (!symbol || (wanted.size && !wanted.has(symbol))) continue;
    const date = ashareAppointmentDate(row);
    bySymbol[symbol] = {
      date,
      reportDate: ashareDate(row.REPORT_DATE),
      label: row.REPORT_TYPE_NAME || nextReport.label,
      firstAppointmentDate: ashareDate(row.FIRST_APPOINT_DATE),
      firstChangeDate: ashareDate(row.FIRST_CHANGE_DATE),
      secondChangeDate: ashareDate(row.SECOND_CHANGE_DATE),
      thirdChangeDate: ashareDate(row.THIRD_CHANGE_DATE),
      actualPublishDate: ashareDate(row.ACTUAL_PUBLISH_DATE),
      source: "东方财富预约披露时间",
      status: row.IS_PUBLISH === "1" ? "published" : "scheduled",
      url: `https://data.eastmoney.com/bbsj/yysj/${symbol}.html`
    };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    reportDate: nextReport.date,
    label: nextReport.label,
    bySymbol,
    missing: normalizedSymbols.filter((symbol) => !bySymbol[symbol]),
    stats: {
      source: "东方财富 RPT_PUBLIC_BS_APPOIN",
      method: "next report appointment table",
      reportDate: nextReport.date,
      reportLabel: nextReport.label,
      apiCalls: result.apiCalls,
      pages: result.pages,
      totalRows: result.rows.length,
      requestedSymbols: normalizedSymbols.length,
      matchedSymbols: Object.keys(bySymbol).length
    }
  };
  await writeCache(cacheName, payload);
  return { ...payload, cache: "fresh" };
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

function ashareReportPdfUrl(artCode) {
  return `https://pdf.dfcfw.com/pdf/H2_${encodeURIComponent(artCode)}_1.pdf`;
}

function ashareNoticePageUrl(artCode) {
  return `https://np-info.eastmoney.com/wap/notice/?infocode=${encodeURIComponent(artCode)}`;
}

function ashareNoticeInput(item) {
  const filing = item?.filing || {};
  const code = String(item?.SECURITY_CODE || item?.symbol || "").slice(0, 6);
  const secucode = item?.SECUCODE || filing.accessionNumber || item?.secucode || "";
  const filingDate = ashareDate(
    item?.NOTICE_DATE ||
      item?.ACTUAL_PUBLISH_DATE ||
      item?.APPOINT_PUBLISH_DATE ||
      filing.filingDate ||
      item?.filingDate ||
      item?.date
  );
  const reportDate = ashareDate(item?.REPORTDATE || item?.REPORT_DATE || filing.reportDate || item?.reportDate);
  if (!code || !filingDate) return null;
  return { code, secucode, filingDate, reportDate };
}

function ashareNoticeKey(item) {
  const input = ashareNoticeInput(item);
  if (!input) return "";
  return `${input.code}:${input.filingDate}:${input.reportDate || ""}`;
}

function ashareReportPeriodPattern(reportDate) {
  const value = ashareDate(reportDate);
  const monthDay = value.slice(5);
  if (monthDay === "03-31") return /(?:一季度|第一季度|1季度|一季报|Q1)[^，。；;:：]{0,12}报告/i;
  if (monthDay === "06-30") return /(?:半年度|中期|半年报)[^，。；;:：]{0,12}报告/i;
  if (monthDay === "09-30") return /(?:三季度|第三季度|3季度|三季报|Q3)[^，。；;:：]{0,12}报告/i;
  if (monthDay === "12-31") return /(?:年度|年报)[^，。；;:：]{0,12}报告/i;
  return /(?:季度|半年度|年度|季报|年报)[^，。；;:：]{0,12}报告/i;
}

function ashareNoticeText(notice) {
  return [
    notice?.title,
    notice?.title_ch,
    ...(notice?.columns || []).map((column) => column.column_name)
  ]
    .filter(Boolean)
    .join(" ");
}

function scoreAshareReportNotice(notice, input) {
  const text = ashareNoticeText(notice);
  if (!text || !notice?.art_code) return null;
  if (/业绩预告|业绩快报|业绩说明会|主要经营数据|问询函|回复|摘要取消|更正|修订|临时公告|提示性公告/.test(text)) {
    return null;
  }
  const periodPattern = ashareReportPeriodPattern(input.reportDate);
  if (!periodPattern.test(text)) return null;

  const noticeDate = ashareDate(notice.notice_date || notice.display_time || notice.sort_date);
  if (input.filingDate && noticeDate && noticeDate !== input.filingDate) return null;

  let score = 0;
  if (noticeDate === input.filingDate) score += 50;
  const reportYear = String(input.reportDate || "").slice(0, 4);
  if (reportYear && text.includes(`${reportYear}年`)) score += 20;
  if (/报告全文|年度报告全文|一季度报告全文|半年度报告全文|三季度报告全文/.test(text)) score += 10;
  if (/摘要/.test(text)) score -= 15;
  if (/英文版|英文/.test(text)) score -= 20;
  return score;
}

async function fetchAshareReportNoticeMap(items, force = false) {
  const inputs = items.map(ashareNoticeInput).filter(Boolean);
  if (!inputs.length) return new Map();

  const byCode = new Map();
  for (const input of inputs) {
    if (!byCode.has(input.code)) byCode.set(input.code, []);
    byCode.get(input.code).push(input);
  }
  const dates = inputs.map((input) => parseDate(input.filingDate)).filter(Boolean);
  if (!dates.length) return new Map();
  const beginDate = addDays(new Date(Math.min(...dates.map((date) => date.getTime()))), -1);
  const endDate = addDays(new Date(Math.max(...dates.map((date) => date.getTime()))), 1);
  const begin = toDateOnly(beginDate);
  const end = toDateOnly(endDate);
  const codes = [...byCode.keys()];
  const chunks = [];
  for (let index = 0; index < codes.length; index += 80) {
    chunks.push(codes.slice(index, index + 80));
  }

  const pages = await mapLimit(chunks, 3, async (chunk) => {
    const pageSize = 100;
    const base = {
      page_size: String(pageSize),
      stock_list: chunk.join(","),
      begin_time: begin,
      end_time: end
    };
    const first = await cachedEastmoneyJson(eastmoneyAnnouncementUrl({ ...base, page_index: "1" }), force);
    const notices = [...(first?.data?.list || [])];
    const total = Number(first?.data?.total_hits || notices.length);
    const pageCount = Math.min(Math.ceil(total / pageSize), 8);
    if (pageCount > 1) {
      const rest = await mapLimit(
        Array.from({ length: pageCount - 1 }, (_, index) => index + 2),
        3,
        (pageIndex) =>
          cachedEastmoneyJson(
            eastmoneyAnnouncementUrl({ ...base, page_index: String(pageIndex) }),
            force
          )
      );
      for (const page of rest) notices.push(...(page?.data?.list || []));
    }
    return notices;
  });

  const bestByKey = new Map();
  for (const notice of pages.flat()) {
    const noticeCodes = (notice.codes || []).map((item) => String(item.stock_code || "").slice(0, 6));
    for (const code of noticeCodes) {
      for (const input of byCode.get(code) || []) {
        const score = scoreAshareReportNotice(notice, input);
        if (score == null) continue;
        const key = `${input.code}:${input.filingDate}:${input.reportDate || ""}`;
        const current = bestByKey.get(key);
        if (current && current.score >= score) continue;
        bestByKey.set(key, {
          score,
          artCode: notice.art_code,
          title: notice.title_ch || notice.title || "",
          noticePageUrl: ashareNoticePageUrl(notice.art_code),
          pdfUrl: ashareReportPdfUrl(notice.art_code)
        });
      }
    }
  }
  return bestByKey;
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

async function scanAsharePdfSignals(row, force = false, diagnostics = null, options = {}) {
  const url = row?.filing?.url || "";
  if (!url || !url.toLowerCase().endsWith(".pdf")) {
    diagnostics?.textDocsMissing?.push({
      symbol: row?.symbol || "",
      name: row?.name || "",
      reason: "没有可扫描的 A股财报 PDF"
    });
    return [];
  }
  try {
    const text = await cachedPdfText(url, force, TEXT_TTL);
    if (!text) return [];
    return findSignals(
      text,
      {
        form: row.filing?.form || "A股财报",
        filingDate: row.filing?.filingDate || "",
        url
      },
      options.customKeywordRules || []
    );
  } catch (error) {
    diagnostics?.textScanFailures?.push({
      symbol: row?.symbol || "",
      name: row?.name || "",
      url,
      error: error.message
    });
    return [];
  }
}

function mergeTextSignalsIntoRankingRow(row, textSignals) {
  if (!textSignals.length) return row;
  const existingLabels = new Set((row.signals || []).map((signal) => signal.label));
  const appended = textSignals.filter((signal) => !existingLabels.has(signal.label));
  if (!appended.length) return row;
  row.signals = uniqueSignals([...(row.signals || []), ...appended]);
  const textSignalScore = appended.reduce((sum, signal) => sum + signal.score, 0);
  row.score = Math.min(100, Math.round(row.score + Math.min(35, textSignalScore)));
  row.highlight =
    row.highlight ||
    row.score >= 70 ||
    row.signals.length >= 2 ||
    row.signals.some((signal) =>
      ["产品供不应求", "供给偏紧", "需求旺盛", "产品价格中枢持续上涨", "行业高景气度上行"].includes(signal.label)
    );
  return row;
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
  const nextAppointments = await getNextAshareAppointmentMap(
    ranked.map((row) => row.symbol),
    reportInfo.date,
    force
  );
  for (const row of ranked) {
    row.nextEarnings =
      nextAppointments.bySymbol[row.symbol] ||
      emptyNextEarnings(
        "东方财富预约披露时间",
        `${nextAppointments.label || nextAshareReportInfo(reportInfo.date).label}预约披露时间暂未公布`
      );
    if (!row.nextEarnings.reportDate) {
      row.nextEarnings.reportDate = nextAppointments.reportDate || nextAshareReportInfo(reportInfo.date).date;
      row.nextEarnings.label = nextAppointments.label || nextAshareReportInfo(reportInfo.date).label;
    }
  }
  const noticeMap = await fetchAshareReportNoticeMap(ranked, force);
  for (const row of ranked) {
    const notice = noticeMap.get(ashareNoticeKey(row));
    if (!notice) continue;
    row.filing.url = notice.pdfUrl;
    row.filing.noticePageUrl = notice.noticePageUrl;
    row.filing.primaryDocument = notice.title;
    row.filing.accessionNumber = notice.artCode;
  }
  const textDiagnostics = {
    textDocsMissing: [],
    textScanFailures: []
  };
  await mapLimit(ranked, 3, async (row) => {
    const textSignals = await scanAsharePdfSignals(row, force, textDiagnostics, options);
    mergeTextSignalsIntoRankingRow(row, textSignals);
  });
  ranked.sort((a, b) => {
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
      textDocsMissing: textDiagnostics.textDocsMissing.length,
      textScanFailures: textDiagnostics.textScanFailures.length,
      analysisCacheHits: 0,
      analysisCacheMisses: ranked.length
    },
    manualCompanyMissing: manualRows.missing,
    textDocsMissing: textDiagnostics.textDocsMissing,
    textScanFailures: textDiagnostics.textScanFailures,
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
      text: "东方财富财报 PDF 正文；regex/string keyword matching，不调用大模型",
      universe: "东方财富 A股财报数据",
      nextEarnings: "东方财富 RPT_PUBLIC_BS_APPOIN 预约披露时间"
    },
    nextEarningsStats: nextAppointments.stats,
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

async function defaultAshareCalendarMonth(force = false) {
  const today = toDateOnly(new Date());
  const url = eastmoneyDataUrl("RPT_PUBLIC_BS_APPOIN", {
    pageSize: "20",
    sortColumns: "APPOINT_PUBLISH_DATE,SECURITY_CODE",
    sortTypes: "1,1",
    filter: `(APPOINT_PUBLISH_DATE>='${today}')`
  });
  try {
    const payload = await cachedEastmoneyJson(url, force, CALENDAR_TTL);
    const rows = (payload?.result?.data || []).filter(isAshareRow);
    const firstDate = rows.map(ashareAppointmentDate).find(Boolean);
    if (firstDate) return firstDate.slice(0, 7);
  } catch {
    // Fall back to the current month.
  }
  return today.slice(0, 7);
}

async function getAshareCalendar(month, force = false) {
  const normalizedMonth = month || await defaultAshareCalendarMonth(force);
  const cacheName = `ashare-calendar-v${ASHARE_CALENDAR_VERSION}-${normalizedMonth}.json`;
  if (!force) {
    const cached = await readCache(cacheName, CALENDAR_TTL);
    if (cached) return { ...cached, cache: "hit" };
  }
  const startedAt = Date.now();
  const start = `${normalizedMonth}-01`;
  const [year, monthIndex] = normalizedMonth.split("-").map(Number);
  const end = toDateOnly(new Date(Date.UTC(year, monthIndex, 0)));
  const endPlusOne = toDateOnly(addDays(parseDate(end), 1));
  const appointmentRowsRaw = (
    await fetchEastmoneyPaged(
      "RPT_PUBLIC_BS_APPOIN",
      {
        sortColumns: "APPOINT_PUBLISH_DATE,SECURITY_CODE",
        sortTypes: "1,1",
        filter: `(APPOINT_PUBLISH_DATE>='${start}')(APPOINT_PUBLISH_DATE<='${end}')`
      },
      force
    )
  ).filter(isAshareRow);
  const forecastRowsRaw = (
    await fetchEastmoneyPaged(
      "RPT_PUBLIC_OP_NEWPREDICT",
      {
        sortColumns: "NOTICE_DATE,SECURITY_CODE",
        sortTypes: "1,1",
        filter: `(NOTICE_DATE>='${start}')(NOTICE_DATE<='${endPlusOne}')`
      },
      force
    )
  )
    .filter(isAshareRow)
    .filter((row) => row.IS_LATEST !== "F");
  const calendarRowsByCompany = new Map();
  for (const row of appointmentRowsRaw) {
    const date = ashareAppointmentDate(row);
    if (!date) continue;
    const key = `${date}:${row.SECUCODE}`;
    const existing = calendarRowsByCompany.get(key);
    if (!existing || String(row.REPORT_DATE || "").localeCompare(String(existing.REPORT_DATE || "")) > 0) {
      calendarRowsByCompany.set(key, row);
    }
  }
  const rows = [...calendarRowsByCompany.values()];
  const forecastRows = groupAshareForecastRows(forecastRowsRaw);
  const allSecucodes = [...new Set([...rows, ...forecastRows].map((row) => row.SECUCODE).filter(Boolean))];
  const quoteMap = await fetchAshareQuotes(allSecucodes, force);
  const publishedRows = rows.filter((row) => row.IS_PUBLISH === "1" || ashareDate(row.ACTUAL_PUBLISH_DATE));
  const noticeMap = await fetchAshareReportNoticeMap(publishedRows, force);
  const forecastNoticeMap = await fetchAsharePerformanceNoticeMap(forecastRows, force);
  const byDate = {};
  for (const row of rows) {
    const date = ashareAppointmentDate(row);
    const quote = quoteMap.get(row.SECURITY_CODE) || {};
    const secucode = row.SECUCODE;
    const notice = noticeMap.get(ashareNoticeKey(row));
    const status = row.IS_PUBLISH === "1" ? "已披露" : "待定";
    const event = {
      date,
      symbol: row.SECURITY_CODE,
      name: row.SECURITY_NAME_ABBR || quote.name || row.SECURITY_CODE,
      marketCap: ashareMarketCapDisplay(quote.marketCap),
      marketCapCurrency: "¥",
      time: "time-not-supplied",
      fiscalQuarterEnding: row.REPORT_TYPE_NAME || asharePeriodLabel(row.REPORT_DATE),
      metricLabel: `EPS ${row.BASIC_EPS ?? "--"}`,
      epsForecast: row.BASIC_EPS ?? "",
      noOfEsts: "",
      lastYearRptDt: "",
      lastYearEPS: "",
      industry: quote.industry || row.BOARD_NAME || row.PUBLISHNAME || "",
      stockUrl: ashareStockUrl(secucode),
      nasdaqUrl: notice?.pdfUrl || ashareReportUrl(secucode),
      reportNoticeUrl: notice?.noticePageUrl || "",
      reportTitle: notice?.title || "",
      reportDate: ashareDate(row.REPORT_DATE),
      firstAppointmentDate: ashareDate(row.FIRST_APPOINT_DATE),
      firstChangeDate: ashareDate(row.FIRST_CHANGE_DATE),
      secondChangeDate: ashareDate(row.SECOND_CHANGE_DATE),
      thirdChangeDate: ashareDate(row.THIRD_CHANGE_DATE),
      actualPublishDate: ashareDate(row.ACTUAL_PUBLISH_DATE),
      status,
      calendarLabel: notice ? "财报PDF" : "预约页"
    };
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(event);
  }
  for (const row of forecastRows) {
    const forecastKey = ashareForecastGroupKey(row);
    const notice = forecastNoticeMap.get(forecastKey);
    const date = notice?.displayDate || ashareForecastNoticeDate(row);
    if (!date || date < start || date > end) continue;
    const quote = quoteMap.get(row.SECURITY_CODE) || {};
    const secucode = row.SECUCODE;
    const predictType = row.PREDICT_TYPE || "业绩预告";
    const changeText =
      Number.isFinite(Number(row.ADD_AMP_LOWER)) && Number.isFinite(Number(row.ADD_AMP_UPPER))
        ? `同比 ${Number(row.ADD_AMP_LOWER).toFixed(1)}% 至 ${Number(row.ADD_AMP_UPPER).toFixed(1)}%`
        : "";
    const event = {
      date,
      symbol: row.SECURITY_CODE,
      name: row.SECURITY_NAME_ABBR || quote.name || row.SECURITY_CODE,
      marketCap: ashareMarketCapDisplay(quote.marketCap),
      marketCapCurrency: "¥",
      time: notice?.displayTime ? String(notice.displayTime).slice(11, 16) : "time-not-supplied",
      fiscalQuarterEnding: `${asharePeriodLabel(ashareForecastReportDate(row))}业绩预告`,
      metricLabel: [predictType, changeText].filter(Boolean).join(" · "),
      epsForecast: "",
      noOfEsts: "",
      lastYearRptDt: "",
      lastYearEPS: "",
      industry: quote.industry || row.TRADE_MARKET || "",
      stockUrl: ashareStockUrl(secucode),
      nasdaqUrl: notice?.pdfUrl || notice?.noticePageUrl || ashareReportUrl(secucode),
      reportNoticeUrl: notice?.noticePageUrl || "",
      reportTitle: notice?.title || `${row.SECURITY_NAME_ABBR || row.SECURITY_CODE}业绩预告`,
      reportDate: ashareForecastReportDate(row),
      actualPublishDate: notice?.displayDate || ashareForecastNoticeDate(row),
      status: "业绩预告",
      calendarLabel: notice?.pdfUrl ? "业绩预告" : "预告页",
      eventType: "performanceForecast",
      eventTypeLabel: "业绩预告",
      eventSummary: row.PREDICT_CONTENT || "",
      eventReason: row.CHANGE_REASON_EXPLAIN || ""
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
    source: "东方财富预约披露时间 + 业绩预告",
    eventSources: {
      appointments: "东方财富 RPT_PUBLIC_BS_APPOIN",
      performanceForecasts: "东方财富 RPT_PUBLIC_OP_NEWPREDICT + 公告 display_time"
    },
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

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamRankingResponse(req, res, requestUrl, market) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const startedAt = Date.now();
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const progress = ({ stage, message, detail = {} }) => {
    if (closed) return;
    sendSse(res, "progress", {
      stage,
      message,
      detail,
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString()
    });
  };
  try {
    const force = requestUrl.searchParams.get("force") === "1";
    const options = parseRankingOptions(requestUrl.searchParams);
    progress({
      stage: "start",
      message: force ? "开始强制刷新排名数据" : "开始读取排名数据"
    });
    const payload =
      market === "cn"
        ? await getAshareRankings(force, options, progress)
        : await getRankings(force, options, progress);
    progress({
      stage: "complete",
      message: `完成：${payload.totals?.ranked || 0} 家入榜`
    });
    if (!closed) sendSse(res, "result", payload);
  } catch (error) {
    if (!closed) {
      sendSse(res, "ranking-error", {
        error: error.message,
        elapsedMs: Date.now() - startedAt
      });
    }
  } finally {
    if (!closed) res.end();
  }
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
  if (filePath === "/financials") filePath = "/financials.html";
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
    if (requestUrl.pathname === "/api/rankings/stream") {
      await streamRankingResponse(req, res, requestUrl, "us");
      return;
    }
    if (requestUrl.pathname === "/api/ashare-rankings/stream") {
      await streamRankingResponse(req, res, requestUrl, "cn");
      return;
    }
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
    if (requestUrl.pathname === "/api/financials") {
      const force = requestUrl.searchParams.get("force") === "1";
      const market = requestUrl.searchParams.get("market") === "cn" ? "cn" : "us";
      const symbol = requestUrl.searchParams.get("symbol") || "";
      sendJson(res, 200, await getFinancials(market, symbol, force));
      return;
    }
    if (requestUrl.pathname === "/api/financials/analyze") {
      const force = requestUrl.searchParams.get("force") === "1";
      const market = requestUrl.searchParams.get("market") === "cn" ? "cn" : "us";
      const symbol = requestUrl.searchParams.get("symbol") || "";
      sendJson(res, 200, await getFinancialLlmAnalysis(market, symbol, force));
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

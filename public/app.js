const state = {
  ranking: null,
  rankingSort: {
    key: "score",
    direction: "desc"
  },
  calendar: null,
  selectedDate: null,
  companyProfiles: {},
  profileRequests: new Set(),
  businessTranslations: {},
  translationRequests: new Set(),
  expandedBusinessDescriptions: new Set(),
  financialCharts: [],
  financialPayload: null,
  financialAiAnalysis: null,
  focusAutoSearchTimer: null,
  focusAutoSearchValue: "",
  rankingRequestId: 0,
  rankingEventSource: null,
  rankingProgressLog: []
};

const $ = (selector) => document.querySelector(selector);

function currentMarket() {
  return document.body.dataset.market || "us";
}

function isAshareMarket() {
  return currentMarket() === "cn";
}

function rankingEndpoint() {
  return isAshareMarket() ? "/api/ashare-rankings" : "/api/rankings";
}

function rankingStreamEndpoint() {
  return isAshareMarket() ? "/api/ashare-rankings/stream" : "/api/rankings/stream";
}

function calendarEndpoint() {
  return isAshareMarket() ? "/api/ashare-calendar" : "/api/calendar";
}

function companyProfilesEndpoint() {
  return isAshareMarket() ? "/api/ashare-company-profiles" : "/api/company-profiles";
}

function financialsUrl(symbol, market = currentMarket(), name = "") {
  const params = new URLSearchParams({
    market,
    symbol: symbol || ""
  });
  if (name) params.set("name", name);
  return `/financials.html?${params.toString()}`;
}

function formatDateTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function pct(value) {
  if (value == null || Number.isNaN(value)) return "--";
  return `${(value * 100).toFixed(1)}%`;
}

function pctPoint(value) {
  if (value == null || Number.isNaN(value)) return "--";
  return `${(value * 100).toFixed(1)}pct`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(id, message, type = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = `status-line ${type}`;
}

function progressStageLabel(stage) {
  return (
    {
      start: "开始",
      cache: "缓存",
      universe: "股票池",
      calendar: "财报日历",
      ticker: "CIK 匹配",
      frames: "SEC 指标",
      score: "评分",
      filings: "财报补全",
      text: "文本解析",
      "next-earnings": "下次财报",
      diagnostics: "异常整理",
      "focused-analysis": "指定公司",
      fallback: "普通请求",
      error: "错误",
      complete: "完成"
    }[stage] || stage || "进度"
  );
}

function closeRankingProgressStream() {
  if (!state.rankingEventSource) return;
  state.rankingEventSource.close();
  state.rankingEventSource = null;
}

function resetRankingProgress(message = "准备开始") {
  state.rankingProgressLog = [];
  const panel = $("#ranking-progress");
  if (!panel) return;
  panel.hidden = false;
  $("#ranking-progress-stage").textContent = "准备";
  $("#ranking-progress-elapsed").textContent = "0.0 秒";
  $("#ranking-progress-message").textContent = message;
  $("#ranking-progress-log").innerHTML = "";
}

function hideRankingProgress() {
  const panel = $("#ranking-progress");
  if (panel) panel.hidden = true;
}

function updateRankingProgress(progress) {
  const panel = $("#ranking-progress");
  if (!panel) return;
  panel.hidden = false;
  const label = progressStageLabel(progress.stage);
  const elapsed = Number(progress.elapsedMs || 0) / 1000;
  $("#ranking-progress-stage").textContent = label;
  $("#ranking-progress-elapsed").textContent = `${elapsed.toFixed(1)} 秒`;
  $("#ranking-progress-message").textContent = progress.message || "";
  const entry = `${elapsed.toFixed(1)}s · ${label} · ${progress.message || ""}`;
  if (entry.trim()) {
    const last = state.rankingProgressLog[state.rankingProgressLog.length - 1];
    if (last !== entry) state.rankingProgressLog.push(entry);
    state.rankingProgressLog = state.rankingProgressLog.slice(-8);
    $("#ranking-progress-log").innerHTML = state.rankingProgressLog
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

function metricGrowthCell(metric) {
  if (!metric) return "--";
  if (metric.turnaround) return '<span class="good">扭亏</span>';
  const value = metric.growthPct;
  if (value == null) return "--";
  const cls = value >= 0.25 ? "good" : value < 0 ? "bad" : "";
  return `<span class="${cls}">${pct(value)}</span>`;
}

function signalChips(signals) {
  if (!signals?.length) return '<span class="muted">--</span>';
  return signals
    .slice(0, 4)
    .map((signal) => {
      const hit = signal.hits?.[0];
      const title = hit ? `${hit.form} ${hit.filingDate}: ${hit.context}` : signal.label;
      return `<a class="signal-chip" title="${escapeHtml(title)}" href="${escapeHtml(
        hit?.url || "#"
      )}" target="_blank" rel="noreferrer">${escapeHtml(signal.label)}</a>`;
    })
    .join("");
}

function customFindingChips(findings) {
  if (!findings?.length) return "";
  return findings
    .map(
      (finding) =>
        `<span class="custom-chip" title="${escapeHtml(finding.value || "")}">${escapeHtml(
          finding.label
        )}</span>`
    )
    .join("");
}

function rowSignalChips(row) {
  const custom = customFindingChips(row.customFindings);
  const defaultSignals = signalChips(row.signals);
  if (custom && defaultSignals.includes("muted")) return custom;
  return `${custom}${defaultSignals}`;
}

function usStockSymbol(symbol) {
  return String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "");
}

function domesticUsStockLinks(symbol) {
  const safeSymbol = encodeURIComponent(usStockSymbol(symbol));
  return [
    { label: "东财", url: `https://quote.eastmoney.com/us/${safeSymbol}.html` },
    { label: "雪球", url: `https://xueqiu.com/S/${safeSymbol}` },
    { label: "新浪", url: `https://stock.finance.sina.com.cn/usstock/quotes/${safeSymbol}.html` }
  ];
}

function primaryStockUrl(item, market = currentMarket()) {
  if (market === "us") return domesticUsStockLinks(item.symbol)[0].url;
  return item.stockUrl || "#";
}

function stockLinksHtml(item) {
  const links = currentMarket() === "us"
    ? domesticUsStockLinks(item.symbol)
    : item.stockLinks?.length
    ? item.stockLinks
    : item.stockUrl
      ? [{ label: "股票页", url: item.stockUrl }]
      : [];
  return links
    .filter((link) => link.url)
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(
          link.label || "股票页"
        )}</a>`
    )
    .join("");
}

function nextEarningsCell(nextEarnings) {
  if (!nextEarnings?.date) {
    const note = nextEarnings?.note || "暂未找到下一次财报日期";
    const label = nextEarnings?.label || "";
    return `<div class="next-earnings-cell missing" title="${escapeHtml(note)}">
      <span>未公布</span>
      ${label ? `<small>${escapeHtml(label)}</small>` : ""}
    </div>`;
  }
  const details = [
    nextEarnings.label || "",
    nextEarnings.time || "",
    nextEarnings.epsForecast ? `EPS ${nextEarnings.epsForecast}` : ""
  ]
    .filter(Boolean)
    .join(" · ");
  const titleParts = [
    nextEarnings.source || "",
    nextEarnings.firstAppointmentDate ? `首次预约 ${nextEarnings.firstAppointmentDate}` : "",
    nextEarnings.actualPublishDate ? `实际披露 ${nextEarnings.actualPublishDate}` : ""
  ].filter(Boolean);
  return `<div class="next-earnings-cell" title="${escapeHtml(titleParts.join("；"))}">
    <strong>${escapeHtml(nextEarnings.date)}</strong>
    <small>${escapeHtml(details || nextEarnings.reportDate || "")}</small>
  </div>`;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCompanyFilters(value = "") {
  const filters = [];
  const push = (text) => {
    const normalized = normalizeSearchText(text);
    if (normalized && !filters.includes(normalized)) filters.push(normalized);
  };
  String(value || "")
    .split(/[,，;；\n\r]+/)
    .forEach((chunk) => {
      push(chunk);
      const tokens = chunk.trim().split(/\s+/).filter(Boolean);
      const looksLikeTickerList = tokens.length > 1 && tokens.every((token) => /^[A-Z0-9._-]{1,8}$/.test(token));
      if (looksLikeTickerList) tokens.forEach(push);
    });
  return filters;
}

function rowMatchesCompanyFilter(row, filters) {
  if (!filters.length) return true;
  const haystack = normalizeSearchText(
    [
      row.symbol,
      row.name,
      row.exchange,
      ...(row.manualQueries || []),
      ...(row.reasons || []),
      ...(row.signals || []).map((signal) => signal.label)
    ].join(" ")
  );
  return filters.some((filter) => haystack.includes(filter));
}

function filteredRankingRows(rows) {
  const filters = parseCompanyFilters($("#focus-companies")?.value || "");
  return {
    filters,
    rows: filters.length ? rows.filter((row) => rowMatchesCompanyFilter(row, filters)) : rows
  };
}

function clearFocusAutoSearch() {
  if (!state.focusAutoSearchTimer) return;
  clearTimeout(state.focusAutoSearchTimer);
  state.focusAutoSearchTimer = null;
}

function scheduleFocusAutoSearch() {
  clearFocusAutoSearch();
  const focusText = $("#focus-companies")?.value?.trim() || "";
  const normalizedFocus = normalizeSearchText(focusText);
  if (!normalizedFocus || normalizedFocus.length < 2) {
    state.focusAutoSearchValue = "";
    return;
  }
  const visibleRows = state.ranking ? filteredRankingRows(state.ranking.rows).rows : [];
  if (visibleRows.length) {
    state.focusAutoSearchValue = "";
    return;
  }
  if (state.focusAutoSearchValue === normalizedFocus) return;
  setStatus("#ranking-status", "当前列表未找到匹配公司，稍后自动生成指定公司结果...");
  state.focusAutoSearchTimer = setTimeout(() => {
    state.focusAutoSearchTimer = null;
    const latestFocus = $("#focus-companies")?.value?.trim() || "";
    if (normalizeSearchText(latestFocus) !== normalizedFocus) return;
    const latestVisibleRows = state.ranking ? filteredRankingRows(state.ranking.rows).rows : [];
    if (latestVisibleRows.length) return;
    state.focusAutoSearchValue = normalizedFocus;
    void loadRanking(false);
  }, 700);
}

function readAnalysisOptions() {
  return {
    limit: Math.min(500, Math.max(1, Number($("#analysis-limit")?.value || 100))),
    reuse: $("#reuse-analysis")?.checked !== false,
    cashFlow: $("#include-cash-flow")?.checked === true,
    cashFlowThreshold: Math.min(500, Math.max(0, Number($("#cash-flow-threshold")?.value || 25))),
    focusCompanies: $("#focus-companies")?.value?.trim() || "",
    keywords: $("#custom-keywords")?.value?.trim() || ""
  };
}

function analysisOptionsStorageKey() {
  return `earningsRadar.analysisOptions.${currentMarket()}`;
}

function persistAnalysisOptions() {
  const options = readAnalysisOptions();
  localStorage.setItem(analysisOptionsStorageKey(), JSON.stringify(options));
}

function restoreAnalysisOptions() {
  try {
    const options = JSON.parse(
      localStorage.getItem(analysisOptionsStorageKey()) ||
        localStorage.getItem("earningsRadar.analysisOptions") ||
        "{}"
    );
    if (options.limit && $("#analysis-limit")) $("#analysis-limit").value = options.limit;
    if (typeof options.reuse === "boolean" && $("#reuse-analysis")) {
      $("#reuse-analysis").checked = options.reuse;
    }
    if (typeof options.cashFlow === "boolean" && $("#include-cash-flow")) {
      $("#include-cash-flow").checked = options.cashFlow;
    }
    if (options.cashFlowThreshold != null && $("#cash-flow-threshold")) {
      $("#cash-flow-threshold").value = options.cashFlowThreshold;
    }
    if (options.focusCompanies != null && $("#focus-companies")) {
      $("#focus-companies").value = options.focusCompanies;
    }
    if (options.keywords != null && $("#custom-keywords")) {
      $("#custom-keywords").value = options.keywords;
    }
  } catch {
    localStorage.removeItem(analysisOptionsStorageKey());
  }
}

function rankingQuery(force = false) {
  const options = readAnalysisOptions();
  const params = new URLSearchParams();
  if (force) params.set("force", "1");
  params.set("limit", String(options.limit));
  params.set("reuse", options.reuse ? "1" : "0");
  if (options.cashFlow) {
    params.set("cashFlow", "1");
    params.set("cashFlowThreshold", String(options.cashFlowThreshold));
  }
  if (options.focusCompanies) params.set("focus", options.focusCompanies);
  if (options.keywords) params.set("keywords", options.keywords);
  return params.toString();
}

function compactList(items, limit = 30) {
  if (!items?.length) return "";
  const visible = items.slice(0, limit);
  const rows = visible
    .map((item) => {
      const symbol = item.symbol ? `<strong>${escapeHtml(item.symbol)}</strong>` : "";
      const name = item.name ? ` ${escapeHtml(item.name)}` : "";
      const date = item.date ? `<strong>${escapeHtml(item.date)}</strong>` : "";
      const reason = item.reason ? ` — ${escapeHtml(item.reason)}` : "";
      const query = item.query ? `指定：${escapeHtml(item.query)} ` : "";
      const detail = item.error ? `；错误：${escapeHtml(item.error)}` : "";
      const filing = item.filingDate ? `；披露：${escapeHtml(item.filingDate)}` : "";
      const frame = item.frame ? `；frame：${escapeHtml(item.frame)}` : "";
      const concept = item.concept ? `；concept：${escapeHtml(item.concept)}` : "";
      const sources = item.sources?.length ? `；来源：${escapeHtml(item.sources.join("+"))}` : "";
      const calendarDates = item.calendarDates?.length
        ? `；日历：${escapeHtml(item.calendarDates.slice(0, 4).join(", "))}`
        : "";
      return `<li>${query}${date}${symbol}${name}${filing}${reason}${sources}${calendarDates}${frame}${concept}${detail}</li>`;
    })
    .join("");
  const more =
    items.length > limit ? `<li class="muted">还有 ${items.length - limit} 条未展开。</li>` : "";
  return `<ul>${rows}${more}</ul>`;
}

function diagnosticsTotal(counts, keys) {
  return keys.reduce((sum, key) => sum + (counts?.[key] || 0), 0);
}

function renderDiagnostics(payload) {
  const panel = $("#diagnostics-panel");
  if (!panel) return;
  const diagnostics = payload.diagnostics;
  if (!diagnostics) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const counts = diagnostics.counts || {};
  const hardIssueKeys = [
    "calendarFetchFailures",
    "frameFetchFailures",
    "missingSymbols",
    "manualCompanyMissing",
    "notEnrichedDueLimit",
    "marketDataMissing",
    "enrichFailures",
    "filingMissing",
    "textDocsMissing",
    "textScanFailures"
  ];
  const hardIssues = diagnosticsTotal(counts, hardIssueKeys);
  const selected = payload.totals.selectedForAnalysis ?? payload.totals.enriched;
  if (payload.market === "cn") {
    $("#coverage-summary").textContent = `A股 ${payload.reportingFrame?.label || payload.range.label} 财报记录 ${payload.totals.scanned} 条，亮眼候选 ${payload.totals.candidates} 家，指定分析 ${payload.totals.forced || 0} 家，本次展示 ${selected} 家，最终入榜 ${payload.totals.ranked} 家。`;
  } else {
    const staticCount = payload.totals.configured;
    const calendarCount = payload.totals.calendarSymbols ?? 0;
    const combinedCount = payload.totals.combinedUniverse ?? staticCount;
    $("#coverage-summary").textContent = `静态股票池 ${staticCount} 家，当前披露窗口日历 ${calendarCount} 家，合并后 ${combinedCount} 家；SEC 匹配 ${payload.totals.scanned} 家，亮眼候选 ${payload.totals.candidates} 家，指定分析 ${payload.totals.forced || 0} 家，按日历/披露时间选取 ${selected} 家，实际解析财报 ${payload.totals.enriched} 家，最终入榜 ${payload.totals.ranked} 家。分析缓存：复用 ${counts.analysisCacheHits || 0}，新算 ${counts.analysisCacheMisses || 0}。`;
  }
  const badge = $("#diagnostics-badge");
  badge.textContent = hardIssues ? `${hardIssues} 个需检查项` : "无接口/解析失败";
  badge.classList.toggle("has-issues", hardIssues > 0);

  const categories = payload.market === "cn" ? [
    ["manualCompanyMissing", "指定公司未匹配", "failure"],
    ["marketDataMissing", "估值/市值数据缺失", "failure"],
    ["textDocsMissing", "财报 PDF 缺失", "failure"],
    ["textScanFailures", "财报 PDF 解析失败", "failure"],
    ["notEnrichedDueLimit", "候选超过展示上限", "failure"],
    ["noPositiveScore", "有数据但未触发亮眼条件", "neutral"]
  ] : [
    ["manualCompanyMissing", "指定公司未匹配", "failure"],
    ["calendarFetchFailures", "Nasdaq 日历接口失败", "failure"],
    ["frameFetchFailures", "SEC frames 接口失败", "failure"],
    ["frameConceptUnavailable", "SEC frames 指标无聚合数据", "notice"],
    ["missingSymbols", "股票池未匹配 CIK", "failure"],
    ["notEnrichedDueLimit", "候选超过补全上限", "failure"],
    ["enrichFailures", "候选补全失败", "failure"],
    ["filingMissing", "财报缺失", "failure"],
    ["textDocsMissing", "文本主文档缺失", "failure"],
    ["textScanFailures", "财报文本解析失败", "failure"],
    ["filteredByDisclosureWindow", "披露窗口外，未入榜", "notice"],
    ["noCurrentFrameFacts", "SEC frames 无当前期事实，无法判断", "notice"],
    ["noPositiveScore", "有数据但未触发亮眼条件", "neutral"]
  ];

  $("#diagnostics-lists").innerHTML = categories
    .filter(([key]) => diagnostics[key]?.length)
    .map(([key, title, tone]) => {
      const count = diagnostics[key].length;
      return `<details class="diagnostic-group ${tone}" ${tone === "failure" ? "open" : ""}>
        <summary>
          <span>${escapeHtml(title)}</span>
          <strong>${count}</strong>
        </summary>
        ${compactList(diagnostics[key])}
      </details>`;
    })
    .join("");
}

function growthSortValue(metric) {
  if (!metric) return null;
  if (metric.turnaround) return Number.POSITIVE_INFINITY;
  return Number.isFinite(metric.growthPct) ? metric.growthPct : null;
}

function sortableValue(row, key) {
  if (key === "symbol") return row.symbol || "";
  if (key === "score") return row.score;
  if (key === "filingDate") {
    const time = Date.parse(row.filing?.filingDate || "");
    return Number.isNaN(time) ? null : time;
  }
  if (key === "nextEarningsDate") {
    const time = Date.parse(row.nextEarnings?.date || "");
    return Number.isNaN(time) ? null : time;
  }
  if (key === "revenue") return growthSortValue(row.metrics?.revenue);
  if (key === "netIncome") return growthSortValue(row.metrics?.netIncome);
  if (key === "margin") {
    return row.metrics?.operatingMarginDelta ?? row.metrics?.grossMarginDelta ?? null;
  }
  if (key === "signals") return (row.signals?.length || 0) + (row.customFindings?.length || 0);
  return null;
}

function compareSortableValues(a, b) {
  const aMissing = a == null || a === "";
  const bMissing = b == null || b === "";
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === "string" || typeof b === "string") {
    return String(a).localeCompare(String(b), "en", { numeric: true });
  }
  return a - b;
}

function sortedRankingRows(rows) {
  const { key, direction } = state.rankingSort;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const primary = compareSortableValues(sortableValue(a.row, key), sortableValue(b.row, key));
      const directed = direction === "asc" ? primary : -primary;
      if (directed !== 0) return directed;
      if (a.row.score !== b.row.score) return b.row.score - a.row.score;
      return a.index - b.index;
    })
    .map((item) => item.row);
}

function updateSortIndicators() {
  document.querySelectorAll("[data-sort-indicator]").forEach((indicator) => {
    const key = indicator.dataset.sortIndicator;
    indicator.textContent =
      key === state.rankingSort.key ? (state.rankingSort.direction === "asc" ? "↑" : "↓") : "↕";
  });
  document.querySelectorAll("[data-sort-key]").forEach((button) => {
    const active = button.dataset.sortKey === state.rankingSort.key;
    button.classList.toggle("active", active);
    button.setAttribute(
      "aria-sort",
      active ? (state.rankingSort.direction === "asc" ? "ascending" : "descending") : "none"
    );
  });
}

function scrollRankingTableToTop() {
  const panel = document.querySelector(".table-panel");
  if (!panel) return;
  const topbarHeight = document.querySelector(".topbar")?.offsetHeight || 0;
  const targetTop = panel.getBoundingClientRect().top + window.scrollY - topbarHeight - 10;
  window.scrollTo({
    top: Math.max(0, targetTop),
    behavior: "auto"
  });
}

function setRankingSort(key) {
  const descendingByDefault = new Set([
    "score",
    "filingDate",
    "revenue",
    "netIncome",
    "margin",
    "signals"
  ]);
  if (state.rankingSort.key === key) {
    state.rankingSort.direction = state.rankingSort.direction === "asc" ? "desc" : "asc";
  } else {
    state.rankingSort.key = key;
    state.rankingSort.direction = descendingByDefault.has(key) ? "desc" : "asc";
  }
  updateSortIndicators();
  if (state.ranking) renderRanking(state.ranking, { scrollToTop: true });
}

function renderRanking(payload, options = {}) {
  state.ranking = payload;
  const display = filteredRankingRows(payload.rows);
  const rowsToDisplay = display.rows;
  const hasCompanyFilter = display.filters.length > 0;
  const reportLabel = payload.reportingFrame?.label
    ? `报告期 ${payload.reportingFrame.label}`
    : payload.range.label;
  $("#ranking-subtitle").textContent =
    payload.market === "cn"
      ? `${reportLabel} | 已披露至 ${payload.range.today} | 更新 ${formatDateTime(payload.generatedAt)}`
      : `${reportLabel} | 披露窗口 ${payload.range.start} 至 ${payload.range.today} | 更新 ${formatDateTime(payload.generatedAt)}`;
  $("#summary-scanned").textContent = payload.totals.scanned;
  $("#summary-ranked").textContent = hasCompanyFilter
    ? `${rowsToDisplay.length}/${payload.totals.ranked}`
    : payload.totals.ranked;
  $("#summary-hot").textContent = rowsToDisplay.filter((row) => row.highlight).length;
  $("#summary-cache").textContent = payload.cache === "fresh" ? "已刷新" : "缓存";
  renderDiagnostics(payload);

  const body = $("#ranking-body");
  if (!payload.rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="empty-cell">当前股票池暂无符合条件的财报。</td></tr>';
    return;
  }
  if (!rowsToDisplay.length) {
    body.innerHTML =
      '<tr><td colspan="10" class="empty-cell">未找到匹配指定公司的结果；清空“指定公司”后可查看全部。</td></tr>';
    return;
  }

  updateSortIndicators();
  body.innerHTML = sortedRankingRows(rowsToDisplay)
    .map((row, index) => {
      const revenue = metricGrowthCell(row.metrics.revenue);
      const netIncome = metricGrowthCell(row.metrics.netIncome);
      const margin = [
        row.metrics.grossMarginDelta != null ? `毛 ${pctPoint(row.metrics.grossMarginDelta)}` : "",
        row.metrics.operatingMarginDelta != null ? `营 ${pctPoint(row.metrics.operatingMarginDelta)}` : ""
      ]
        .filter(Boolean)
        .join(" / ");
      const reasons = row.reasons?.length
        ? `<div class="reasons">${row.reasons.map(escapeHtml).join(" · ")}</div>`
        : "";
      return `<tr class="${row.highlight ? "is-hot" : ""}">
        <td class="rank-cell">${index + 1}</td>
        <td>
          <div class="company-cell">
            <a href="${escapeHtml(primaryStockUrl(row, payload.market))}" target="_blank" rel="noreferrer">${escapeHtml(
        row.symbol
      )}</a>
            ${row.forced ? '<span class="manual-badge">指定</span>' : ""}
            ${row.highlight ? '<span class="hot-badge">高景气</span>' : ""}
          </div>
          <div class="muted">${escapeHtml(row.name)}</div>
        </td>
        <td>
          <div class="score-bar" style="--score:${row.score}">
            <strong>${row.score}</strong>
          </div>
          ${reasons}
        </td>
        <td>
          <div>${escapeHtml(row.filing.form)} · ${escapeHtml(row.filing.reportDate || "--")}</div>
          <div class="muted">提交 ${escapeHtml(row.filing.filingDate)}</div>
        </td>
        <td>${nextEarningsCell(row.nextEarnings)}</td>
        <td>${revenue}<div class="muted">${escapeHtml(row.metrics.revenue?.current?.display || "")}</div></td>
        <td>${netIncome}<div class="muted">${escapeHtml(row.metrics.netIncome?.current?.display || "")}</div></td>
        <td>${margin || '<span class="muted">--</span>'}</td>
        <td><div class="signal-list">${rowSignalChips(row)}</div></td>
        <td class="link-cell">
          ${stockLinksHtml(row)}
          <a href="${escapeHtml(row.filing.url)}" target="_blank" rel="noreferrer">财报</a>
          <a href="${escapeHtml(financialsUrl(row.symbol, payload.market, row.name))}" target="_blank" rel="noreferrer">财务分析</a>
        </td>
      </tr>`;
    })
    .join("");

  if (options.scrollToTop) {
    requestAnimationFrame(scrollRankingTableToTop);
  }
}

async function loadRanking(force = false) {
  clearFocusAutoSearch();
  closeRankingProgressStream();
  const requestId = ++state.rankingRequestId;
  const button = $("#refresh-ranking");
  const applyButtons = [$("#apply-ranking"), $("#apply-ranking-inline")].filter(Boolean);
  const setLoading = (loading) => {
    button.disabled = loading;
    applyButtons.forEach((applyButton) => {
      applyButton.disabled = loading;
    });
    button.classList.toggle("loading", loading);
  };
  setLoading(true);
  resetRankingProgress(force ? "准备强制刷新数据..." : "准备读取缓存或刷新数据...");
  setStatus(
    "#ranking-status",
    force
      ? isAshareMarket()
        ? "正在刷新东方财富 A股财报数据，首次可能需要几十秒..."
        : "正在从 SEC 刷新，首次可能需要几十秒到一两分钟..."
      : "正在应用设置并读取缓存..."
  );
  persistAnalysisOptions();
  const query = rankingQuery(force);

  if (window.EventSource) {
    const source = new EventSource(`${rankingStreamEndpoint()}${query ? `?${query}` : ""}`);
    state.rankingEventSource = source;
    let completed = false;

    source.addEventListener("progress", (event) => {
      if (requestId !== state.rankingRequestId) return;
      const progress = JSON.parse(event.data);
      updateRankingProgress(progress);
      setStatus("#ranking-status", `${progressStageLabel(progress.stage)}：${progress.message || ""}`);
    });

    source.addEventListener("result", (event) => {
      if (requestId !== state.rankingRequestId) {
        source.close();
        return;
      }
      completed = true;
      source.close();
      state.rankingEventSource = null;
      const payload = JSON.parse(event.data);
      renderRanking(payload);
      const timing = payload.cache === "hit" ? "命中缓存" : `用时 ${(payload.elapsedMs / 1000).toFixed(1)} 秒`;
      const forcedText = payload.totals.forced ? `，指定分析 ${payload.totals.forced} 家` : "";
      updateRankingProgress({
        stage: "complete",
        message: `完成：${payload.totals.ranked} 家入榜${forcedText}，${timing}。`,
        elapsedMs: payload.elapsedMs || 0
      });
      setStatus(
        "#ranking-status",
        `完成：${payload.totals.ranked} 家入榜${forcedText}，${timing}。`,
        "ok"
      );
      setLoading(false);
    });

    source.addEventListener("ranking-error", (event) => {
      if (requestId !== state.rankingRequestId) {
        source.close();
        return;
      }
      completed = true;
      source.close();
      state.rankingEventSource = null;
      const payload = JSON.parse(event.data);
      updateRankingProgress({
        stage: "error",
        message: payload.error || "刷新失败",
        elapsedMs: payload.elapsedMs || 0
      });
      setStatus("#ranking-status", `刷新失败：${payload.error || "未知错误"}`, "error");
      setLoading(false);
    });

    source.onerror = () => {
      if (completed || requestId !== state.rankingRequestId) return;
      completed = true;
      source.close();
      state.rankingEventSource = null;
      updateRankingProgress({
        stage: "error",
        message: "进度连接中断，请重试",
        elapsedMs: 0
      });
      setStatus("#ranking-status", "刷新失败：进度连接中断，请重试。", "error");
      setLoading(false);
    };
    return;
  }

  try {
    updateRankingProgress({
      stage: "fallback",
      message: "当前浏览器不支持流式进度，改用普通请求",
      elapsedMs: 0
    });
    const payload = await fetchJson(`${rankingEndpoint()}${query ? `?${query}` : ""}`);
    if (requestId !== state.rankingRequestId) return;
    renderRanking(payload);
    const timing = payload.cache === "hit" ? "命中缓存" : `用时 ${(payload.elapsedMs / 1000).toFixed(1)} 秒`;
    const forcedText = payload.totals.forced ? `，指定分析 ${payload.totals.forced} 家` : "";
    setStatus(
      "#ranking-status",
      `完成：${payload.totals.ranked} 家入榜${forcedText}，${timing}。`,
      "ok"
    );
  } catch (error) {
    if (requestId !== state.rankingRequestId) return;
    setStatus("#ranking-status", `刷新失败：${error.message}`, "error");
  } finally {
    if (requestId !== state.rankingRequestId) return;
    setLoading(false);
  }
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month, delta) {
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

function timeLabel(value) {
  return (
    {
      "time-pre-market": "盘前",
      "time-after-hours": "盘后",
      "time-during-market": "盘中",
      "time-not-supplied": "待定"
    }[value] || value || "待定"
  );
}

function formatMarketCap(value, currency = "$") {
  if (!value || value === "N/A") return "--";
  const numeric = marketCapNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return value;
  if (numeric >= 1e12) return `${currency}${(numeric / 1e12).toFixed(2)}T`;
  if (numeric >= 1e9) return `${currency}${(numeric / 1e9).toFixed(1)}B`;
  if (numeric >= 1e6) return `${currency}${(numeric / 1e6).toFixed(1)}M`;
  return `${currency}${numeric.toLocaleString("en-US")}`;
}

function marketCapNumber(value) {
  if (!value || value === "N/A") return null;
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function isMegaCap(item) {
  return (marketCapNumber(item?.marketCap) || 0) >= 100_000_000_000;
}

function profileForEvent(item) {
  return state.companyProfiles[item.symbol] || {};
}

function hasChineseText(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function translationKey(symbol, text) {
  return `${symbol}:${text}`;
}

function stringHash(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function businessExpansionKey(symbol, text) {
  return `${symbol}:${stringHash(text)}`;
}

function collapsedBusinessText(text, expanded, maxLength = 170) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (expanded || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trim()}...`;
}

async function translateBusinessDescription(date, item) {
  const profile = profileForEvent(item);
  const sourceText = profile.businessDescription || "";
  if (!sourceText) return;
  const key = translationKey(item.symbol, sourceText);
  if (state.translationRequests.has(key)) return;
  state.translationRequests.add(key);
  state.businessTranslations[key] = { status: "loading", text: "" };
  renderDayPanel(date);
  try {
    const payload = await fetchJson(`/api/translate?text=${encodeURIComponent(sourceText)}`);
    state.businessTranslations[key] = {
      status: payload.status === "ok" || payload.status === "already-chinese" ? "ok" : "unchanged",
      text: payload.translatedText || sourceText
    };
  } catch (error) {
    state.translationRequests.delete(key);
    state.businessTranslations[key] = {
      status: "error",
      text: `翻译失败：${error.message}`
    };
  }
  if (state.selectedDate === date) renderDayPanel(date);
}

async function ensureCompanyProfiles(date, events) {
  const missing = [
    ...new Set(
      events
        .map((event) => event.symbol)
        .filter((symbol) => symbol && !state.companyProfiles[symbol])
    )
  ];
  if (!missing.length) return;
  const requestKey = `${date}:${missing.join(",")}`;
  if (state.profileRequests.has(requestKey)) return;
  state.profileRequests.add(requestKey);
  try {
    const payload = await fetchJson(
      `${companyProfilesEndpoint()}?symbols=${encodeURIComponent(missing.join(","))}`
    );
    Object.assign(state.companyProfiles, payload.profiles || {});
    if (state.selectedDate === date) renderDayPanel(date);
  } catch {
    for (const symbol of missing) {
      state.companyProfiles[symbol] = {
        symbol,
        businessDescription: "",
        status: "error"
      };
    }
    if (state.selectedDate === date) renderDayPanel(date);
  }
}

function renderDayPanel(date) {
  state.selectedDate = date;
  $("#day-title").textContent = date || "选择日期";
  const events = date ? state.calendar?.byDate?.[date] || [] : [];
  const panel = $("#day-events");
  if (!date) {
    panel.innerHTML = '<div class="empty-cell">点击日历中的日期查看公司。</div>';
    return;
  }
  if (!events.length) {
    panel.innerHTML = '<div class="empty-cell">当天暂无财报事件。</div>';
    return;
  }
  panel.innerHTML = events
    .map(
      (item) => {
        const profile = profileForEvent(item);
        const sourceDescription =
          profile.businessDescription ||
          (profile.status ? "主营业务：暂无公开简介" : "主营业务：加载中...");
        const translation = profile.businessDescription
          ? state.businessTranslations[translationKey(item.symbol, profile.businessDescription)]
          : null;
        const fullDescription = translation?.text || sourceDescription;
        const expansionKey = businessExpansionKey(item.symbol, fullDescription);
        const isExpanded = state.expandedBusinessDescriptions.has(expansionKey);
        const description = collapsedBusinessText(fullDescription, isExpanded);
        const canExpand = String(fullDescription || "").replace(/\s+/g, " ").trim().length > 170;
        const canTranslate =
          Boolean(profile.businessDescription) &&
          !hasChineseText(profile.businessDescription) &&
          (!translation || translation.status === "error");
        const translateLabel =
          {
            loading: "翻译中",
            error: "重试翻译",
            unchanged: "无中文结果",
            ok: "已翻译"
          }[translation?.status] || "翻译";
        const industry = [profile.sector, profile.industry || item.industry].filter(Boolean).join(" / ");
        const megaCap = isMegaCap(item);
        return `<article class="event-row ${megaCap ? "is-mega-cap" : ""}">
        <div>
          <a href="${escapeHtml(item.stockUrl)}" target="_blank" rel="noreferrer">${escapeHtml(
        item.symbol
      )}</a>
          <strong>${escapeHtml(item.name)}</strong>
          ${
            profile.chineseName
              ? `<span class="company-cn-name">${escapeHtml(profile.chineseName)}</span>`
              : ""
          }
        </div>
        <div class="event-meta">
          ${item.eventTypeLabel ? `<span class="event-type-badge">${escapeHtml(item.eventTypeLabel)}</span>` : ""}
          <span>${timeLabel(item.time)}</span>
          ${megaCap ? "<span class=\"mega-cap-badge\">千亿市值</span>" : ""}
          <span>市值 ${escapeHtml(formatMarketCap(item.marketCap, item.marketCapCurrency || "$"))}</span>
          <span>${escapeHtml(item.fiscalQuarterEnding || "")}</span>
          <span>${escapeHtml(item.metricLabel || `EPS ${item.epsForecast || "--"}`)}</span>
          ${industry ? `<span>${escapeHtml(industry)}</span>` : ""}
        </div>
        ${
          item.eventSummary
            ? `<p class="event-highlight">${escapeHtml(item.eventSummary)}</p>`
            : ""
        }
        ${
          item.eventReason
            ? `<p class="event-reason">${escapeHtml(item.eventReason)}</p>`
            : ""
        }
        <div class="event-business-block">
          <p class="event-business">${escapeHtml(description)}</p>
          <div class="event-business-actions">
            ${
              canExpand
                ? `<button class="text-action-button" type="button" data-expand-symbol="${escapeHtml(
                    item.symbol
                  )}" data-expand-key="${escapeHtml(expansionKey)}">${
                    isExpanded ? "收起" : "展开"
                  }</button>`
                : ""
            }
          ${
            profile.businessDescription
              ? `<button class="translate-button text-action-button" type="button" data-translate-symbol="${escapeHtml(
                  item.symbol
                )}" ${canTranslate ? "" : "disabled"}>${escapeHtml(translateLabel)}</button>`
              : ""
          }
          </div>
        </div>
        <div class="link-cell">
          ${stockLinksHtml(item)}
          <a href="${escapeHtml(item.nasdaqUrl)}" target="_blank" rel="noreferrer">${escapeHtml(
            item.calendarLabel || "日历页"
          )}</a>
          <a href="${escapeHtml(financialsUrl(item.symbol, currentMarket(), item.name))}" target="_blank" rel="noreferrer">财务分析</a>
        </div>
      </article>`;
      }
    )
    .join("");
  panel.querySelectorAll("[data-translate-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = events.find((event) => event.symbol === button.dataset.translateSymbol);
      if (item) void translateBusinessDescription(date, item);
    });
  });
  panel.querySelectorAll("[data-expand-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.expandKey;
      if (!key) return;
      if (state.expandedBusinessDescriptions.has(key)) {
        state.expandedBusinessDescriptions.delete(key);
      } else {
        state.expandedBusinessDescriptions.add(key);
      }
      renderDayPanel(date);
    });
  });
  void ensureCompanyProfiles(date, events);
}

function renderCalendar(payload) {
  state.calendar = payload;
  $("#month-input").value = payload.month || $("#month-input").value || currentMonth();
  $("#calendar-subtitle").textContent = `${payload.month} | ${payload.totalEvents} 个财报事件 | 更新 ${formatDateTime(payload.generatedAt)}`;
  const grid = $("#calendar-grid");
  const [year, monthIndex] = payload.month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthIndex - 1, 1));
  const firstWeekday = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const cells = [];

  for (let index = 0; index < firstWeekday; index += 1) {
    cells.push('<div class="calendar-cell muted-cell"></div>');
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${payload.month}-${String(day).padStart(2, "0")}`;
    const events = payload.byDate[date] || [];
    const hasMegaCap = events.some(isMegaCap);
    const previewLimit = isAshareMarket() ? 4 : 5;
    const preview = events
      .slice(0, previewLimit)
      .map(
        (item) => {
          const label = isAshareMarket() ? item.name || item.symbol : item.symbol;
          return `<span class="${isMegaCap(item) ? "is-mega-cap" : ""}" title="${escapeHtml(
            `${item.name || item.symbol} ${item.symbol || ""}`.trim()
          )}">${escapeHtml(label)}</span>`;
        }
      )
      .join("");
    const more = events.length > previewLimit ? `<em>+${events.length - previewLimit}</em>` : "";
    cells.push(`<button class="calendar-cell ${events.length ? "has-events" : ""} ${
      hasMegaCap ? "has-mega-cap" : ""
    }" data-date="${date}" type="button">
      <strong>${day}</strong>
      <small>${events.length ? `${events.length} 家` : ""}</small>
      <div class="ticker-stack">${preview}${more}</div>
    </button>`);
  }

  grid.innerHTML = cells.join("");
  grid.querySelectorAll("[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      grid.querySelectorAll(".selected").forEach((item) => item.classList.remove("selected"));
      cell.classList.add("selected");
      renderDayPanel(cell.dataset.date);
    });
  });

  const today = new Date().toISOString().slice(0, 10);
  const preferred = payload.byDate[today] ? today : Object.keys(payload.byDate).find((date) => payload.byDate[date]?.length);
  if (preferred) {
    const cell = grid.querySelector(`[data-date="${preferred}"]`);
    cell?.classList.add("selected");
    renderDayPanel(preferred);
  } else {
    renderDayPanel(null);
  }
}

async function loadCalendar(force = false) {
  const month = $("#month-input").value || (isAshareMarket() ? "" : currentMonth());
  const button = $("#refresh-calendar");
  button.disabled = true;
  button.classList.add("loading");
  setStatus(
    "#calendar-status",
    force
      ? isAshareMarket()
        ? "正在刷新东方财富 A股财报日历..."
        : "正在刷新 Nasdaq 财报日历..."
      : "正在读取日历..."
  );
  try {
    const params = new URLSearchParams();
    if (month) params.set("month", month);
    if (force) params.set("force", "1");
    const payload = await fetchJson(`${calendarEndpoint()}?${params.toString()}`);
    renderCalendar(payload);
    setStatus(
      "#calendar-status",
      `完成：${payload.totalEvents} 个事件，用时 ${(payload.elapsedMs / 1000).toFixed(1)} 秒。`,
      "ok"
    );
  } catch (error) {
    setStatus("#calendar-status", `刷新失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
}

function financialPageParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    market: params.get("market") === "cn" ? "cn" : "us",
    symbol: params.get("symbol") || "",
    name: params.get("name") || ""
  };
}

function financialMetricMap(payload) {
  return Object.fromEntries((payload.metrics || []).map((metric) => [metric.key, metric]));
}

function financialValue(point, key) {
  const value = point?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function compactNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toLocaleString("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: Math.abs(value) >= 100 ? 0 : 1
  });
}

function formatFinancialValue(value, payload, unit = "money") {
  if (value == null || Number.isNaN(Number(value))) return "--";
  if (unit === "percent") return pct(Number(value));
  if (unit === "ratio") return `${compactNumber(Number(value), 2)}x`;
  return `${compactNumber(Number(value) / (payload.unitDivisor || 1), 2)}${payload.unitLabel || ""}`;
}

function yoyValue(points, index, key) {
  const current = financialValue(points[index], key);
  const currentPoint = points[index] || {};
  const priorIndex =
    currentPoint.quarter != null
      ? points.findIndex((point) => point.year === currentPoint.year - 1 && point.quarter === currentPoint.quarter)
      : index - 1;
  if (priorIndex < 0) return null;
  const prior = financialValue(points[priorIndex], key);
  if (current == null || prior == null || Math.abs(prior) < 1) return null;
  return (current - prior) / Math.abs(prior);
}

function chartColor(index) {
  return ["#2563eb", "#0f9f6e", "#c98500", "#7c3aed", "#ef4444", "#0891b2"][index % 6];
}

function renderFinancialCards(payload) {
  const points = financialDisplayPoints(payload);
  const latest = points[points.length - 1] || {};
  const metricMap = financialMetricMap(payload);
  const cards = ["revenue", "netIncome", "operatingCashFlow", "debtAssetRatio"].map((key) => {
    const metric = metricMap[key] || { label: key, unit: "money" };
    const value = financialValue(latest, key);
    const growth = yoyValue(points, points.length - 1, key);
    const growthClass = growth == null ? "muted" : growth >= 0 ? "good" : "bad";
    return `<div class="summary-item financial-summary-item">
      <span>${escapeHtml(metric.label)}</span>
      <strong>${formatFinancialValue(value, payload, metric.unit)}</strong>
      <small class="${growthClass}">同比 ${growth == null ? "--" : pct(growth)}</small>
    </div>`;
  });
  $("#financial-summary").innerHTML = cards.join("");
}

function pointLabel(point) {
  return point.periodLabel || (point.quarter ? `${point.year}Q${point.quarter}` : String(point.year || point.date || ""));
}

function financialDisplayPoints(payload) {
  const points = (payload.quarterly?.length ? payload.quarterly : payload.annual || [])
    .filter((point) => point.year)
    .sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return (a.quarter || 0) - (b.quarter || 0);
    });
  return points.slice(-20);
}

function disposeFinancialCharts() {
  state.financialCharts.forEach((chart) => chart.dispose());
  state.financialCharts = [];
}

function rawFinancialValue(value, currency) {
  if (value == null || Number.isNaN(Number(value))) return "--";
  return `${currency || ""}${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function financialTooltipFormatter(payload, metricMap) {
  return (items) => {
    const list = Array.isArray(items) ? items : [items];
    const axis = list[0]?.axisValueLabel || "";
    const rows = list
      .map((item) => {
        const key = item.seriesId || item.seriesName;
        const metric = metricMap[key] || { unit: "money" };
        const value = Array.isArray(item.value) ? item.value[1] : item.value;
        return `<div class="tooltip-row">
          <span>${item.marker}${escapeHtml(item.seriesName)}</span>
          <strong>${escapeHtml(formatFinancialValue(value, payload, metric.unit))}</strong>
          <em>${escapeHtml(rawFinancialValue(value, metric.unit === "percent" ? "" : payload.currency))}</em>
        </div>`;
      })
      .join("");
    return `<div class="financial-tooltip"><strong>${escapeHtml(axis)}</strong>${rows}</div>`;
  };
}

function moneyAxisFormatter(payload) {
  return (value) => formatFinancialValue(value, payload, "money");
}

function percentAxisFormatter(value) {
  return pct(Number(value));
}

function financialSeries(payload, points, key, options = {}) {
  const metricMap = financialMetricMap(payload);
  const metric = metricMap[key] || { label: key, unit: "money" };
  return {
    id: key,
    name: metric.label,
    type: options.type || "bar",
    yAxisIndex: options.yAxisIndex || 0,
    data: points.map((point) => financialValue(point, key)),
    smooth: options.smooth !== false,
    connectNulls: false,
    barMaxWidth: 26,
    symbolSize: 7,
    lineStyle: { width: 3 },
    itemStyle: options.color ? { color: options.color } : undefined,
    emphasis: { focus: "series" }
  };
}

function baseFinancialChartOption(title, payload, points, yAxes, series) {
  const metricMap = financialMetricMap(payload);
  return {
    color: series.map((item, index) => item.itemStyle?.color || chartColor(index)),
    title: { text: title, left: 0, top: 0, textStyle: { fontSize: 16, fontWeight: 800, color: "#101828" } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      appendToBody: true,
      formatter: financialTooltipFormatter(payload, metricMap)
    },
    legend: { top: 2, right: 0, type: "scroll" },
    grid: { left: 62, right: yAxes.length > 1 ? 72 : 28, top: 54, bottom: 64, containLabel: true },
    dataZoom: [
      { type: "inside", start: Math.max(0, 100 - (12 / Math.max(points.length, 1)) * 100), end: 100 },
      { type: "slider", height: 22, bottom: 12, start: Math.max(0, 100 - (12 / Math.max(points.length, 1)) * 100), end: 100 }
    ],
    xAxis: {
      type: "category",
      data: points.map(pointLabel),
      axisLabel: { rotate: points.length > 10 ? 35 : 0, color: "#344054", fontWeight: 700 }
    },
    yAxis: yAxes,
    series
  };
}

function chartContainer(title, id) {
  return `<section class="chart-card">
    <div class="chart-container" id="${escapeHtml(id)}" role="img" aria-label="${escapeHtml(title)}"></div>
  </section>`;
}

function renderFinancialCharts(payload, points) {
  disposeFinancialCharts();
  const chartDefs = [
    {
      id: "financial-chart-income",
      title: "营收与利润（季度）",
      yAxes: [
        { type: "value", name: payload.unitLabel, axisLabel: { formatter: moneyAxisFormatter(payload) }, splitLine: { lineStyle: { color: "#edf1f7" } } },
        { type: "value", name: `利润/${payload.unitLabel}`, axisLabel: { formatter: moneyAxisFormatter(payload) }, splitLine: { show: false } }
      ],
      series: [
        financialSeries(payload, points, "revenue", { type: "bar", color: "#2563eb" }),
        financialSeries(payload, points, "netIncome", { type: "line", yAxisIndex: 1, color: "#0f9f6e" }),
        financialSeries(payload, points, "operatingProfit", { type: "line", yAxisIndex: 1, color: "#c98500" })
      ]
    },
    {
      id: "financial-chart-cash",
      title: "现金流与预收/合同负债（季度）",
      yAxes: [
        { type: "value", name: payload.unitLabel, axisLabel: { formatter: moneyAxisFormatter(payload) }, splitLine: { lineStyle: { color: "#edf1f7" } } },
        { type: "value", name: `余额/${payload.unitLabel}`, axisLabel: { formatter: moneyAxisFormatter(payload) }, splitLine: { show: false } }
      ],
      series: [
        financialSeries(payload, points, "operatingCashFlow", { type: "bar", color: "#0891b2" }),
        financialSeries(payload, points, "contractLiabilities", { type: "line", yAxisIndex: 1, color: "#7c3aed" })
      ]
    },
    {
      id: "financial-chart-quality",
      title: "资产质量（季度末）",
      yAxes: [{ type: "value", name: payload.unitLabel, axisLabel: { formatter: moneyAxisFormatter(payload) }, splitLine: { lineStyle: { color: "#edf1f7" } } }],
      series: [
        financialSeries(payload, points, "accountsReceivable", { type: "bar", color: "#ef4444" }),
        financialSeries(payload, points, "inventory", { type: "bar", color: "#f59e0b" }),
        financialSeries(payload, points, "contractLiabilities", { type: "line", color: "#7c3aed" })
      ]
    },
    {
      id: "financial-chart-debt",
      title: "资产负债率（季度末）",
      yAxes: [{ type: "value", name: "比例", axisLabel: { formatter: percentAxisFormatter }, splitLine: { lineStyle: { color: "#edf1f7" } } }],
      series: [financialSeries(payload, points, "debtAssetRatio", { type: "line", color: "#475467" })]
    }
  ];
  $("#financial-charts").innerHTML = chartDefs.map((chart) => chartContainer(chart.title, chart.id)).join("");
  if (!window.echarts) {
    $("#financial-charts").innerHTML = '<div class="empty-cell">ECharts 加载失败，无法绘制图表。</div>';
    return;
  }
  chartDefs.forEach((definition) => {
    const element = document.getElementById(definition.id);
    if (!element) return;
    const chart = window.echarts.init(element, null, { renderer: "canvas" });
    chart.setOption(baseFinancialChartOption(definition.title, payload, points, definition.yAxes, definition.series));
    state.financialCharts.push(chart);
  });
}

function renderFinancialTable(payload, points) {
  const metricMap = financialMetricMap(payload);
  const columns = ["revenue", "netIncome", "operatingCashFlow", "contractLiabilities", "accountsReceivable", "inventory", "debtAssetRatio"];
  return `<section class="table-panel financial-table-panel">
    <div class="table-scroll">
      <table class="ranking-table">
        <thead>
          <tr><th>报告期</th>${columns.map((key) => `<th>${escapeHtml(metricMap[key]?.label || key)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${[...points]
            .reverse()
            .map(
              (point) =>
                `<tr><td>${escapeHtml(pointLabel(point))}<div class="muted">${escapeHtml(point.date || "")}</div></td>${columns
                  .map((key) => `<td>${formatFinancialValue(financialValue(point, key), payload, metricMap[key]?.unit)}</td>`)
                  .join("")}</tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  </section>`;
}

function renderFinancialMethod(payload) {
  const notes = payload.accuracyNotes || [];
  $("#financial-method").innerHTML = `<div class="criteria-grid">
    <div>
      <span>横坐标口径</span>
      <strong>季度报告期</strong>
      <p>${payload.quarterly?.length ? "优先展示季度序列，最近 20 个报告期可通过底部滑块缩放。" : "当前公司缺少季度序列，回退到年度序列。"}</p>
    </div>
    <div>
      <span>数据来源</span>
      <strong>${escapeHtml(payload.market === "cn" ? "东方财富结构化报表" : "SEC companyfacts")}</strong>
      <p>${escapeHtml(payload.source || "")}</p>
    </div>
    <div>
      <span>准确性说明</span>
      <strong>不做缺失值猜算</strong>
      <p>${escapeHtml(notes.join(" ") || "缺失或无法明确归属季度的数据不会被强行估算。")}</p>
    </div>
  </div>`;
}

function listHtml(items) {
  if (!items?.length) return '<p class="muted">暂无明确结论。</p>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderFinancialAiSection(title, items) {
  return `<div class="ai-analysis-section">
    <h3>${escapeHtml(title)}</h3>
    ${listHtml(items)}
  </div>`;
}

function evidenceStatusLabel(status) {
  return {
    ok: "已获取",
    partial: "部分",
    missing: "缺失",
    failed: "失败"
  }[status] || status || "--";
}

function evidenceStatusClass(status) {
  if (status === "ok") return "good";
  if (status === "failed") return "bad";
  return "muted";
}

function renderEvidenceCoverage(evidencePackage) {
  const coverage = evidencePackage?.coverage || [];
  if (!coverage.length) return "";
  return `<div class="ai-evidence-card">
    <div class="ai-evidence-title">
      <h3>资料覆盖</h3>
      <span>${escapeHtml(evidencePackage.source || "自动资料包")}</span>
    </div>
    <div class="ai-evidence-grid">
      ${coverage
        .map(
          (item) => `<div class="ai-evidence-item">
            <strong>${escapeHtml(item.title || item.category || "")}</strong>
            <span class="${evidenceStatusClass(item.status)}">${escapeHtml(evidenceStatusLabel(item.status))}</span>
            ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">来源</a>` : ""}
            ${item.excerptCount ? `<small>${escapeHtml(`摘录 ${item.excerptCount} 条`)}</small>` : ""}
            ${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ""}
          </div>`
        )
        .join("")}
    </div>
  </div>`;
}

function renderFinancialAiPanel(payload) {
  const panel = $("#financial-ai-panel");
  if (!panel) return;
  panel.hidden = false;
  if (payload.status === "loading") {
    panel.innerHTML = `<section class="ai-analysis-card">
      <div class="ai-analysis-header">
        <div>
          <span>大模型分析</span>
          <h2>正在分析财务报表...</h2>
        </div>
      </div>
      <p class="muted">仅在本次点击后调用模型，分析输入为当前页面已展示的结构化财务数据、公司主营资料和本地宏观行业上下文。</p>
    </section>`;
    return;
  }
  if (payload.status === "disabled") {
    panel.innerHTML = `<section class="ai-analysis-card">
      <div class="ai-analysis-header">
        <div>
          <span>大模型分析</span>
          <h2>未启用</h2>
        </div>
      </div>
      <p>${escapeHtml(payload.message || "未配置大模型 API Key。")}</p>
      <code class="setup-line">${escapeHtml(payload.setup || "OPENAI_API_KEY=\"你的 key\" npm start")}</code>
    </section>`;
    return;
  }
  if (payload.status === "error") {
    panel.innerHTML = `<section class="ai-analysis-card">
      <div class="ai-analysis-header">
        <div>
          <span>大模型分析</span>
          <h2>分析失败</h2>
        </div>
        <button class="secondary-button" id="rerun-financial-ai" type="button">重试</button>
      </div>
      <p class="bad">${escapeHtml(payload.message || "调用失败")}</p>
    </section>`;
    $("#rerun-financial-ai")?.addEventListener("click", () => loadFinancialAiAnalysis(true));
    return;
  }
  const analysis = payload.analysis || {};
  const providerLabel = payload.provider === "codex" ? "Codex" : payload.provider === "openai" ? "OpenAI" : "AI";
  panel.innerHTML = `<section class="ai-analysis-card">
    <div class="ai-analysis-header">
      <div>
        <span>大模型分析</span>
        <h2>${escapeHtml(payload.symbol || "")} ${escapeHtml(payload.name || "")}</h2>
      </div>
      <div class="ai-analysis-actions">
        <small>${providerLabel} · ${escapeHtml(payload.model || "")} · ${payload.cache === "hit" ? "缓存" : "新分析"} · ${escapeHtml(formatDateTime(payload.generatedAt))}</small>
        <button class="secondary-button" id="rerun-financial-ai" type="button">重新分析</button>
      </div>
    </div>
    <p class="ai-summary">${escapeHtml(analysis.summary || "")}</p>
    <div class="ai-overall">${escapeHtml(analysis.overall || "")}</div>
    ${renderEvidenceCoverage(payload.evidencePackage)}
    <div class="ai-analysis-grid">
      ${renderFinancialAiSection("增长", analysis.growth)}
      ${renderFinancialAiSection("盈利能力", analysis.profitability)}
      ${renderFinancialAiSection("现金流", analysis.cashFlow)}
      ${renderFinancialAiSection("资产负债", analysis.balanceSheet)}
      ${renderFinancialAiSection("产品壁垒/垄断性", analysis.productMoat)}
      ${renderFinancialAiSection("定价权", analysis.pricingPower)}
      ${renderFinancialAiSection("持续性", analysis.durability)}
      ${renderFinancialAiSection("经济/货币政策", analysis.macroPolicy)}
      ${renderFinancialAiSection("行业景气天花板", analysis.industryCeiling)}
      ${renderFinancialAiSection("增速确定性", analysis.growthCertainty)}
      ${renderFinancialAiSection("风险与异常", analysis.risks)}
      ${renderFinancialAiSection("后续关注", analysis.watchItems)}
    </div>
    <div class="ai-analysis-section ai-data-quality">
      <h3>数据准确性口径</h3>
      ${listHtml([...(payload.accuracyNotes || []), ...(analysis.dataQuality || [])])}
    </div>
    <p class="ai-disclaimer">${escapeHtml(analysis.disclaimer || "本分析仅基于公开结构化财务数据，不构成投资建议。")}</p>
  </section>`;
  $("#rerun-financial-ai")?.addEventListener("click", () => loadFinancialAiAnalysis(true));
}

function renderFinancials(payload) {
  const points = financialDisplayPoints(payload);
  const name = payload.name || financialPageParams().name || payload.symbol;
  state.financialPayload = payload;
  state.financialAiAnalysis = null;
  const aiPanel = $("#financial-ai-panel");
  if (aiPanel) {
    aiPanel.hidden = true;
    aiPanel.innerHTML = "";
  }
  const aiButton = $("#analyze-financials");
  if (aiButton) aiButton.disabled = false;
  $("#financial-title").textContent = `${payload.symbol} ${name}`;
  $("#financial-subtitle").textContent = `${payload.market === "cn" ? "A股" : "美股"} | ${payload.source} | 更新 ${formatDateTime(
    payload.generatedAt
  )}`;
  renderFinancialCards(payload);
  renderFinancialMethod(payload);
  if (!points.length) {
    disposeFinancialCharts();
    $("#financial-charts").innerHTML = '<div class="empty-cell">暂无历史财务数据。</div>';
    $("#financial-table").innerHTML = "";
    return;
  }
  renderFinancialCharts(payload, points);
  $("#financial-table").innerHTML = renderFinancialTable(payload, points);
}

async function loadFinancialAiAnalysis(force = false) {
  const params = financialPageParams();
  const button = $("#analyze-financials");
  if (button) {
    button.disabled = true;
    button.classList.add("loading");
    button.textContent = force ? "重新分析中" : "AI 分析中";
  }
  renderFinancialAiPanel({ status: "loading" });
  try {
    const payload = await fetchJson(
      `/api/financials/analyze?market=${encodeURIComponent(params.market)}&symbol=${encodeURIComponent(params.symbol)}${force ? "&force=1" : ""}`
    );
    state.financialAiAnalysis = payload;
    renderFinancialAiPanel(payload);
  } catch (error) {
    renderFinancialAiPanel({ status: "error", message: error.message });
  } finally {
    if (button) {
      button.disabled = !state.financialPayload;
      button.classList.remove("loading");
      button.textContent = "AI 分析";
    }
  }
}

async function loadFinancials(force = false) {
  const params = financialPageParams();
  const button = $("#refresh-financials");
  if (button) {
    button.disabled = true;
    button.classList.add("loading");
  }
  setStatus("#financial-status", force ? "正在刷新财务报表数据..." : "正在读取财务报表数据...");
  try {
    const payload = await fetchJson(
      `/api/financials?market=${encodeURIComponent(params.market)}&symbol=${encodeURIComponent(params.symbol)}${force ? "&force=1" : ""}`
    );
    renderFinancials(payload);
    setStatus("#financial-status", `完成：读取 ${financialDisplayPoints(payload).length} 个报告期。`, "ok");
  } catch (error) {
    setStatus("#financial-status", `读取失败：${error.message}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("loading");
    }
  }
}

function initFinancials() {
  const params = financialPageParams();
  document.body.dataset.market = params.market;
  if (!params.symbol) {
    setStatus("#financial-status", "缺少公司代码。", "error");
    return;
  }
  $("#refresh-financials")?.addEventListener("click", () => loadFinancials(true));
  $("#analyze-financials")?.addEventListener("click", () => loadFinancialAiAnalysis(false));
  window.addEventListener("resize", () => {
    state.financialCharts.forEach((chart) => chart.resize());
  });
  loadFinancials(false);
}

function initRanking() {
  $("#refresh-ranking").addEventListener("click", () => loadRanking(true));
  $("#apply-ranking")?.addEventListener("click", () => loadRanking(false));
  $("#apply-ranking-inline")?.addEventListener("click", () => loadRanking(false));
  restoreAnalysisOptions();
  ["analysis-limit", "reuse-analysis", "include-cash-flow", "cash-flow-threshold", "focus-companies", "custom-keywords"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("change", persistAnalysisOptions);
  });
  $("#focus-companies")?.addEventListener("input", () => {
    persistAnalysisOptions();
    if (state.ranking) renderRanking(state.ranking);
    scheduleFocusAutoSearch();
  });
  $("#focus-companies")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void loadRanking(false);
    }
  });
  document.querySelectorAll("[data-sort-key]").forEach((button) => {
    button.addEventListener("click", () => setRankingSort(button.dataset.sortKey));
  });
  updateSortIndicators();
  loadRanking(false);
}

function initCalendar() {
  const monthInput = $("#month-input");
  monthInput.value = isAshareMarket() ? "" : currentMonth();
  $("#refresh-calendar").addEventListener("click", () => loadCalendar(true));
  $("#prev-month").addEventListener("click", () => {
    monthInput.value = shiftMonth(monthInput.value || currentMonth(), -1);
    loadCalendar(false);
  });
  $("#next-month").addEventListener("click", () => {
    monthInput.value = shiftMonth(monthInput.value || currentMonth(), 1);
    loadCalendar(false);
  });
  monthInput.addEventListener("change", () => loadCalendar(false));
  loadCalendar(false);
}

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "ranking") initRanking();
  if (page === "calendar") initCalendar();
  if (page === "financials") initFinancials();
});

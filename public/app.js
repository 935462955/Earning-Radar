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
  expandedBusinessDescriptions: new Set()
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

function calendarEndpoint() {
  return isAshareMarket() ? "/api/ashare-calendar" : "/api/calendar";
}

function companyProfilesEndpoint() {
  return isAshareMarket() ? "/api/ashare-company-profiles" : "/api/company-profiles";
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
  const reportLabel = payload.reportingFrame?.label
    ? `报告期 ${payload.reportingFrame.label}`
    : payload.range.label;
  $("#ranking-subtitle").textContent =
    payload.market === "cn"
      ? `${reportLabel} | 已披露至 ${payload.range.today} | 更新 ${formatDateTime(payload.generatedAt)}`
      : `${reportLabel} | 披露窗口 ${payload.range.start} 至 ${payload.range.today} | 更新 ${formatDateTime(payload.generatedAt)}`;
  $("#summary-scanned").textContent = payload.totals.scanned;
  $("#summary-ranked").textContent = payload.totals.ranked;
  $("#summary-hot").textContent = payload.rows.filter((row) => row.highlight).length;
  $("#summary-cache").textContent = payload.cache === "fresh" ? "已刷新" : "缓存";
  renderDiagnostics(payload);

  const body = $("#ranking-body");
  if (!payload.rows.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty-cell">当前股票池暂无符合条件的财报。</td></tr>';
    return;
  }

  updateSortIndicators();
  body.innerHTML = sortedRankingRows(payload.rows)
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
            <a href="${escapeHtml(row.stockUrl)}" target="_blank" rel="noreferrer">${escapeHtml(
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
        <td>${revenue}<div class="muted">${escapeHtml(row.metrics.revenue?.current?.display || "")}</div></td>
        <td>${netIncome}<div class="muted">${escapeHtml(row.metrics.netIncome?.current?.display || "")}</div></td>
        <td>${margin || '<span class="muted">--</span>'}</td>
        <td><div class="signal-list">${rowSignalChips(row)}</div></td>
        <td class="link-cell">
          <a href="${escapeHtml(row.stockUrl)}" target="_blank" rel="noreferrer">股票页</a>
          <a href="${escapeHtml(row.filing.url)}" target="_blank" rel="noreferrer">财报</a>
        </td>
      </tr>`;
    })
    .join("");

  if (options.scrollToTop) {
    requestAnimationFrame(scrollRankingTableToTop);
  }
}

async function loadRanking(force = false) {
  const button = $("#refresh-ranking");
  const applyButton = $("#apply-ranking");
  button.disabled = true;
  if (applyButton) applyButton.disabled = true;
  button.classList.add("loading");
  setStatus(
    "#ranking-status",
    force
      ? isAshareMarket()
        ? "正在刷新东方财富 A股财报数据，首次可能需要几十秒..."
        : "正在从 SEC 刷新，首次可能需要几十秒到一两分钟..."
      : "正在应用设置并读取缓存..."
  );
  try {
    persistAnalysisOptions();
    const query = rankingQuery(force);
    const payload = await fetchJson(`${rankingEndpoint()}${query ? `?${query}` : ""}`);
    renderRanking(payload);
    const timing = payload.cache === "hit" ? "命中缓存" : `用时 ${(payload.elapsedMs / 1000).toFixed(1)} 秒`;
    const forcedText = payload.totals.forced ? `，指定分析 ${payload.totals.forced} 家` : "";
    setStatus(
      "#ranking-status",
      `完成：${payload.totals.ranked} 家入榜${forcedText}，${timing}。`,
      "ok"
    );
  } catch (error) {
    setStatus("#ranking-status", `刷新失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
    if (applyButton) applyButton.disabled = false;
    button.classList.remove("loading");
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
          <span>${timeLabel(item.time)}</span>
          ${megaCap ? "<span class=\"mega-cap-badge\">千亿市值</span>" : ""}
          <span>市值 ${escapeHtml(formatMarketCap(item.marketCap, item.marketCapCurrency || "$"))}</span>
          <span>${escapeHtml(item.fiscalQuarterEnding || "")}</span>
          <span>${escapeHtml(item.metricLabel || `EPS ${item.epsForecast || "--"}`)}</span>
          ${industry ? `<span>${escapeHtml(industry)}</span>` : ""}
        </div>
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
          <a href="${escapeHtml(item.stockUrl)}" target="_blank" rel="noreferrer">股票页</a>
          <a href="${escapeHtml(item.nasdaqUrl)}" target="_blank" rel="noreferrer">${escapeHtml(
            item.calendarLabel || "日历页"
          )}</a>
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
    const preview = events
      .slice(0, 5)
      .map(
        (item) =>
          `<span class="${isMegaCap(item) ? "is-mega-cap" : ""}">${escapeHtml(
            item.symbol
          )}</span>`
      )
      .join("");
    const more = events.length > 5 ? `<em>+${events.length - 5}</em>` : "";
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
  const month = $("#month-input").value || currentMonth();
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
    const payload = await fetchJson(
      `${calendarEndpoint()}?month=${encodeURIComponent(month)}${force ? "&force=1" : ""}`
    );
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

function initRanking() {
  $("#refresh-ranking").addEventListener("click", () => loadRanking(true));
  $("#apply-ranking")?.addEventListener("click", () => loadRanking(false));
  restoreAnalysisOptions();
  ["analysis-limit", "reuse-analysis", "include-cash-flow", "cash-flow-threshold", "focus-companies", "custom-keywords"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("change", persistAnalysisOptions);
  });
  document.querySelectorAll("[data-sort-key]").forEach((button) => {
    button.addEventListener("click", () => setRankingSort(button.dataset.sortKey));
  });
  updateSortIndicators();
  loadRanking(false);
}

function initCalendar() {
  const monthInput = $("#month-input");
  monthInput.value = currentMonth();
  $("#refresh-calendar").addEventListener("click", () => loadCalendar(true));
  $("#prev-month").addEventListener("click", () => {
    monthInput.value = shiftMonth(monthInput.value, -1);
    loadCalendar(false);
  });
  $("#next-month").addEventListener("click", () => {
    monthInput.value = shiftMonth(monthInput.value, 1);
    loadCalendar(false);
  });
  monthInput.addEventListener("change", () => loadCalendar(false));
  loadCalendar(false);
}

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "ranking") initRanking();
  if (page === "calendar") initCalendar();
});

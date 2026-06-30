# 财报雷达启动说明

这是一个本地运行的财报筛选网页，包含美股亮眼度排名、美股财报日历、A股亮眼度排名和 A股财报日历四个页面。

## 启动

项目建议使用 Node.js 20 或更高版本。ECharts 已作为前端图表库加入并随 `public/vendor/echarts.min.js` 本地提供；如需重新安装依赖，可执行 `pnpm install`。

```bash
cd /Users/bytedance/Documents/Codex/2026-06-17/new-chat
SEC_USER_AGENT="earnings-radar your@email.com" node server.js
```

财务报表页的“AI 分析”默认点击后唤起本机 `codex exec` 做只读分析，不会在页面加载或刷新图表时自动调用。推荐复制本地配置文件；`config/ai.local.json` 已被 `.gitignore` 排除，不会上传到 GitHub。

```bash
cp config/ai.example.json config/ai.local.json
cp config/analysis-context.example.json config/analysis-context.local.json
```

然后编辑 `config/ai.local.json`：

```json
{
  "analysisProvider": "codex",
  "codex": {
    "command": "codex",
    "model": "",
    "timeoutMs": 180000,
    "sandbox": "read-only"
  },
  "openai": {
    "apiKey": "",
    "model": "gpt-4.1-mini",
    "baseUrl": "https://api.openai.com/v1",
    "timeoutMs": 60000
  }
}
```

如果要改回 OpenAI API，可把 `analysisProvider` 改成 `openai` 并填写 `openai.apiKey`。环境变量仍可临时覆盖配置文件：

```bash
AI_ANALYSIS_PROVIDER="openai" OPENAI_API_KEY="你的 key" OPENAI_MODEL="gpt-4.1-mini" node server.js
```

如果页面提示 `spawn codex ENOENT`，说明服务进程没有在 `PATH` 中找到 Codex CLI。后端会自动尝试解析常见安装路径；仍失败时，可以把 `config/ai.local.json` 的 `codex.command` 改成绝对路径，例如 macOS 桌面版通常是：

```json
{
  "codex": {
    "command": "/Applications/Codex.app/Contents/Resources/codex"
  }
}
```

`config/analysis-context.local.json` 用来给 AI 分析补充当前经济/货币政策、行业景气天花板、供需约束和单家公司定性判断。该文件也被 `.gitignore` 排除，不会上传 GitHub。没有填写时，系统会提供一个“默认分析框架”，AI 会把宏观和行业结论标成待验证变量；只有你填写了实时政策、行业价格/订单/库存等上下文后，才会升级为更明确的外部结论。

启动后打开：

- 首页排名：http://localhost:4173/
- 财报日历：http://localhost:4173/calendar.html
- A股排名：http://localhost:4173/ashare.html
- A股日历：http://localhost:4173/ashare-calendar.html
- 财务分析页会从排名/日历里的“财务分析”按钮进入，例如：http://localhost:4173/financials.html?market=cn&symbol=002384

如果不设置 `SEC_USER_AGENT`，程序会使用默认值，但正式长期使用时建议换成自己的邮箱，方便符合 SEC EDGAR 的访问规范。

## 数据刷新

- 首页点击“应用设置”会优先读取已有缓存，适合调整分析数量、自定义关键词和现金流选项。
- 首页点击“刷新数据”会重新拉取 SEC 数据并重算当前披露窗口的亮眼度排名；如果正式 10-Q/10-K 结构化事实还没进入 SEC frames，会尝试读取当前窗口内 8-K/6-K 的业绩发布稿 Exhibit 补漏。
- 日历页点击“刷新日历”会重新拉取 Nasdaq 财报日历。
- 美股排名和日历里的股票行情入口默认使用国内页面：东方财富为主链接，并同时提供雪球、新浪备用入口；不再使用 Yahoo Finance 作为股票页，避免大陆网络打不开。
- 日历页公司卡片会显示 Nasdaq 日历返回的市值，并在选中日期后按需加载公司主营业务简介；简介优先来自 Nasdaq company profile，失败时回退到 SEC submissions 的行业分类。公司名会尝试翻译成中文，翻译成功时显示在英文名下方；简介默认折叠，可点击展开/收起，旁边有“翻译”按钮，点击后按单家公司翻译成中文并缓存结果。市值超过 1000 亿美元的公司会在日历格子和当天公司卡片中高亮。
- A股页面使用东方财富公开数据：排名取 `RPT_LICO_FN_CPD` 业绩表现结构化数据，经营现金流取 `RPT_DMSK_FN_CASHFLOW`，市值/行业取 `RPT_VALUEANALYSIS_DET`，日历按公告日聚合，个股简介取东方财富 F10 公司资料。A股列表会排除 ST / *ST 公司；A股日历中的市值以人民币计，超过 1000 亿元人民币的公司会高亮。
- 财务分析页会展示营收、归母净利润、经营现金流、预收/合同负债、应收、存货和资产负债率等图表；A股来自东方财富三大财务报表，美股来自 SEC companyfacts XBRL。
- 财务分析页默认按季度展示横坐标。A股利润表/现金流量表原始季报多为年初至报告期末累计口径，页面按同一年相邻报告期差额拆成单季值；资产负债表项目使用报告期末余额。美股季度图表只使用 SEC companyfacts 中带明确季度 frame 的 XBRL 事实，缺失项不强行估算。
- 财务分析页的大模型分析为点击后按需启用：默认把当前结构化财务数据、公司主营/行业资料、季度口径说明、缺失值情况、本地宏观行业上下文和自动资料包传给 `codex exec` 做只读分析，结果会按输入哈希缓存 7 天；刷新图表不会自动调用大模型。分析结果会覆盖财务表现、产品壁垒/垄断性、定价权、持续性、当前经济/货币政策、行业景气天花板和业绩增速确定性。也可以在配置中切换为 OpenAI Responses API。
- 如果本地宏观或行业上下文缺失，AI 分析会在调用模型前自动联网补充公开数据：美股宏观优先读取 FRED CSV 指标（联邦基金利率、10年期美债、期限利差、CPI、失业率），行业上下文通过 DuckDuckGo Lite 检索公开网页摘要；A股宏观和行业上下文也会通过公开网页摘要补充。联网补充数据缓存 12 小时，搜索摘要只作为线索，最终结论仍需结合财报和公告原文验证。
- AI 分析会额外展示“资料覆盖”：美股自动尝试读取 SEC 最新 10-Q/10-K/20-F/40-F、招股书/发行文件和 8-K/6-K 主文档，并抽取需求、价格、竞争、客户、产能、现金流等关键词上下文；A股自动尝试匹配东方财富公告中的财报、招股说明书和投资者关系/业绩说明会记录链接。A股 PDF 正文解析暂未接入，若只拿到链接会标为“部分”。
- 首次强制刷新可能需要几十秒到一两分钟，后续会命中本地 `.cache/` 缓存，通常是秒级。
- 排名中的单公司分析结果和 8-K/6-K 业绩发布稿解析结果会按披露季度、公司、accession 和当前分析参数长期缓存在 `.cache/` 中；同一批公司已经分析过后，即使第二天再次打开或刷新，也会优先复用缓存，不会每天重新拉取并解析同一份财报。如果同一家公司后来提交了新的 8-K/6-K、10-Q 或 10-K，SEC accession 会变化，缓存 key 也会变化，系统会重新拉取并解析新财报。
- 排名列表会显示每家公司下一次财报日期。美股使用 Nasdaq earnings calendar 按未来日期批量扫描，默认最多查未来 `90` 天，也就是最多 `91` 次日历接口；找到本页所有公司后会按 10 天批次提前停止，每个日期缓存 6 小时。A股使用东方财富 `RPT_PUBLIC_BS_APPOIN` 预约披露表按下一报告期批量查询，一页 500 条；如果下一报告期预约表已经公布，通常约 1-12 次接口，未公布时 1 次返回空并显示“未公布”。这两者都不是每家公司单独请求。

## 首页筛选口径

首页先从 SEC EDGAR `frames` 接口读取当前报告期与去年同期的营收、归母净利润、毛利、经营利润等 XBRL 聚合数据，再计算亮眼度分数。如果静态池公司、指定公司或最近 10 天日历公司已经通过 8-K/6-K 披露业绩发布稿，但正式 10-Q/10-K 尚未进入 frames，会继续读取该 8-K/6-K 及 Exhibit 99.1 等业绩附件，解析营收、净利润、毛利、经营利润和经营现金流来补漏；该窗口可用 `EARNINGS_RELEASE_LOOKBACK_DAYS` 调整。美股净利口径优先使用 `NetIncomeLoss`，也就是归属于母公司/普通股股东的净利润；若缺失才回退到合并口径 `ProfitLoss`。

当前实现不调用大模型逐份阅读财报。数值部分优先来自 SEC XBRL 结构化数据，必要时来自 8-K/6-K 业绩发布稿表格解析；文本部分是对 SEC 主文档和业绩附件做关键词/正则匹配。

首页扫描池现在不是纯静态池，而是：

- `config/universe.json` 里的静态股票池。
- 当前披露窗口内已经出现在 Nasdaq 财报日历里的所有公司。

两者会自动合并、去重后再进入 SEC 匹配和财报评分流程。日历接口如果某一天拉取失败，会在首页“覆盖与异常”中列出该日期。

入榜需要同时满足：

- 股票在合并扫描池内，并能匹配到 SEC CIK。
- 在当前报告期的 SEC frames 中至少有营收或归母净利润事实；或者在静态池公司、指定公司、最近 10 天日历公司对应的 8-K/6-K 业绩发布稿中解析出营收或归母净利润。
- 触发营收增长、归母净利润增长/扭亏、毛利率改善或经营利润率改善等打分条件。归母净利润扭亏需要同时具备实质性：当前归母净利润不少于 100 万美元，或归母净利率不低于 3%；否则只显示数值，不计入“扭亏”加分。
- 能在 SEC submissions 中找到当前披露窗口内的 `10-Q`、`10-K`、`20-F`、`40-F`，或带业绩发布稿附件的 `8-K`/`6-K`。

高景气标注来自入围公司财报正文的文本扫描：美股扫描 SEC 主文档，A股扫描东方财富财报 PDF。规则会匹配中英文里的供不应求、行业高景气、需求旺盛、供给偏紧、涨价、新品放量/超预期、客户/市场拓展等表达，并过滤 `unfavorable pricing`、无法转嫁成本上涨、市场风险等负向语境，避免把风险披露误判为景气信号。

## 分析设置

首页可以手动控制：

- `分析候选数`：候选公司会先按日历日期/披露日期排序，再分析指定数量。
- `指定公司`：输入股票代码或公司名称，多个用逗号、分号或换行分隔。匹配到的公司会被强制加入本次榜单，即使不满足亮眼筛选条件也会显示评分；未匹配或本期无财报数据的公司会出现在“覆盖与异常”中。
- `输入不变时复用已分析结果`：同一家公司、同一报告期、同一份财报、同一套自定义规则没有变化时，直接复用上一次单公司分析缓存。
- `纳入经营现金流同比`：启用后会从 SEC XBRL frames 读取 `NetCashProvidedByUsedInOperatingActivities` 等经营现金流概念，并按阈值纳入打分和自定义发现。
- `自定义文本关键词`：每行一条规则，格式可以是 `标签: keyword1, keyword2`，例如：

```text
现金流改善: operating cash flow increased, cash flow from operations increased
AI订单: AI orders, AI backlog, accelerated AI demand
```

首页的“覆盖与异常”面板会列出可能导致遗漏或未入榜的项目，包括：

- SEC frames 接口失败。
- 股票池 ticker 未匹配 CIK。
- SEC frames 无当前期事实。
- 候选超过补全上限。
- 财报链接补全失败。
- 当前披露窗口内财报缺失。
- 文本主文档缺失或文本解析失败。
- 有数据但未触发亮眼条件。

A股排名页复用同一套交互：可以控制展示候选数、指定公司、启用经营现金流同比、输入行业/主题关键词，并在“覆盖与异常”里查看未展示、未触发条件、指定公司未匹配或估值/市值缺失的公司。A股当前使用东方财富结构化数据和公司资料，不调用大模型，也不逐字解析 PDF 财报文本。

## 股票池

静态补充股票池在：

```text
config/universe.json
```

需要固定关注某些公司时，修改里面的 `symbols` 数组后刷新首页即可。即使不在这个文件里，只要公司出现在当前披露窗口的 Nasdaq 财报日历中，也会自动进入首页扫描池。

## 常用命令

```bash
# 启动服务
node server.js

# 检查接口状态
curl http://localhost:4173/api/status

# 读取首页排名数据
curl http://localhost:4173/api/rankings

# 强制刷新首页排名
curl "http://localhost:4173/api/rankings?force=1"

# 读取某个月的财报日历
curl "http://localhost:4173/api/calendar?month=2026-06"

# 读取 A股排名数据
curl "http://localhost:4173/api/ashare-rankings"

# 读取 A股某个月的财报日历
curl "http://localhost:4173/api/ashare-calendar?month=2026-04"
```

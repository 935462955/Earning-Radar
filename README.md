# 财报雷达启动说明

这是一个本地运行的财报筛选网页，包含美股亮眼度排名、美股财报日历、A股亮眼度排名和 A股财报日历四个页面。

## 启动

项目没有外部依赖，直接用 Node.js 启动即可。建议使用 Node.js 20 或更高版本。

```bash
cd /Users/bytedance/Documents/Codex/2026-06-17/new-chat
SEC_USER_AGENT="earnings-radar your@email.com" node server.js
```

启动后打开：

- 首页排名：http://localhost:4173/
- 财报日历：http://localhost:4173/calendar.html
- A股排名：http://localhost:4173/ashare.html
- A股日历：http://localhost:4173/ashare-calendar.html

如果不设置 `SEC_USER_AGENT`，程序会使用默认值，但正式长期使用时建议换成自己的邮箱，方便符合 SEC EDGAR 的访问规范。

## 数据刷新

- 首页点击“应用设置”会优先读取已有缓存，适合调整分析数量、自定义关键词和现金流选项。
- 首页点击“刷新数据”会重新拉取 SEC 数据并重算当前披露窗口的亮眼度排名。
- 日历页点击“刷新日历”会重新拉取 Nasdaq 财报日历。
- 日历页公司卡片会显示 Nasdaq 日历返回的市值，并在选中日期后按需加载公司主营业务简介；简介优先来自 Nasdaq company profile，失败时回退到 SEC submissions 的行业分类。公司名会尝试翻译成中文，翻译成功时显示在英文名下方；简介默认折叠，可点击展开/收起，旁边有“翻译”按钮，点击后按单家公司翻译成中文并缓存结果。市值超过 1000 亿美元的公司会在日历格子和当天公司卡片中高亮。
- A股页面使用东方财富公开数据：排名取 `RPT_LICO_FN_CPD` 业绩表现结构化数据，经营现金流取 `RPT_DMSK_FN_CASHFLOW`，市值/行业取 `RPT_VALUEANALYSIS_DET`，日历按公告日聚合，个股简介取东方财富 F10 公司资料。A股列表会排除 ST / *ST 公司；A股日历中的市值以人民币计，超过 1000 亿元人民币的公司会高亮。
- 首次强制刷新可能需要几十秒到一两分钟，后续会命中本地 `.cache/` 缓存，通常是秒级。

## 首页筛选口径

首页先从 SEC EDGAR `frames` 接口读取当前报告期与去年同期的营收、净利润、毛利、经营利润等 XBRL 聚合数据，再计算亮眼度分数。

当前实现不调用大模型逐份阅读财报。数值部分来自 SEC XBRL 结构化数据，文本部分是对 SEC 主文档做关键词/正则匹配。

首页扫描池现在不是纯静态池，而是：

- `config/universe.json` 里的静态股票池。
- 当前披露窗口内已经出现在 Nasdaq 财报日历里的所有公司。

两者会自动合并、去重后再进入 SEC 匹配和财报评分流程。日历接口如果某一天拉取失败，会在首页“覆盖与异常”中列出该日期。

入榜需要同时满足：

- 股票在合并扫描池内，并能匹配到 SEC CIK。
- 在当前报告期的 SEC frames 中至少有营收或净利润事实。
- 触发营收增长、净利润增长/扭亏、毛利率改善或经营利润率改善等打分条件。
- 能在 SEC submissions 中找到当前披露窗口内的 `10-Q`、`10-K`、`20-F` 或 `40-F`。

高景气标注来自入围公司 SEC 主文档的文本扫描，重点匹配供不应求、行业高景气、需求旺盛、供给偏紧、涨价、新品超预期等表达。

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

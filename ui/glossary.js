// Vocabulary window (owner 2026-09-17): the fixed vocabulary of Spec §1.5, §1.6 and §2 with a formal
// definition, the names the industry uses for the same thing, and what the Keeper does to obtain each
// one. Shown in English or Chinese, switchable in the window (the Spec it comes from is Chinese; the
// interface's fixed text is English). Counts are computed from the current project's graph.
import { api, h, openDialog, state } from './app.js';
import { CATEGORY_COLOR, CATEGORY_COLUMN } from './graph.js';

const T = {
  en: { title: 'Vocabulary', intro: 'A fixed vocabulary, the same for every project. Nodes keep the project\'s own names and numbers; only the category is shared, so legend, filters and layout work the same everywhere. In the graph, shape and colour tell the kind of object: a document for Product intent, a long hexagon for Work & plan (Plan and Work item in two colours), and for Observed reality a folder at the foot of each area’s column (an oval when drawn one by one). The category is written on each object. Marks sit on the corner: a star for what is new or changed, a flag, ❓ for a note (lit while it needs you), Update pending.',
    categories: 'Categories', category: 'Category', definition: 'Definition', also: 'Also called in the industry', keeper: 'What the Keeper does to obtain it', inProject: (n) => `${n} in this project`,
    relations: 'Relations', relIntro: 'Every relation carries a Claim (from the material, or the Keeper\'s summary), a basis (Explicit or Inferred), Evidence (sources, fact records, how far the facts go) and the Keeper\'s assessment.', type: 'Type', meaning: 'Meaning', example: 'Example',
    status: 'Status words', word: 'Word', values: 'Values', rule: 'Rule', column: { 'Product intent': 'Product intent', 'Work & plan': 'Work & plan', 'Observed reality': 'Observed reality', 'Change': 'Change' } },
  zh: { title: '词表', intro: '固定词表，对所有项目一样。节点显示项目自己的名字和编号，只有类别是通用的，图例、筛选和布局靠它。图上形状和颜色按对象的三类分：产品意图是文档形；工作与计划是拉长的六边形，Plan 和 Work item 各一种颜色；观察到的结果收在每列底部的文件夹里，逐个画出时是椭圆。类别写在对象上。标记在角上：★ 表示新增或有变动，另有 ⚑、❓ note（要你处理的醒目）、⟳ Update pending。',
    categories: '类别', category: '类别', definition: '定义', also: '业界常叫', keeper: 'Keeper 怎么得到它', inProject: (n) => `本项目 ${n} 个`,
    relations: '关系', relIntro: '每条关系带 Claim（材料原话或 Keeper 概括）、依据（Explicit / Inferred）、Evidence（来源、事实底稿、事实到了哪里）和 Keeper 的评估。', type: '类型', meaning: '含义', example: '例子',
    status: '状态词', word: '词', values: '取值', rule: '规则', column: { 'Product intent': '产品意图', 'Work & plan': '工作与计划', 'Observed reality': '观察到的现实', 'Change': '变化' } },
};

const CATEGORIES = [
  { name: "Owner's words",
    def: { en: 'What the owner said, or explicitly confirmed, in a session: one point per item, each with the owner\'s own words and where they were said. The top layer of the product reference; the product, goals, requirements and designs refine it.', zh: 'owner 在会话里直接说的、明确确认的意思，逐条提炼，每条带原话和出处。产品参照的最上层；产品、目标、需求和设计细化它。' },
    also: { en: 'stakeholder statement · founder\'s brief · voice of the customer · verbatim requirement · the "as the owner put it" of a PRD', zh: '利益相关者陈述 · 创始人口述 · 客户原声（voice of the customer）· 原话需求 · PRD 里的「owner 原话」' },
    keeper: { en: 'Taken first, from the owner\'s own messages in the sessions (not whole sessions) and from decision records that copy the owner\'s words; a project that already keeps this layer is used as it is. An agent\'s restatement is not one unless the owner confirmed it. Drift is judged by how far a description has moved from these words. On the graph they are one group on top, with its count, folded until opened.', zh: '最先整理：从会话里 owner 自己的发言（不读整段会话），以及照录 owner 原话的决定记录里取；项目已经保存了这一层的直接用。agent 的复述不算，除非 owner 确认过。漂移按一份描述离这些原话有多远来判。图上它们收成最上面的一组，写明条数，默认收起。' } },
  { name: 'Product',
    def: { en: 'The one document that describes the whole product: what it is, for whom, and which parts it has. The root of the graph; goals refine it.', zh: '描述整个产品的那一份文档：它是什么、给谁、由哪几块组成。graph 的根节点，Goal 细化它。' },
    also: { en: 'product.md · product overview · product brief · one-pager · product definition · charter', zh: 'product.md · 产品全貌 · 产品简述（product brief）· 一页纸 · 产品定义 · 立项书（charter）' },
    keeper: { en: 'Taken from product.md when the project has one, otherwise from the document the project designates as its product overview (a product-and-modules design, for example). At most one Current item per project; the Product reference job writes it first and lets each Goal refine it. A project without such a document gets no Product node.', zh: '项目有 product.md 就用它；没有就用项目指定为产品全貌的文档（例如「产品与 Module」设计）。每个项目至多一项 Current；产品参照 job 先写它，再让每个 Goal 细化它。没有这种文档的项目不补空节点。' } },
  { name: 'Goal',
    def: { en: 'A product purpose or user effect: why the product exists and what a user should get.', zh: '产品目的或用户效果：这个产品为什么存在、用户应当得到什么。' },
    also: { en: 'product goal · objective (the O of OKR) · vision statement · north-star outcome · user outcome · the "why" of a PRD', zh: '产品目标 · objective（OKR 的 O）· 愿景（vision）· 北极星结果 · 用户效果 · PRD 里的「为什么」' },
    keeper: { en: 'Read from intent material: product.md, the PRD\'s goals, a design\'s "effects" section, a README\'s purpose paragraph, and owner statements in the Keeper chat. Established by the Product reference job. Explicit when the material states it; Inferred, with a project-level note, when only README or issues exist.', zh: '从意图类材料提取：product.md、PRD 的目标章节、设计文档的「效果」节、README 的目的段，以及 owner 在 Keeper 对话里的陈述。由产品参照 job 建立；材料写明为 Explicit，只有 README/Issue 可依时为 Inferred 并在项目级 note 说明。' } },
  { name: 'Area',
    def: { en: 'A part of the product: a Module, a feature, or a theme the Keeper grouped work under.', zh: '产品的一块：Module、功能，或 Keeper 归纳出的主题。' },
    also: { en: 'module · component · subsystem · feature area · domain / bounded context · epic · workstream · product area', zh: '模块（module）· 组件（component）· 子系统 · 功能域（feature area）· 领域 / bounded context · epic · 工作流（workstream）· 产品区域' },
    keeper: { en: 'Taken from the project\'s formal Modules when it has them; otherwise the Keeper groups work by user effect or capability (Inferred). Added, merged, split or retired only with material behind it. Each area later receives an area understanding: the effect reached now, remaining gaps, and what each work thread contributes.', zh: '项目有正式 Module 就用 Module；没有时 Keeper 按用户效果或能力归纳（Inferred）。有材料支撑才新增、合并、拆分或退役。之后每个区域形成区域理解：当前达到的效果、剩余缺口、各工作脉络的贡献。' } },
  { name: 'Requirement',
    def: { en: 'What the product must do or provide, as stated by the project.', zh: '项目写明的需求或功能描述：产品必须做到什么。' },
    also: { en: 'requirement · PRD item · user story · acceptance criteria · functional spec item · feature request · task contract', zh: '需求 · PRD 条目 · 用户故事（user story）· 验收条件（acceptance criteria）· 功能规格条目 · 功能请求 · task contract' },
    keeper: { en: 'Extracted from intent material (PRD, requirement lists, task contracts) and owner statements, with validity, basis, sources and the quote. Suggestions from workers, QC or agents enter only as Proposed until the owner approves or the project adopts them. Re-established when intent material changes.', zh: '从意图类材料（PRD、需求清单、task contract）和 owner 陈述提取，带有效性、依据、来源和原话。worker、QC、agent 的建议只能以 Proposed 进入，直到 owner 批准或项目采纳。意图材料变化时重新建立。' } },
  { name: 'Design',
    def: { en: 'How the product is meant to be built or behave: a design, a solution, a Spec.', zh: '打算怎么做到：设计、方案、Spec。' },
    also: { en: 'design doc · technical spec · architecture doc · RFC · API spec · schema · wireframe / mockup', zh: '设计文档 · 技术规格（spec）· 架构文档 · RFC · API 规格 · 数据模型（schema）· 线框图 / mockup' },
    keeper: { en: 'Extracted from design documents and specs in the intent material; each version is one item, and a newer version of the same document marks the older one Replaced. Sections the Keeper suspects are outdated get a Suspected stale mark instead of being rewritten.', zh: '从意图材料里的设计文档和 Spec 提取；每个版本一项，同一文档的新版本把旧版本标为 Replaced。疑似过期的段落挂 Suspected stale，不改写。' } },
  { name: 'Decision',
    def: { en: 'Something decided or a constraint that must be respected.', zh: '已经决定的事，或必须遵守的约束。' },
    also: { en: 'ADR (architecture decision record) · decision log · policy · constraint · non-goal · guardrail', zh: 'ADR（架构决策记录）· 决定记录（decision log）· 策略（policy）· 约束 · 非目标（non-goal）· 护栏（guardrail）' },
    keeper: { en: 'Extracted from decision logs and from what the owner says in the Keeper chat. A decision the owner stated but no document records gets an Undocumented decision mark. A new product decision creates a change record and starts propagation to what it affects.', zh: '从决定记录和 owner 在 Keeper 对话里说的话提取。owner 说了但文档没记的，挂 Undocumented decision 标记。新的产品决定建立变化记录，并向受影响的条目传播。' } },
  { name: 'Plan',
    def: { en: 'A plan or milestone: what comes in which order.', zh: '计划、里程碑：分几步、先后顺序。' },
    also: { en: 'roadmap · milestone · release plan · sprint / iteration plan · project plan · phase', zh: '路线图（roadmap）· 里程碑 · 发布计划 · sprint / 迭代计划 · 项目计划 · 阶段（phase）' },
    keeper: { en: 'Read in round 1 from the plan documents: each increment, milestone or phase is one Plan item under the Product (or the Goal it advances), with the progress the material reports. It sits in the Work & plan column with the work items and is drawn in the same shape. Items a plan moves out of scope become Deferred; items it strikes out become Replaced or Abandoned, each with a change record dated from the material.', zh: '第一轮从计划文档读：每个增量、里程碑或阶段是一项 Plan，挂在 Product（或它推进的 Goal）下，进度按材料所报。它和工作项同在「工作与计划」一列，图上形状相同。计划移出范围的条目变 Deferred，划掉的变 Replaced 或 Abandoned，各建一条按材料日期的变化记录。' } },
  { name: 'Work item',
    def: { en: 'One piece of work: a task, a contract being executed, an issue, a TODO line.', zh: '一项工作：task、正在执行的 contract、Issue、TODO 条目。' },
    also: { en: 'task · ticket · issue · story card · PR / MR · TODO · work package', zh: '任务（task）· 工单（ticket）· issue · 故事卡（story card）· PR / MR · TODO · 工作包（work package）' },
    keeper: { en: 'Round 1 takes the work items from the project\'s own plan: one per task contract, task or issue the plan documents name, placed under the Area whose effect it delivers, with the plan\'s acceptance criteria as Done means. Later, fact records from sessions, commits and reports are attached to these work items (progress, what changed, results, what is unresolved). Work the plan does not name becomes a new work item; an execution batch, a session or a commit never does. Shown under the project\'s own id, drawn as an elongated diamond.', zh: '第一轮从项目自己的计划里取：计划文档里写到的每份任务合同、每个 task 或 issue 各一项，挂在它贡献效果的区域下，Done means 取计划里的验收条件。之后，会话、提交、报告整理出的事实底稿挂到这些工作项上（进度、改了什么、结果、未解决什么）。计划里没有的工作才新建工作项；一个执行批次、一段会话、一次提交都不单独成为工作项。显示项目自己的编号，图上画成拉长的菱形。' } },
  { name: 'Session',
    def: { en: 'One recorded session of an agent or a person working in the project.', zh: '一段 agent 或人在项目里的工作会话。' },
    also: { en: 'chat / agent session transcript · pairing session · meeting notes', zh: '对话 / agent 会话记录 · 结对会话 · 会议记录' },
    keeper: { en: 'Read from agent session logs (Claude Code, Codex homes) as sources and cited as evidence: the owner\'s words become decisions and corrections, the agents\' work becomes progress on work items. Sessions are not drawn on the graph; Project scope lists them.', zh: '从 agent 会话记录（Claude Code、Codex 的 home）读成来源，作为证据被引用：owner 的原话成为决定和纠正，agent 的工作成为工作项的进展。会话不画在图上，Project scope 里能看到。' } },
  { name: 'Run',
    def: { en: 'One execution: an execution prompt, a run, a result message.', zh: '一次执行：执行 prompt、运行、结果消息。' },
    also: { en: 'job run · pipeline / CI run · batch · agent run · deployment', zh: 'job run · 流水线 / CI run · 批处理 · agent run · 部署' },
    keeper: { en: 'Execution prompts, run directories and result messages are read as sources and cited as evidence (produced, verifies). They are not drawn on the graph.', zh: '执行 prompt、run 目录、结果消息读成来源，作为证据被引用（produced、verifies）。不画在图上。' } },
  { name: 'Review',
    def: { en: 'A QC or review report.', zh: 'QC、审阅报告。' },
    also: { en: 'code review · QC report · audit · design review · retrospective findings', zh: '代码审查（code review）· QC 报告 · 审计 · 设计评审 · 复盘发现' },
    keeper: { en: 'Read as sources; cited by verifies relations, which carry the Keeper\'s assessment of whether the reviewed claim holds.', zh: '读成来源；由 verifies 关系引用，关系上带 Keeper 对「被验证的主张是否成立」的评估。' } },
  { name: 'Test',
    def: { en: 'A test or other verification.', zh: '测试或其他验证。' },
    also: { en: 'unit / integration / e2e test · test report · benchmark · acceptance test · manual verification', zh: '单元 / 集成 / 端到端测试 · 测试报告 · 基准测试 · 验收测试 · 人工验证' },
    keeper: { en: 'Test files and reports read as sources; cited by verifies relations.', zh: '测试文件和报告读成来源；由 verifies 关系引用。' } },
  { name: 'Result',
    def: { en: 'An actual outcome: a code area, a commit, a build, a run result, a status statement.', zh: '实际结果：代码区域、提交、构建产物、运行结果、状态陈述。' },
    also: { en: 'artifact · deliverable · commit · build · release · report · status update', zh: '产物（artifact）· 交付物 · 提交（commit）· 构建 · 发布 · 报告 · 状态更新' },
    keeper: { en: 'Read as sources (code, commits, status) and cited by implements or produced relations. Code existing does not make a work item Done: progress stays what the material reports; a contradiction gets a Suspected stale mark.', zh: '读成来源（代码、提交、状态），由 implements 或 produced 关系引用。代码存在不等于 Done：进度保持材料所报，矛盾时挂 Suspected stale。' } },
  { name: 'Change',
    def: { en: 'One change record: when, from which material, what went from A to B, and what it affects.', zh: '一条变化记录：什么时候、由什么材料、把什么从 A 变成 B、影响到谁。' },
    also: { en: 'changelog entry · decision history · version diff · amendment · deprecation notice', zh: '变更日志条目（changelog）· 决定历史 · 版本差异 · 修订 · 弃用通知' },
    keeper: { en: 'Written by the Keeper only when product meaning or state changed: a decision made, replaced, deferred or abandoned; a proposal adopted; a work item completed or stopped; an owner correction. Not for every commit. Change records are not drawn as nodes: the objects they affect get a star (★) — new or changed since your last visit, or within the last one to three days — and Recent changes and the Changes view list them.', zh: 'Keeper 只在产品含义或状态变了时写：一个决定作出、被替代、延后或放弃；提议被采纳；工作项完成或停下；owner 纠正。不是每次提交都写。变化记录不画成节点：受它影响的对象打 ★（自你上次来之后新增或变动的，或最近一到三天内的），Recent changes 和 Changes 视图列出它们。' } },
];

const RELATIONS = [
  { type: 'serves', meaning: { en: 'Contributes to an effect or a higher object (a contribution claim).', zh: '为某个效果或上层对象作贡献（贡献声明）。' }, example: { en: 'a piece of work serves an area; a shared capability serves several areas', zh: '一项工作服务某个区域；一项共用能力同时服务多个区域' } },
  { type: 'refines', meaning: { en: 'Makes a higher object more specific.', zh: '细化上层内容。' }, example: { en: 'a requirement refines a Module; a design refines a requirement', zh: '需求细化 Module；设计细化需求' } },
  { type: 'implements', meaning: { en: 'Realises it.', zh: '实现。' }, example: { en: 'a code area implements a work item', zh: '代码区域实现某项工作' } },
  { type: 'verifies', meaning: { en: 'Checks it.', zh: '验证。' }, example: { en: 'a test or QC verifies a behaviour or result', zh: '测试或 QC 验证某个行为或结果' } },
  { type: 'depends on', meaning: { en: 'Needs the other\'s result first.', zh: '依赖。' }, example: { en: 'one work item depends on another\'s result', zh: '一项工作依赖另一项的结果' } },
  { type: 'produced', meaning: { en: 'Came out of a session or run.', zh: '由某次会话或执行产生。' }, example: { en: 'a session produced a decision or a result', zh: '一次会话产生了一个决定或结果' } },
  { type: 'replaces', meaning: { en: 'Takes the place of.', zh: '取代。' }, example: { en: 'a new plan replaces part of an old one', zh: '新计划取代旧计划的一部分' } },
  { type: 'contradicts', meaning: { en: 'Does not agree with.', zh: '相互矛盾。' }, example: { en: 'a status record and the code disagree', zh: '状态记录和代码对不上' } },
  { type: 'affects', meaning: { en: 'A change reaches it.', zh: '变化影响到。' }, example: { en: 'the items a change record affects', zh: '一条变化影响的条目' } },
  { type: 'carries out', meaning: { en: 'A piece of work carries out a decision that asks for something to be done.', zh: '一项工作落实一条要求做某件事的决定。' }, example: { en: 'the work that removes an old setting carries out the decision to drop it', zh: '删掉旧配置的那项工作落实了「旧配置不再保留」的决定' } },
];

const STATUS = [
  { word: { en: 'Validity', zh: '有效性' }, values: 'Current / Proposed / Deferred / Replaced / Abandoned / Removed',
    rule: { en: 'Current is what the material says is in force; Proposed is a draft, a discussion or an unadopted suggestion; Deferred was moved out of scope; Replaced points at what replaced it; Abandoned is a direction no longer taken; Removed is an object whose material was deleted from the project\'s current version, the deletion itself saying it is no longer needed. The first judgement is not a change. Only a replacement, deferral, abandonment, adoption, deletion or owner correction changes validity afterwards, each with a change record; age, completion or a move never do. A Removed object is not on the graph or in the List: it appears, struck through, only in Recent changes and the change details.', zh: 'Current 是材料写明现行的；Proposed 是草稿、讨论中或未被采纳的建议；Deferred 移出了范围；Replaced 指向替代它的内容；Abandoned 是不再走的方向；Removed 是材料已从项目当前版本中删除的对象，删除本身说明它不再需要。第一次判断不算变化；此后只有替代、延后、放弃、采纳、删除或 owner 纠正改变有效性，每次一条变化记录；变旧、完成、移动都不改。Removed 的对象不进图和 List，只在 Recent changes 和变化详情里以划线出现。' } },
  { word: { en: 'Progress', zh: '进度' }, values: 'Planned / In progress / Done / On hold',
    rule: { en: 'Reported by the material. Code existing is not Done. When the Keeper sees contradicting evidence it keeps the reported progress, adds a Suspected stale mark and explains in a note; it does not re-judge on its own.', zh: '按材料所报。代码存在不等于 Done。Keeper 看到矛盾证据时保持材料的进度，挂 Suspected stale 并在 note 里说明，不自行改判。' } },
  { word: { en: 'Basis', zh: '依据' }, values: 'Explicit / Inferred',
    rule: { en: 'Explicit: the project wrote it. Inferred: the Keeper concluded it from material; on the graph an inferred object carries the word Inferred and an inferred relation is a dotted line. A dashed frame is not Inferred: it is a work item\'s copy in another module it serves, its main one solid elsewhere.', zh: 'Explicit：项目写明。Inferred：Keeper 从材料归纳；图上推断的对象写着 Inferred，推断的关系画成点线。虚线框不是 Inferred：它是一项工作在它服务的另一个模块里的副本，主的那个实线框在别处。' } },
  { word: { en: 'Takeover depth', zh: '接手深度' }, values: 'Full / Focused / First picture only',
    rule: { en: 'Chosen on the Takeover page of the Keeper view before you press Start. The first usable picture (product reference, work items, graph, project-level notes) comes first; then the Keeper goes on to the depth chosen without asking again. Full: every plan, stage and topic dug by question, every planned material accounted for. Focused: what the current objects, the open work and the breakpoint candidates involve. First picture only: no deepening; history is read on demand. From Start on the depths cannot be pressed; once done, a deeper one goes on from what is done, and the same or a shallower one needs Clear first. Before Start the project is Not organized yet.', zh: '在 Keeper 视图的接手页上、按 Start 之前选。先出第一份可用（产品参照、工作项、graph、项目级 note），然后 Keeper 不再问，接着做到选的那一档。Full：每个计划、阶段与主题按问题深挖，计划里每份材料都有交代。Focused：只挖现行对象、还开着的工作和断点候选牵涉的部分。First picture only：不加深，历史需要时再读。按下 Start 之后三档不能再点；做完之后更深的一档可以接着做，同一档或更浅的要先清空。按 Start 之前项目是 Not organized yet。' } },
  { word: { en: 'Organizing level', zh: '整理层次' }, values: 'Read in full / Conclusions only / Sampled / Indexed / Not organized / Skipped: too large',
    rule: { en: 'Per material, computed from what the Keeper actually did. Read in full: a fact record exists. Conclusions only: only conclusions, known failures and fix reasons were kept. Sampled: belongs to a group whose samples were read; classified by the rule. Indexed: searchable and read on demand, not organized under the chosen depth. Not organized: pending or failed. Skipped: too large: a file over the size intake reads of one file; its text is not read, the ledger still records it, and it is neither pending nor a failure (listed in Project scope). A material an investigation reads later moves up to the level actually read.', zh:'按单份材料统计，来自 Keeper 实际做过的事。Read in full：已有事实底稿。Conclusions only：只留了结论、已知失败和修复理由。Sampled：属于某个规律，读了样本，其余按规律归类。Indexed：可以搜索、需要时读，所选深度下不整理。Not organized：待处理或失败。Skipped: too large：文件超过读取的大小上限，正文没有读入，账本照记；不算待处理，也不算失败（列在 Project scope）。后来被调查读到的材料，按实际读到的程度升级。' } },
  { word: { en: 'Assessment', zh: '评估' }, values: 'Holds / Questioned / Not assessed',
    rule: { en: 'A relation\'s existence is a claim, not a fact. Only a product relook or an owner correction sets Holds or Questioned; everything else stays Not assessed.', zh: '关系存在只是声明，不代表成立。只有产品回看或 owner 纠正才给出 Holds 或 Questioned，其余都是 Not assessed。' } },
];

const LANG_KEY = 'pk.vocabulary.lang';
function savedLang() { try { const v = localStorage.getItem(LANG_KEY); return v === 'zh' || v === 'en' ? v : 'en'; } catch { return 'en'; } }
function saveLang(lang) { try { localStorage.setItem(LANG_KEY, lang); } catch { /* per-viewer convenience only */ } }

function content(lang, counts) {
  const t = T[lang];
  const chip = (name) => h('span', { class: 'chip' }, h('i', { style: { background: CATEGORY_COLOR[name] || '#888' } }), name);
  return [
    h('p', { class: 'muted' }, t.intro),
    h('h3', {}, t.categories),
    h('table', { class: 'glossary' },
      h('thead', {}, h('tr', {}, h('th', {}, t.category), h('th', {}, t.definition), h('th', {}, t.also), h('th', {}, t.keeper))),
      h('tbody', {}, ...CATEGORIES.map((c) => h('tr', {},
        h('td', {}, chip(c.name), h('div', { class: 'faint' }, t.column[CATEGORY_COLUMN[c.name]] || ''), counts[c.name] ? h('div', { class: 'faint' }, t.inProject(counts[c.name])) : null),
        h('td', {}, c.def[lang]),
        h('td', { class: 'also' }, c.also[lang]),
        h('td', {}, c.keeper[lang]))))),
    h('h3', {}, t.relations),
    h('p', { class: 'muted' }, t.relIntro),
    h('table', { class: 'glossary' },
      h('thead', {}, h('tr', {}, h('th', {}, t.type), h('th', {}, t.meaning), h('th', {}, t.example))),
      h('tbody', {}, ...RELATIONS.map((r) => h('tr', {}, h('td', {}, h('code', {}, r.type)), h('td', {}, r.meaning[lang]), h('td', { class: 'also' }, r.example[lang]))))),
    h('h3', {}, t.status),
    h('table', { class: 'glossary' },
      h('thead', {}, h('tr', {}, h('th', {}, t.word), h('th', {}, t.values), h('th', {}, t.rule))),
      h('tbody', {}, ...STATUS.map((s) => h('tr', {}, h('td', {}, h('strong', {}, s.word[lang])), h('td', { class: 'also' }, s.values), h('td', {}, s.rule[lang]))))),
  ];
}

export async function openGlossary() {
  let counts = {};
  try {
    if (state.projectId) { const g = await api(`/api/projects/${encodeURIComponent(state.projectId)}/graph`); for (const n of g.nodes) counts[n.category] = (counts[n.category] ?? 0) + 1; }
  } catch { counts = {}; }
  let lang = savedLang();
  const body = h('div', { class: 'glossary-body' });
  const buttons = {};
  const render = () => {
    body.replaceChildren(...content(lang, counts));
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle('active', k === lang);
  };
  const toggle = h('div', { class: 'segmented lang-toggle' },
    ...[['en', 'English'], ['zh', '中文']].map(([k, label]) => (buttons[k] = h('button', { onClick: () => { lang = k; saveLang(k); render(); } }, label))));
  const dialog = openDialog('Vocabulary · 词表', [toggle, body], { onClose: () => dialog.classList.remove('wide') });
  dialog.classList.add('wide');
  render();
}

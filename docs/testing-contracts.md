# 测试、装配与共享接口补充

供编写和维护跨模块测试的工程师使用。本文与 contracts.md 一起冻结公共 helper、夹具与装配规则；具体实现和运行结果须核对源码及任务报告，不能把接口说明当作测试已通过。

## 1. 测试用例可独立运行

T00 创建 crates 的 lib 与 bin 最小入口、Vitest workspace、Playwright config；所有 packages 名称固定：annotation-domain、geometry、editor-core、renderer-wgpu、wasm-bridge、dataset-formats、weblabel-api、xtask；JS packages 为 @weblabel/web、@weblabel/agent-host、@weblabel/contracts。workspace 根统一运行 pnpm exec vitest / playwright。

TASKS.json 的 argv 指定本任务的窄测试入口，不能换成全套测试来绕开指定断言。缺少路径应补实现；环境失败应记录为环境阻塞，不算 Red 功能失败。

共享 helper 放在 tests/support/。新增 helper 必须由对应任务定义，不能依赖未说明的全局对象。

Vitest 运行 TS 测试，tsconfig 引用 generated contracts；Playwright 用 `data-testid` 寻址。Rust integration test 文件统一小写 snake_case，例如 t03_geometry.rs；cargo --test 参数同名。

Python使用 pytest，测试收集为零视为失败。所有 test ID 大小写以 manifest 为准。

## 2. HTTP 测试 helper：T06/T10 负责

```ts
export type Role = 'admin' | 'annotator' | 'reviewer' | 'viewer';
export interface ApiResponse<T = unknown> { status: number; json: T; headers: Headers }
export interface ApiClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;
  upload<T = unknown>(path: string, bytes: Uint8Array, filename: string): Promise<ApiResponse<T>>;
}
export interface TestApp {
  base_url: string;
  as_user(role: Role): Promise<ApiClient>;
  stop(): Promise<void>;
}
export function start_test_app(cookieSecure?: 'true' | 'false', modelWorker?: 'manual' | 'background'): Promise<TestApp>;
export function launch_code_for_test(app: TestApp): Promise<string>;
```

每次启动独立临时目录/数据库，监听随机端口。生产代码提供启动 bootstrap 通道；测试捕获该管道，走真实登录/管理员创建用户接口，不插入万能绕过鉴权中间件。进程退出和测试失败也执行清理。只有 TEST build 允许 fault injection channel，release build不编译此入口。

真实API helper在每个worker首次使用前从当前源代码构建，不以可执行文件已存在替代新源码。Vitest integration的prepare-api setup在行为测试计时外编译，保持原测试deadline；显式WEBLABEL_API_BINARY仍表示调用者选择的可执行文件，不能把任意override当新源码证据。T26在beforeAll执行真实bootstrap、媒体准备和用户密码哈希/login；原5秒用例仍覆盖完整lease/fencing/CAS与不可变revision审核。CI10原T26行为的31个真实请求共222ms、最长单请求13ms，START/END完整配对；该次通过不解释CI9失败请求，原因仍未实证。已删除临时observer，完整原it的31请求、55行为/63全文件expect和5秒期限不变，消费者不依赖trace。T17每个beforeEach创建独立新API/数据库并完成真实管理员、媒体与角色fixture，setup失败和afterEach均清理自己拥有的进程。T29只将恢复用户创建、首次真实login及expired session准备放到已有beforeAll，stale/expired两种cookie的完整GET删除、错误密码、Origin/Host、重新登录、session与CSRF行为仍在同一个原5秒it内；F22两个原content/provider case各在beforeEach准备独立真实app/media/pins，initial authorize、实际输入变更、403拒绝/零model rows、fresh approval/202与cancel/200仍完整留在原5秒行为窗口，setup失败清除所有权后close、afterEach清理当次app。T10用户列表case只在scoped beforeEach完成fresh app/bootstrap/admin准备，创建用户、hash/date/identity检查、logout/relogin、角色/cookie与401仍在原5秒it内。T27只前置fresh app/scratch/bootstrap与初始approved r8，原单case完整unready拒绝、固定snapshot/r9新审核、幂等冲突、native/YOLO/COCO/multi-image/negative与download scope断言仍在同一5秒窗口；部分setup失败、case finally和afterEach先清除所有权再清理scratch/自己拥有的API，不以guard重复stop外来进程。全部case计数与领域/权限断言不变，不将冷setup计入行为窗口。T10 Secure-cookie原case只将fresh secure app与真实viewer创建/login放到独立scoped beforeEach，原GET/session与200断言仍在5秒it；as_user仍校验真实Set-Cookie的Secure属性，原其他五case不改，setup失败和afterEach清理自己拥有的app。

T11 的单个显式 ontology-head 用例按现有 scoped fixture 生命周期在 beforeEach 完成 fresh API 启动及管理员 bootstrap/user/project/member/login 五个真实准备请求；as_user 失败由原 helper 关闭 owned app，成功才发布 app 引用，afterEach 先清除引用再 await stop。原 omitted ontology query 的 GET、400 与 ONTOLOGY_VERSION_REQUIRED 两个断言仍完整留在原5秒 it，保留1用例、完整6个 API 请求，不增加 hook/test/API 预算、不重试或关闭 worker。CI16 的5000ms registration-line stack 未记录最后 await，不能诊断为编译、KDF、数据库或关闭的特定阻塞；本地改后真实官方 API 观察为五个准备请求加一个400消费者请求，消费者约0.74ms，只证明该次生命周期与行为，不反推历史失败。

T25测试helper的manual模式仅在debug构建显式设置WEBLABEL_TEST_MANUAL_MODEL_WORKER=1，让故障/脚本fixture拥有排空顺序；background模式运行服务原生模型worker。release忽略该开关。database_path_for_test只返回该helper自己创建的临时数据库路径，不能访问真实项目库。T25 public-profile和preview-consent两个原case各使用独立scoped beforeEach准备真实app/bootstrap/media，setup失败先清理该fresh app，afterEach清除owned引用再await stop；secret UPDATE、第二profile INSERT、授权前403/legacy400/三个binding拒绝/crop及fingerprint/无consent拒绝/zero model_runs/最终202均仍在原5秒it内。第三原background case及25000ms期限完整不变；保留3case、全部request/expect与真实密码哈希，不做worker关闭或应用重试。

T33九个连接到live API库的writable DatabaseSync fixture各设置一次PRAGMA busy_timeout=1000，readonly/offline连接不改；保留13用例与16-field immutable audit矩阵及完整源history/hash/保密断言，不做应用重试或停掉background worker。独立writer的原0预算失败、1000ms耗尽不改行、page-changing commit后的单次成功与durable读回只证明fixture contention边界，具体远端持锁身份未实证。后台seed用单次1000ms SQLite busy handler与BEGIN IMMEDIATE取得writer后插入测试profile，成功commit、失败close回滚，不做应用重试；一次drain后按upload的import_job_id只读等待原5秒内的真实succeeded/media_import/1-of-1，后台先claim时processed=0不冒充导入失败。仍校验唯一canonical资产、annotation版本及完整内容。T29源library/router与production扫描统一遵守CARGO_TARGET_DIR和调用者Cargo cwd，从repo数字pin选择真实host compiler，不用发行普通API替代安全fixture。文件grant消费者实际读取resolve返回路径并校验与批准图像相同的字节，不把Windows长路径与NTFS 8.3别名的字符串拼写当作文件identity；真实junction/symlink逃逸、portable绕过、foreign binding与revocation断言不变，生产canonical containment算法不改。

T17 保持原30秒retention lease、2100事件生产、2000窗口与104..2103的真实API分页/replay断言；silent runner、持有writer的item与expiry/replacement-worker回调必须覆盖真实Queue/SQLite行为。权限丢失后立即提交新provider identity和合法candidate，校验event/prediction/suggestion计数及foreign authority不变，不靠等待下一个heartbeat拒绝输出。T16 的owned child在第二次spawn/setup之前进入清理作用域；Linux真实broker故障仍以private capability的单次5秒cached failure拒绝成功，不以裸PID或空killed列表假报SIGKILL。

T16 Node Host 回收使用从首次 discovery 开始的单一 monotonic 5000ms 预算，覆盖异步 CIM/ps、taskkill、descendant sweep 和 identity verification。execFile 的剩余 timeout 以 SIGKILL 终止自身启动的 helper，等待真实 close；启动/超时/buffer/不完整 process table 失败闭合为 reclaim_incomplete，不能用空表冒充进程消失。已完成的非零 taskkill 仍必须以实际身份验证确认目标不存在。保留 root/lineage/creation-time guards；首次 orphan 的查询若无 intervening await 可直接作 identity guard，其余尚存 descendant 杀前重新查询，不跨 await 复用旧身份。每轮验证只查询一次，250ms 等待不越过剩余预算；Linux owned broker 与原用例、断言和期限不变。历史 CI 的具体 helper/stream 阻塞阶段未捕获，不据本次修复捏造归因；该预算只界定回收，不冒充全部 Host stream/运行或硬件 G4/T32/T35 验收。

T06 的原120ms写锁冲突预算、2秒上界及解锁后recovery断言不变；首次冷迁移不是放宽预算的理由。真实SQLite消费者回归由独立Repository确认abandon/task-abort写入均回滚，恢复writer提交后精确读回，不断言连接identity。超时或取消pending BEGIN、deferred-FK COMMIT失败不得留下行或锁；当前成功和失败路径均关闭专属连接，不能用SQLx库名字代替取消安全证明。
Repository clones共享一个FIFO写入准入；等待准入、获取连接与BEGIN IMMEDIATE仍合用调用者原始预算。成功、放弃、取消、pending BEGIN、失败/取消COMMIT或ROLLBACK均由独立线程持有连接与准入，直到真实SQLite worker关闭确认后才释放；正常finalize等待关闭，取消或runtime关闭不取消该线程。迁移循环事务、媒体metadata和所有Repository事务走同一准入，独立auth pool不新增此gate，外部writer仍受原预算约束。消费者回归覆盖有限短事务洪流下的真实heartbeat durable写入、FIFO/取消/期限、deferred-FK失败回滚、in-flight取消、无runtime恢复和finalize后的Windows文件句柄释放；不固定连接identity或生产重试。
导出 worker 的三阶段×续租/失效/接管九组合回归仍使用真实心跳与原期限。观察 lease_until/worker/fence 时只短借 read_connection，读取后在下一次等待前释放，不用 BEGIN IMMEDIATE/写入准入作只读轮询，避免观察者的连接关闭和 writer 竞争污染心跳时限。固定 fixture clock 不传播给未显式 scope 的旁支任务；生产 expiry/fencing、heartbeat cadence、五秒观察期限和原九组合断言不变。
T30 的 F17 三种协议故障 fixture 仅在准备 profile 时复用 T25 seed 的一次 1000ms SQLite busy handler 与 BEGIN IMMEDIATE，成功 COMMIT、失败 close 回滚；真实后台 worker、四十秒 case 预算、Host 监督/后代回收、成本未知和人工保存原断言不变。旧 CI 的 SQLITE_BUSY 指向该 profile INSERT，不记录当时具体锁 owner；不能将 fixture 修正说成生产重试或付费模型验收。
T17 seed 使用当前 bootstrap 管理员客户端以 image/jpeg 上传真实 fixture，不额外创建/授权/登录仅为上传而存在的账号；每例仍使用 fresh backend/database，授权用例的真实 outsider/viewer 登录与原路由断言保留。原 outer hook 为默认10000ms；旧日志只定位到 hook，未定位最后 pending await，不能据减少无关 KDF 宣称精确历史阻塞已证明。
Dataset 1301 行分页消费者按既有稳定 testid 等待指定页行，再检查 accessible name；上一页查询只在分页控件区域进行，复用已有 userEvent session。保留14页完整遍历、往返、跨页 include/exclude 实际提交体、cursor=1300、不获取完整 annotation 和原5000ms预算，不关闭 pointer 检查或强制事件。
T18 的实际 child-launch 取消 fixture 在创建 filesystem watcher 前使用 realpathSync.native 展开已有目录的 Windows 8.3 短别名；JS realpathSync 不展开该别名。项目内真实短路径 watcher 在 Node24.16.0重现0xC0000409及libuv fs-event.c:72 prefix assertion，canonical长路径正常；完整26用例在强制短路径TEMP下通过。仅规范化watch输入，保留事件驱动的实际启动确认、500ms worker期限、8秒settle、原用例预算及所有退出/取消断言，不修改Node pin或生产监管。上游记录见[node#63638](https://github.com/nodejs/node/issues/63638)与[修复PR#65118](https://github.com/nodejs/node/pull/65118)；原CI未收集具体TMP别名，不把相同exit code当完整原生stack证明。
T26 readback fixture 在业务完全结束后，同时持有 auth pool 的全部 capacity，再逐条 PoolConnection.close().await，最后关闭 pool 和独立 Repository 并删除目录。SQLx 0.8.6 的归还任务可在 is_closed 检查后等待 ping，再把连接推入 idle；close 的最后 permit acquire 后没有再次 drain，故本地实测 close 返回后仍 closed=true/size=1 且即时删除失败。显式借齐再关闭使归还先完成、每条 SQLite worker 真实 shutdown 被等待，不增加重试或预算，不修改生产 SQLx；身份、lease/revision/fence 无写入及目录删除原断言完整保留。Handle 观测未取得锁 owner，不能冒充已确认的 Windows 进程身份。

debug-only管理员drain在入口只读捕获按created_at/job_id排序的最多32个queued/running作业，原分派逻辑不变。其他owner尚未完成时，释放读连接后等待该封闭cohort真实succeeded/failed/cancelled/interrupted终态；后到作业不扩大等待集合，不抢有效lease、不改变fence/attempt、不重提交。其他owner等待阶段超过2秒仍未终态返回503 JOB_DRAIN_TIMEOUT；快照/读取失败或捕获作业消失返回500 JOB_DRAIN_FAILED，不以200冒充完成。processed/jobs仍只报告drain自己拥有的分派，失败作业仍为failed，release继续404。T17另保留原22用例并追加真实expired-lease模型drain回归：首attempt到达受控runner后中断，只过期lease，drain通过真实process_next回收attempt2并终结interrupted/unknown/LEASE_EXPIRED_NO_RESEND，禁止重发或产生预测/审计/标注修改。T27新增真实API回归覆盖有效owner、并发写入、成功/失败、后到作业排除、期限和删除；原Vitest T27/T29请求、断言及background worker保持不变，2秒不是整次drain分派的总预算。

CI12受控原生实验分别重现短写事务抢占导致heartbeat在原2秒预算内失败、有效后台export owner使旧drain提前返回200/running；集成后实际2100事件模型完成并读回2000窗口104..2103，原生Linux HTTP/media gate证明drain等待真实导出终态且独立写入201。有限持锁和native FIFO是诊断fixture，不宣称历史CI12恰有该调度、持锁者或FIFO；本地烟测和软件CI也不替代最终远端双平台发布/真实硬件/真实模型验收。

T10 bootstrap竞争验证使用真实新数据库/API、后台export worker和独立SQLite writer，不把一次无竞争200或归档能启动当作竞争闭环。临时native smoke覆盖保留空writer及提交页变更的writer、原配置预算耗尽后无半写入、解锁后的显式新请求、session/CSRF和one-use replay，以及恢复资格拒绝/成功；自然相位复现只比较每个fresh app的首次请求，不自动重试或移除失败样本。单Tokio worker仅用于复现实验，非CI/生产配置修复；诊断仅记录静态阶段和SQLite数字码，收证后删除instrumentation。不添加依赖任意sleep/内部trace callback的永久测试或生产test hook；保留真实before/after日志，完整双平台源码CI和当次归档消费仍为发布gate。
CI完整Rust workspace明确使用--test-threads=2，Vitest使用--maxWorkers=2，以限制同机SQLite、Tokio runtime、Node/CIM消费者并发；不删除用例、不改变原2秒Host timeout/30秒lease/120ms锁预算/5秒行为期限或原请求次数断言。这是已实测的资源政策，不将单次未保留终态事件的0调用失败归因到CPU/冷文件系统，也不保证任意外部过载下必定在provider启动前完成。

CI的dev/test仅为Argon2依赖设置opt-level=3；应用调试断言与release配置不变。密码仍执行Argon2id v19、m=19456/t=2/p=1的完整工作，不减强度、不缓存密码、不移走bootstrap/login/user请求。真实生产密码模块的固定盐、随机盐、跨编译验证与错密码拒绝证明行为一致；本机default/Argon2-only编译对照hash中位耗时267.7389/18.205ms，优化后的真实API通过原T27完整导出用例，原5秒期限及全部请求/断言不变。本地成本改善不证明CI13远端具体卡在哪个await，最终仍须当次完整源码CI。

T33真实Windows ConPTY将当前唯一C#interop源码在原600秒beforeAll内编译到fresh owned DLL；物理runtime以标准CLR Assembly.LoadFrom加载调用者提供且SHA256不变的prepared DLL，不重入Add-Type的Utility/cmdlet/CodeDom初始化，不保留inline编译旧路径。集成test与standalone CLI均先准备真实assembly；实际DLL加载、ConPTY/CreateProcess和API就绪仍在原20秒bootstrap条件内，物理case原120秒不变。实际PS5.1 IL确认Add-Type即使载入DLL仍构造CSharpCodeProvider，因此标准loader只省去无关初始化，不以本地慢编译或页面可打开替代当次Windows物理lane。

bootstrap等待期间即捕获自己启动PID的creation identity，失败清理要求同一creation_filetime与自己拥有的命令路径；release路径只做native separator归一化，不以裸PID或acceptance前taskkill冒充物理关闭。编译、assembly load、ConPTY/CreateProcess、首输出、token观察和session端点错误先去VT控制再脱敏launch code。原报告路径、CLI消费者、物理信号、native30000ms API等待、成功JSON和41个断言不变；全部worker join不等于Tokio blocking-task回收完成，packaged launcher的force termination不证明原生graceful退出。

物理harness失败时，在关闭ConPTY、backstop或关闭held handles之前记录内核GetProcessTimes creation identity、GetExitCodeProcess状态、实际已发送信号次数/时间和UTC观察点；缺失handle为null、未成功发信号为0/null，观察失败保留原harness_error并显式记录，不把失败改为成功。显式绝对WEBLABEL_T33_DIAGNOSTICS_DIR只接收该次attempt完成后生成的UUID子目录JSON/log脱敏副本；递归去除凭据字段与已知秘密值，原断言对象和默认报告路径不变。Windows CI即使失败也只上传这份新sink的四种文件名，缺失不是运行成功；不上传private DB、DLL、Host config/授权token、原T32或checkout冻结证据。

Windows Rust Host生产进程观察只用checked Toolhelp32枚举；只对owned候选查询GetProcessTimes，保留精确100ns FILETIME与OwnedHandle直到原taskkill /T /F、每个orphan /F和物理退出验证结束。每轮验证只取一份成功进程表，表中不见PID不等于held handle已经signaled；枚举、目标权限/identity与native wait错误返回Err，不能以空表或未知creation身份冒充安全成功。非交互taskkill保留Host既有CREATE_NO_WINDOW(0x08000000)、绝对tool lookup/argv/stdio；不再创建生产PowerShell/CIM进程。Linux subreaper/pidfd与其他POSIX机制不变；RuntimeLease/reader仍可能各调用一次回收，不宣称共享结果或去重。原5秒reclaim验证窗口仍在初始snapshot/kill/sweep之后，物理30000ms API等待和真正runtime/reader完成条件不变。

根PID的native creation identity即使在snapshot表中缺失也重新查询；若已是spawn记录之后的新generation，先返回Err，不归属或杀其任何后代。真正消失的旧root仍按原orphan时间窗口处理。永久真实OS消费用自己拥有的synthetic foreign root与detached HTTP leaf、stale-owner元数据和exited_at_ms=None验证二者在拒绝后仍alive/可访问，再由fixture真实owner清理；这是generation mismatch surrogate，不声称制造了自然PID重用。

Windows launcher在taskkill非零且JS exitCode/signalCode仍为null时，只用成功spawn的原owned ChildProcess.kill(0)查询Node 24.16.0/libuv 1.52.1保留的process HANDLE，不重开裸PID。仅false且无同步throw/emitted error可以继续等待原close后解锁；alive或未知error仍失败并保留lock，不追加kill、重试、Windows grace或finally强删。killed字段不是退出证据，zero probe不是物理Ctrl+C，也不证明全部descendants已灭。真实OS probe观察原held HANDLE exit23、JS flags null/null及空事件队列，zero返回false/无error，随后原close23；live zero返回true后HTTP/IPC仍可用。CI14稍后的API/tree exit1不证明更早nonzero-taskkill分支时已dead；一次同次诊断只观察code0，历史分支即时状态仍未知，最终完整新SHA CI是gate。永久消费者保留原期限并检查launcher/API endpoints关闭、相同data立即重启无stale lock、owned child实际退出且无关真实服务仍可访问。 Windows原close promise的并行rejection立即被持有，原await或kill/probe错误仍向调用者传播；真实断开IPC send在pending close时返回ERR_IPC_CHANNEL_CLOSED且无unhandled rejection，owned child已物理close，不声称制造了native权限错误。无关fixture的清理使用nested finally，即使owned child stop失败也执行。

CI11原direct-native case的首个PowerShell/CIM snapshot实际等待30038.317ms；原30000ms观察点API/root/descendant仍live且taskkill未开始，snapshot在harness到期清理后约31.8ms返回。该证据定位阻塞调用，不证明console/WMI更深机制、CPU或杀毒原因。临时关闭/lifecycle日志、数字失败字段、扩展断言消息及Windows-test身份观测均在收证后移除，不成为消费者或发布依赖。一次本地原Rust期限回收断言失败未保留目标birth/cancel结果，历史类型无法追溯；随后Main原workspace前置语境的新观测257项通过、该次原身份root/child exit1只证明新执行成功，不冒充旧失败原因或进一步修复。原300ms lease、500ms sleep、bare-PID断言和双线程政策均未修改；最终无观测源码的完整双平台CI、当次归档和实际Release/GHCR消费仍是发布gate。
`launch_code_for_test` 仅读取当前 helper 自建 app 的 stdout 启动码，不调用管理员 helper、不兑换、不记录 code；未知 app 拒绝。首次登录浏览器回归只用 app + 原生 page，不依赖会先初始化的 seededProject/adminPage/as_user。
固定业务fixture由 T01 提供 `tests/fixtures/golden/{ontology,media,document,save,prediction}.json`；对象ID `object_person_001`，类别ID `label_person`，640×480，bbox[10,20,110,220]，helmet_state默认unknown。测试 fixture ID 不受UUID生成器限制：Id验证是非空受限字符串，生产新ID用UUID。

## 3. Playwright fixture：T15建立

`tests/e2e/fixtures.ts` 导出扩展后的 `test` 和 `expect`，提供 app、adminPage、seededProject 三个 fixture。seededProject 通过真实 API 导入程序化图像，包含 project_id、asset_revision_id、base_revision_id；adminPage已真实登录，指向该项目工作台。

`forward_api_for_test(page: Page, baseUrl: string): Promise<void>` 抽取原 adminPage 的真实 route.fetch/route.fulfill 转发，只匹配开发入口 `http://127.0.0.1:5173/api/**`，保留 path/query/body/method/cookie，去掉 Host/content-length 并将 Origin 改为实际 API base。它不是正式发行同源门控的证据；后者必须在当前发行实际验证。认证 spec 显式关闭 trace/video/自动失败截图，仅保留字段为空或遮蔽后的截图及脱敏结果。

媒体就绪以该项目全部 canonical 资产实际生成作为条件，不以一次 manual drain 的处理数量代替；后台 worker 可能已经完成部分导入。
主 data-testid：

| ID | 定义 |
|---|---|
| project-create / project-name / project-submit | 项目创建表单 |
| media-import / asset-grid / asset-item-{id} | 文件input、列表、媒体项 |
| toggle-assets / toggle-attributes / toggle-ai / close-assets / close-inspector | 工作台侧栏切换与窄屏关闭；切换不卸载 AI 状态 |
| annotation-canvas / gpu-status / tool-box / tool-select / tool-pan | 画布、诊断与工具 |
| object-list / object-item-{id} / attribute-{key} | 虚拟对象列表和属性控件 |
| save-status / undo / redo / image-next / image-prev | 保存与编辑 |
| ai-provider / ai-prompt / ai-consent / ai-run / ai-authorize / ai-cancel | 模型、授权预览与明确开始 |
| ai-status / candidate-{change_id} / accept-selected / reject-selected | 候选、差异和决定 |
| task-submit / review-approve / review-reject | 指定版本审核 |
| snapshot-create / export-format / export-start / export-download | 固定快照导出 |
| recovery-banner / conflict-banner / export-local-draft | 恢复与失败救援 |

gpu-status 位于 canvas-renderer-status 独立正常流，不覆盖 annotation-canvas；暴露文本/可测试属性 actual_backend=webgpu、adapter_kind=hardware/software/unknown、device_state=loading/ready/lost/recovering/unsupported；不以浏览器支持检查代替真实 device 创建。

布局验收须使用真实浏览器：同时验证 1099px 两侧及短屏、侧栏切换和双向跨断点焦点、对象虚拟滚动不拦截布局控件、原生 resize 与调节按钮的真实尺寸边界、保存与完成状态可达、数据集末行滚动后主操作仍可点击。合成 GET 拦截只证明布局；真实 API 保存、确认负样本和导出须另记实测证据。硬件 adapter ready 不等于 G4 通过。

设备重建中显示recovering且Canvas只读，成功才恢复ready；失败保持lost和GPU_RECOVERY_FAILED诊断，gpu-retry显式重试renderer-only恢复。GPUDevice.destroy必须通过真实device.lost观测并自动触发重建，不调用simulate_device_loss。

T00 软件工程 gate 使用实际 Rust WASM 创建 BrowserWebGpu device，并严格要求 ready 与 Cpu；Windows 的 inherited e2e 参数为 `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --use-angle=d3d11-warp`，以 CPU WARP ANGLE compositor 配合 Dawn SwiftShader，而非依赖本机硬件 compositor。其他平台不加入 WARP；t05-render/chromium-webgpu 硬件项目继续覆盖完整 launch argument list，不继承软件 adapter/WARP。实际 Chromium 153 本地 WARP renderer 为 Microsoft Basic Render Driver，device 创建及真实 GPU pixel readback 已成功；这不反推历史 CI15 blocked 的未捕获原因，也不证明硬件/G4。CDP 的 unavailable_software 是硬件加速元数据，不能替代实际 device/pixel 结果判断。原 ready/backend/Cpu 断言、期限与重试设置不变。T00 在 strict ready 断言前写出 state/backend/device_type/error 四字段 JSON 和仅 gpu-status 的截图；CI always 仅上传当次 run/attempt 的这两个固定 T00 basename，保留7天，不上传整个 trace/test-results、业务库、T32或authority。

测试中需要获取文档时调用正常的 GET annotation API或 Editor 测试 facade；测试 facade只在测试构建可用，不能让生产页面暴露任意内部命令绕过权限。截图只用于可视效果；几何、标签和保存必须用原始数值断言。

## 4. Provider fake-process 契约：T16建立

`tests/support/fake-runtime.mjs` 是无网络子进程，接收环境变量 TEST_SCENARIO（normal / malformed / oversized / crash / slow / spawn_child），从stdio读版本化协议并发送确定性测试响应。它不能命名为真实 provider，不能被生产profile枚举。

生产注册表在测试注入点之外永远不包含它。

`apps/agent-host/test/fixtures/` 保存带 `fixture_kind: "synthetic_protocol"` 标记的脱敏协议样本，不能声称官方真实调用日志。仍活动的官方 runtime（T23 Claude）须按实际固定版本验证协议/schema与相应命令；JSON fixture 不替代真实验证。原 T22 schema/生成命令要求仅属冻结历史，当前 Codex 已退役，不安装/调用 CLI，不以旧要求恢复接入。

## 5. shared file 集成规则

任务主写模块文件；新增模块声明、根router、导航和manifest变更放该任务 `integration.patch` 交主Agent。主Agent应用后复跑目标测试。T01生成 contracts 的 script由xtask负责；Node端只消费生成文件+JSON Schema，不另写一套不一致类型。

小函数由当前任务定义并测试即可。C1–C8、公共 helper 和 HTTP/Editor/Provider 契约的变更须先提出 ADR。任务卡中的“产生”签名表示该任务要实现的接口，不保证基线中已经存在。

## 6. 保存与候选接受的事务补充（本计划明确新增）

正式文档与候选决定必须一起保存。SaveRequest 的 `suggestion_decisions` 为数组，`lease` 可空；普通编辑传空数组和 null。EditorDelta 返回本次逻辑操作的 suggestion_decisions，保存队列必须完整保留。

```ts
export interface SuggestionDecisionIntent {
  suggestion_set_id: string;
  change_ids: string[];
  decision: 'accept' | 'revert';
}
export interface SaveRequest {
  operation_id: string;
  base_revision_id: string;
  document: AnnotationDocument;
  lease: {task_id: string; fencing_token: number} | null;
  suggestion_decisions: SuggestionDecisionIntent[];
}
```

T01将其合并进正式生成类型，不能生成两个SaveRequest。T11对普通空数组保存；T19/T25实现候选验证和同一事务内保存decision。T26对任务内编辑验证lease；无任务的本地项目可null。任务过期/权限不足不得仅凭CAS成功继续写入。

POST suggestions/{id}/decision 仅用于 reject 和对已保存决定的查询/幂等确认，**不能脱离保存事务接受正式变更**。undo接受操作会产生revert intent；redo产生accept intent。提交/撤销对同一change的状态迁移按保存操作顺序记录，不能静默去重掉accept→revert。

保存多个未同步逻辑操作时，保留有序intent journal；数据库校验最终文档及完整有效序列。源预测不可改。

新增管理路由：`POST /api/users {username,password}` 仅平台管理员，用于本地多角色审核；`GET /api/users` 仅管理员列出id/username，不返回密码hash。T10负责，密码Argon2id；v0.1不做公网注册和在线自助找回。本机已有管理员的一次性密码恢复是独立维护入口，见[运维](operations.md#管理员密码恢复)。

管理员恢复回归使用项目内synthetic SQLite，不接触真实数据：原user_id/用户名/成员身份和其他用户凭证不变；目标sessions撤销与journal同事务；错误/过期码、UTF-8边界、限流/Retry-After、Host/Origin/普通CSRF隔离、故障回滚/重试、目标角色复核、空库/scrubbed拒绝、消费ID重启拒绝。覆盖POST先于GET的未知结果结算及GET先于POST的公平等待，不用固定延时掩盖race；直接二进制验证同库OS锁和退出后重启，根router验证完成后仍503维护。

Web检查旧cookie覆盖、字段确认/单飞、明确无写入拒绝与未知结果分流、错请求ACK及只读核对，不自动重POST。最终真实buildRelease/startLocal+浏览器闭环与CLI消费ID拒绝另有证据，synthetic route/mock或页面能开不替代。截图清空/隐藏凭证，不存code/password/cookie/CSRF；不清IndexedDB来证明恢复。


## 7. BBoxInstance 的固定初版布局

T05的实例结构采用 `#[repr(C)]`：bounds:[f32;4]、color:[f32;4]、flags:u32、padding:[u32;3]，大小48字节。WGSL读取相同布局；不使用Rust bool映射GPU。未来改变需同时更新布局测试与shader，不能只改一侧。

## 8. 临时编辑导出不是数据集快照

T14实现 `POST /api/annotation-revisions/{id}/exports`，以单个已保存不可变版本输出canonical图及检测标签，用于T15人工闭环；产物挂通用jobs并通过鉴权download读取。T27增加多图DatasetVersion冻结，不改变T14输出的坐标和信息损失语义。

未保存草稿的救援下载是原生格式，明确标记unsynced，不能冒充审核数据集。

## 9. 活动验收输出隔离

`tests/support/report-paths.mjs::taskReportPath(taskId,...segments)` 将输出放在 `WEBLABEL_TEST_REPORT_DIR/<taskId>`；未指定时使用进程唯一的项目内 `target/test-artifacts`。根及已有父目录先解析真实路径，不能经 junction 写到项目外。`WEBLABEL_T30_TEST_ROOT` 仍优先于通用报告根。历史 `reports/T29` 生产/assemble 和既有报告不属于新的输出目录。

活动 T33 使用 `tests/support/active-host-shutdown.mjs::activeHostShutdown(mode,release,{reportDir,skipSecurity})`；`reportDir` 必填，fixture 位于 `tests/fixtures/active-host-shutdown`，私有运行数据与 fixture 分离。`skipSecurity=true` 只排除并记录 unauthenticated START/no-consent START 两项权限探测，不改变实际 Ctrl+C、进程回收或服务守卫。旧 `reports/T33/active-host-shutdown` helper/报告冻结，不再由活动测试导入。

T31/T32 CLI 的 `--report-dir` 选择项目内本轮输出；T31 配置仍从 `reports/T31` 读取。未启动或缺测试报告时计数为 `null`，不能伪造零测试或复用旧结果。源码身份由 `scripts/evidence-identity.mjs::captureEvidenceIdentity()` 绑定实际文件集合与 SHA256，含未提交源码、migration、生成契约、检测 worker 和活动 T31 控制，不读取账号、权重或私人报告。

## 10. 手动模型与生产媒体 worker 分离

`WEBLABEL_TEST_MANUAL_MODEL_WORKER=1` 只暂停模型后台消费，媒体导入继续使用生产 worker。合成 fixture 用带真实 MIME 的上传与公开 canonical assets 列表等待，不调用模型 drain 充当媒体完成证明。T25 功能回归要求模型入队前后两张新合成图都实际完成 canonical，已入队 Engineering Mock 仍 queued 且无候选。

浏览器种子保留 20 PNG + 两张方向 JPEG 共 22 资产；T31 再上传两张 2048×2048 图后等 24，并逐名称验证真实 canonical metadata。媒体准备成功不证明 GPU 性能通过；2000/10000 对象、seed 17、每场景 40 warmup + 1000 submission 和既有 P95 阈值不变，只有实际硬件样本可作性能证据。

# Production RAG 内网 MVP

这是面向单机内网部署的 Production RAG MVP：包含身份、持久化、工具、短期记忆、文档解析队列和 Web 控制台。它适合内部试点，仍不宣称具备公网商用、高可用或完整合规能力。

示例业务：用户导入自己的售后制度，询问退货政策；也可以查询自己的订单，再追问“它什么时候到”。用户用账号密码登录，身份来自服务端签发的令牌，客户端不能指定用户身份；文档可以设为仅自己、共享给部门或所有人可见。

## 架构与代码

请求 → API 身份验证 → Memory → 规则识别 → 本地小模型分类 → 低置信度时调用 DeepSeek → Router → Query Rewrite → 向量 / 关键词混合召回 → RRF 融合 → Cross-Encoder 重排 → DeepSeek 回答 → MySQL 保存结果。

| 模块 | 实现 | 阅读位置 |
| --- | --- | --- |
| API | FastAPI、JWT 登录、上传、会话、问答、Swagger | app/api/main.py |
| 认证 | 密码哈希、JWT 访问令牌、可撤销的刷新令牌 | app/auth.py |
| Router | 规则识别、本地小模型分类、DeepSeek 兜底和问候 / 订单 / 知识分流 | app/router/router.py、app/models.py、intent/ |
| Tools | 订单、Query Rewrite、Milvus BM25 全文检索、混合融合、重排、标题感知文档解析和分块 | app/tools/ |
| Memory | LangChain 摘要中间件、LangGraph Checkpointer、Redis 短期订单 | app/memory/ |
| Agent | 有界的固定编排，每轮最多调用一个只读工具 | app/agent/service.py |
| MySQL | 会话、订单、问答运行、文档版本与当前版本指针、文本分片原文 | app/mysql/store.py |
| Redis | 短期记忆、限流、会话锁、文档队列 | app/redis/store.py |
| Milvus | 保存 Chunk、稠密向量和 BM25 稀疏向量，检索时按 owner 过滤 | app/milvus/store.py |
| 模型 | DeepSeek 意图 / 改写 / 回答 + 本地 BGE Embedding + 本地 BGE Cross-Encoder | app/models.py、embedding/ |

目录结构：

> app/router/       # Router
>
> intent/           # 本地轻量意图分类服务
>
> app/api/           # API 路由和鉴权入口
>
> app/tools/        # Tools 与文档解析
>
> app/memory/       # Memory
>
> app/agent/        # Agent 编排
>
> app/mysql/        # MySQL 适配器
>
> app/redis/        # Redis 适配器
>
> app/milvus/       # Milvus 适配器
>
> frontend/         # React + TypeScript 内网控制台
>
> scripts/worker.py # 异步文档解析 Worker

意图识别按三级链路执行：明确订单号、问候和订单关键词由规则直接处理；其他问题先交给本地字符特征分类器；小模型置信度不足时才调用 DeepSeek。这里的 Agent 是有边界的工作流：模型只负责识别意图和生成检索词，工具调用、权限过滤、召回融合和引用校验由服务端固定执行。文档支持 TXT、Markdown、PDF 和 DOCX，解析任务通过 Redis 队列交给独立 Worker。

文档导入使用 Unstructured 本地解析 PDF 和 DOCX，先产出 Title、NarrativeText、ListItem、Table 等结构化元素，再按标题路径组织段落。PDF 固定使用 Unstructured 的 `hi_res` 版面策略，并启用表格结构识别和中文 OCR；版面解析失败时导入会明确标记为失败，不会静默降级为纯文本。章节过长时由项目分块器按句子边界聚合到约 800 字，并保留最多 120 字重叠；超长句才使用滑动窗口。每个分片都会带上“标题路径”，因此检索结果可以保留章节上下文。

关键词召回使用 Milvus 全文检索：集合中的 text 字段开启 jieba 中文分词，Milvus 在写入时通过 BM25 Function 自动生成稀疏向量，并在全集合范围维护词频、文档频率和平均长度。检索时直接传入问题文本，Milvus 按 BM25 分数返回 Top-K，同样由服务端注入 owner 过滤。MySQL 只保存分片原文，是可重建索引的事实来源。

从旧版本升级时，新代码会使用新的 collection，已导入的文档需要执行一次迁移，把各文档当前版本的分片从 MySQL 重新写入 Milvus。启动时的数据库迁移（见"数据库迁移"）会自动把旧文档登记为第 1 版；早期通过 POST /documents 导入、没有文档记录的分片，会在迁移时按用户和标题补建文档：

> docker compose exec api python -m scripts.reindex

## 启动

需要 Docker Engine / Docker Desktop 和 Docker Compose v2；Milvus 有一定内存开销，建议为 Docker 分配至少 8 GB 内存。首次运行需要联网拉取镜像及 Python 依赖。

进入目录，复制配置：

> cd production-rag
>
> cp .env.example .env

分别生成随机字符串，填入 .env 中的 JWT_SECRET、ADMIN_PASSWORD、ALICE_PASSWORD、BOB_PASSWORD、MYSQL_PASSWORD、MYSQL_ROOT_PASSWORD、REDIS_PASSWORD、LANGGRAPH_POSTGRES_PASSWORD。每次运行下面的命令得到一个新值，不要共用：

> python3 -c "import secrets; print(secrets.token_hex(24))"

保持 MODEL_MODE=demo，即可无需外部模型 Key 启动：

如果本机安装的是独立版 Compose，可将下方命令中的 `docker compose` 替换为 `docker-compose`。

> docker compose up --build -d
>
> docker compose ps
>
> docker compose logs -f api

浏览器打开 [内网控制台](http://localhost:3001)，用 admin / alice / bob 和 `.env` 中对应的密码登录。控制台支持文档上传、解析状态查看、知识问答和引用来源展示。如果 3001 已被占用，先检查端口并在 `.env` 中设置 `FRONTEND_PORT` 为其他空闲端口。

Milvus 首次启动可能较慢，API 会等依赖健康后再启动。运行全链路演示：

> docker compose exec api python -m scripts.demo

脚本会导入两名用户的私有文档，依次演示知识检索、订单查询、上下文追问、他人订单拒绝、请求重放和会话越权拒绝。

浏览器打开 [API 文档](http://localhost:8000/docs)，先调用 POST /auth/login 取得 access_token，再点击 Authorize 填入它（30 分钟后过期，用 POST /auth/refresh 换新）。调用顺序：

1. POST /documents/upload，上传 TXT、Markdown、PDF 或 DOCX，得到 document_id。要更新已有文档时带上 replace_document_id（该文档任一版本的 id），可选 version_note 版本说明；版本号由系统递增。内容与当前版本完全相同时返回 status=duplicate，不再解析。
2. GET /documents/{document_id}，轮询 queued / processing / ready / failed 状态。
3. DELETE /documents/{document_id}，删除整份文档的全部版本及其原文件、向量和全文索引；任一版本处理中时不能删除。
4. POST /sessions，取得 session_id；问答记录会写入 MySQL。
5. GET /history，读取当前用户最近 50 条已保存问答；控制台刷新后会自动恢复显示。
6. POST /chat/stream，填写 session_id、新的 request_id（UUID）和 question；服务通过 SSE 返回每个后端阶段，最后发送完整结果。需要非流式调用时仍可使用 POST /chat。

可使用以下命令生成 request_id；重试同一次问答时复用原 ID，新问题使用新 ID：

> python3 -c "import uuid; print(uuid.uuid4())"

问答响应包括 answer、sources、route、steps、trace_id、model_mode 和 last_order。检索步骤会展示改写后的 queries、向量命中、关键词命中、融合候选数和重排数量。Last_order 是用于观察记忆的教学字段。每个 HTTP 响应还有 X-Trace-ID；重放响应体保留首次运行的 trace_id，响应头对应本次 HTTP 请求。

问答执行链使用 LangGraph 编排，节点依次为：接收问题、读取记忆、应用框架记忆策略、意图识别、Router、Query Rewrite、混合检索、上下文组装、回答生成和完成。Router 通过条件边进入 LangChain Tool 包装后的订单工具、问候或知识检索分支。节点更新由 LangGraph `updates` 流直接转为 SSE，前端继续展示每个阶段的结构化结果。

MySQL 保存完整业务问答和审计记录；LangGraph 使用独立 PostgreSQL Checkpointer 按用户与会话保存消息状态；LangChain `SummarizationMiddleware` 在模型调用前统计 Token，达到 `MEMORY_TRIGGER_TOKENS` 后自动摘要，并保留 `MEMORY_KEEP_MESSAGES` 条最近消息。Redis 只保存近期订单缓存、限流、会话锁和文档队列。Milvus 与关键词混合检索通过受控 LangChain Tool 调用，owner 权限条件始终由服务端注入。

停止服务且保留数据：

> docker compose stop

MySQL、LangGraph PostgreSQL、Redis 和 Milvus 使用命名卷。不要随意移除数据卷。数据库初始化后的账号密码不能只靠修改 .env 来变更，需要同时修改已有数据库账号。

## 两种模型模式

默认 demo 模式使用字符二元组哈希向量，并直接展示检索到的原文。它可以检查权限、存储和调用流程，但不是语义 Embedding，不用于评价真实问答质量。MySQL、Redis 和 Milvus 在此模式仍是真实服务。

真实模式将 `.env` 的 `MODEL_MODE` 改为 `openai`。聊天模型使用 OpenAI 兼容接口，默认地址是 DeepSeek；Embedding 推荐使用随项目运行的本地 BGE：

- LLM_BASE_URL、LLM_API_KEY、LLM_MODEL：聊天模型，默认 `https://api.deepseek.com`。
- EMBEDDING_MODE=local、EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5、EMBEDDING_DIM=512：本地模型首次启动时自动下载到 `embedding_cache` 卷。
- RERANK_MODE=local、RERANKER_MODEL=BAAI/bge-reranker-base：首次检索时按需下载 Cross-Encoder，用于对多路候选做最终重排。机器内存有限时可设为 `off`，系统仍使用 RRF + 词法重排。
- INTENT_MODE=local、INTENT_URL=http://intent:8091/v1：启用本地轻量意图分类服务。它使用中文字符 n-gram + Logistic Regression，启动时加载内置样本；置信度不足的请求才升级到 DeepSeek。需要关闭时设置 `INTENT_MODE=off`。
- 如果改用外部 Embedding，将 `EMBEDDING_MODE` 改为 `openai`，再填写 EMBEDDING_BASE_URL、EMBEDDING_API_KEY 和实际的 EMBEDDING_DIM。

然后重新创建 API、Worker 和本地 Embedding 服务，并重新导入文档：

> docker compose up -d --build --force-recreate embedding api worker
>
> docker compose exec api python -m scripts.demo

不同模式、Embedding 服务地址、模型及维度使用不同 Milvus collection，避免混用向量空间。真实模式只对 DeepSeek 聊天接口产生费用，本地 Embedding 不产生 API 费用。模型调用不自动重试，连接超时 5 秒、读写等网络阶段超时 20 秒；这不是整个请求的绝对截止时间。

## 已落实的工程边界

- 身份来自服务端签发的 JWT；会话和订单只属于当前用户，文档按可见范围检查读权限，修改和删除只允许上传者（见"登录与文档权限"）。
- MySQL、Redis、Milvus 不发布宿主机端口，API 只监听宿主机 127.0.0.1。
- 未认证请求返回 401，不属于自己的会话返回 404。
- 同一个已成功 request_id 返回原结果；同 ID 换问题返回 409。尚未完成的同会话请求返回 409。
- MySQL 提交后才返回成功。进程在模型调用后、提交前崩溃，重试仍可能再次调用模型；不是外部调用 exactly-once。
- Redis 原子限流；依赖故障返回 503，不绕过权限或限流。
- 会话锁有 180 秒租期；保存前确认锁仍属于当前请求。它不提供自动续租或长任务调度。
- 记忆按用户、会话、最近成功运行 ID 分版本，避免旧缓存覆盖新状态。
- 文档按版本管理：同一份文档的每次上传是一个版本，document_heads 记录当前版本，检索只放行当前版本的分片。新版本处理完成后才切换，处理中或失败时旧版本继续服务；并发上传时版本号更大的才能成为当前版本。旧版本切换后清理向量和分片，保留版本记录与原文件。
- 内容 sha256 与当前版本相同的上传直接返回已有文档，不重复解析和向量化。分片主键为"版本 id:序号"，另有跨版本稳定的 chunk_key（doc_key 加分片文字的哈希），供评测标注和增量 embedding 使用。
- 增量 embedding：新版本按 chunk_key 找出和当前版本文字相同的分片，直接复用它们的向量，只对新增或改过的分片调用向量模型；当前版本用的向量模型或维度不同时全部重新计算。复用和新计算的数量显示在导入步骤里。
- Worker 以 MySQL 中的版本状态作为完成日志：启动时把状态仍为 queued 或 processing 的版本重新投递（被中断的任务不会丢）；Milvus 或向量服务连不上等暂时性错误最多尝试 3 次，文档本身的问题（没有文字、格式不支持）直接标记失败。每次尝试前清掉该版本写了一半的数据，重做不会主键冲突。
- 检索来源不足时拒答：重排相关概率低于 RERANK_MIN_SCORE 的来源会被丢弃，全部丢弃时直接拒答，不调用回答模型；真实模型返回的引用编号必须来自本次来源。编号合法不代表事实一定受到来源支持。
- /health/live 检查进程，/health/ready 检查实际数据库连接；不检测付费模型服务状态。
- 日志只记录 trace_id、路径、状态和耗时，不记录密码、令牌、问题正文和来源。

## 登录与文档权限

用户名密码登录后，服务端发两种令牌（代码见 app/auth.py）：

- 访问令牌：JWT，30 分钟有效，每个请求放在 Authorization: Bearer 里。服务端只验证签名和过期时间，不用保存；但每次请求仍会读取用户记录，所以停用用户、调整部门立即生效。
- 刷新令牌：随机字符串，7 天有效，只用来换新的访问令牌。服务端只保存它的 sha256，因此退出登录、改密码、停用用户时可以立即作废。每次刷新都换一个新的刷新令牌，旧的作废；已作废的令牌又被使用，说明可能被盗，这个用户的全部刷新令牌一起作废。

原来的身份识别方式是 .env 里的 API Key：永不过期，泄露后只能改配置重启，新增用户也要改配置。

其他防护：密码用 scrypt 加盐哈希；同一用户名 15 分钟内失败 5 次后暂时拒绝登录；用户不存在和密码错误返回同样的提示、耗时也相同；JWT 只接受 HS256，不接受 alg=none。

首次启动时按 .env 创建 admin（管理员）、alice、bob 三个用户，已存在时不覆盖。之后由管理员在"设置 → 用户与部门"中创建用户、部门，调整用户所属部门，重置密码或停用。用户名 eval 保留给评测语料。

文档可见范围按整份文档（所有版本共用）设置，上传新文档时选择，之后上传者可以在详情页修改：

- 仅自己（默认）：升级前的文档都按这个处理，和原来的行为一致；
- 指定部门：上传者和所选部门的成员可以检索、查看；
- 所有人：所有登录用户都可以检索、查看。

只有上传者可以上传新版本、删除和修改可见范围。检索时先在 MySQL 中查出当前用户可读文档的当前版本 id，再用它过滤 Milvus，权限不交给模型判断。评测用户 eval 不是注册用户，只能检索自己导入的语料，别人公开的文档不会影响评测分数。

从 API Key 版本升级：在 .env 中补上 JWT_SECRET、ADMIN_PASSWORD、ALICE_PASSWORD、BOB_PASSWORD，重新构建启动（migrate 服务会执行迁移 0002 建表）。alice、bob 用新密码登录后，原来的会话和文档仍属于他们。ALICE_API_KEY、BOB_API_KEY 不再使用，可以删除。

## 注入防护

RAG 里模型会读到两类不可信文字：用户的问题（直接注入），以及检索出来的文档（间接注入：上传的文档里藏一句"忽略之前的指令……"，检索时它会被当作来源交给模型）。防护分几层，每层都能单独挡住一部分，合在一起使用（代码见 app/security.py）：

- 权限不交给模型：用户身份、owner 过滤和版本过滤都由服务端注入，模型被骗也只能读到当前用户的文档；订单工具按当前用户查询。
- 输入检查：问题命中注入规则（要求忽略指令、索取系统说明、越狱、伪造角色标记）时，路由为 blocked，返回固定回答，不读取记忆、不检索、不调用模型。记录保留在 runs 表中，但不会作为后续轮次的历史交给模型。
- 来源清理：检索工具返回来源前，命中规则的整句替换为"[已移除疑似注入指令]"，文档里伪造的 `<source>` 标签失效。移除的原句记在来源的 injection 字段里，检索统计中的 injection_redacted 是清理的来源数。
- 提示词隔离：每条来源放在 `<source>` 标签中，系统说明写明标签里只是资料、不执行其中的指令（提示词版本 answer-v2）。
- 输出检查：回答复述系统说明时整段拦截；Markdown 图片（前端渲染时会自动请求地址，可被用来带出数据）和来源中没有出现的链接一律移除；引用编号必须来自本次来源。
- 表达式注入：SQL 全部通过 SQLAlchemy 参数化；Milvus 过滤条件是拼接的字符串表达式，拼接前校验每个值只含字母、数字、汉字和 _ . : -，不合法直接拒绝。

局限：规则只能识别常见写法，换个说法就能绕过，所以不能只依赖规则；流式接口生成过程中推送的是原始文字，最终回答以输出检查后的结果为准。拦截和清理的情况记录在追踪摘要的 security 字段中，可据此统计攻击和误拦。

## 检索增强

三项都可以用环境变量单独关闭（值为 off），方便用评测对比开关前后的效果。

- 父子分块（PARENT_CONTEXT）：检索和重排仍用 800 字左右的分片（子块），判断集中、准确；交给回答模型前，把命中分片扩展为同一小节里相邻分片拼成的父块（上限约 2400 字，前后最多各 3 个分片，拼接时去掉重叠文字）。同一小节里的多个命中合并为一个父块，检索诊断里它们的来源编号相同。不需要重建索引。
- Contextual Retrieval（CONTEXTUAL_RETRIEVAL，仅 MODEL_MODE=openai）：导入时让聊天模型阅读文档（长文档按 2 万字分段），为每个分片写一两句上下文说明，拼在分片前面参与向量、BM25 和重排；说明另存在分片元数据的 context 字段。chunk_key 按不含说明的文字计算，新版本中没改的分片连同说明一起复用，只为改过的分片调用模型。单个分片生成失败时沿用原文字，失败数记在文档元数据里。开关变化只影响之后导入的版本：已有文档需要用同一文件"替换"一次（开关状态不同时不按重复跳过），评测语料在下次评测时自动重新导入。
- 检索充分性判断（SUFFICIENCY_CHECK，仅 MODEL_MODE=openai）：重排只逐条判断相关性，看不出"资料都相关但没有答案"。检索后把问题和全部来源交给聊天模型判断 sufficient / partial / insufficient；insufficient 时追加模型给出的补充检索词再检索一次并重新判断，仍不足就清空来源、直接拒答；partial 时照常回答，但提示模型只回答资料支持的部分并说明缺什么。判断调用失败时按充分处理。处理阶段里会显示"检索充分性判断"和可能的"补充检索"两步；生成评测同样执行这一步，结论记在每题的 sufficiency 字段。

## 对账

MySQL 和 Milvus 没有共同事务。重试和启动恢复处理的是程序知道自己失败的情况；清理旧版本失败只记了日志、代码缺陷、手动删过 Milvus 数据这类情况，由对账脚本兜底。它一次遍历 Milvus 集合，与 MySQL 的版本状态和分片数比对：

> docker compose exec api python -m scripts.reconcile
>
> docker compose exec api python -m scripts.reconcile --fix

默认只输出报告，发现问题时退出码为 1，适合放进定时任务。加 --fix 后：当前版本缺向量的，用 MySQL 分片原文重新计算并写回；当前版本 MySQL 分片不全的，重新交给 Worker 从原文件处理；已失效版本的残留数据和 MySQL 中已不存在的版本直接清理；当前版本指针异常等情况只报告，需要人工确认。建议在出过故障、恢复过数据之后手动运行一次。

## 评测

评测分两类：检索评测不调用大模型，几十秒跑完，每次改动检索参数后都应该跑；生成评测需要大模型当评审（会产生少量费用），大改动后再跑。

- 评测集：eval/dataset.jsonl，每行一道题，字段为 question、type（事实 / 同义改写 / 关键词 / 多轮追问 / 无法回答）、answerable、evidence（证据原文列表）、reference_answer、split（dev 日常调参，holdout 只做最终验证）。标注的是证据原文而不是分片 ID：检索结果里只要有分片包含证据原文（去空白、统一全角半角后比较）就算命中，所以改分块参数或上传新版本后标注依然有效。
- 语料：eval/corpus/*.md，评测时自动以专门的评测用户 eval 导入，内容不变时直接跳过，与 alice、bob 的知识库互相隔离。
- 检索指标分三个阶段：召回（RRF 前 20 的候选池）、重排后前 6、阈值过滤后；每个阶段计算 Recall 和 MRR，另算误杀率（能回答的题来源被全部过滤）和漏放率（无法回答的题仍留下来源）。结果还包含按题型分组的指标、检索漏斗、阈值扫描（0.05～0.9）和可选的消融 / 参数对比。
- 结果：eval/results/日期时间_提交号.json，可随代码提交；命令行和界面都会自动与上一次同类评测对比。

命令行（容器里没有 .git，用 GIT_COMMIT 传入提交号）：

> docker compose exec -e GIT_COMMIT=$(git rev-parse --short HEAD) api python -m scripts.eval_run
>
> docker compose exec -e GIT_COMMIT=$(git rev-parse --short HEAD) api python -m scripts.eval_run --suite ablation --suite params
>
> docker compose exec -e GIT_COMMIT=$(git rev-parse --short HEAD) api python -m scripts.eval_run --generation

--generation 需要 MODEL_MODE=openai 和 LLM_API_KEY；--split holdout 在留出集上做最终验证；--refresh-rewrites 用大模型重新生成并缓存查询改写（eval/rewrites.json），之后的检索评测都复用这份缓存，保证可复现。

界面：左侧“评测”页面可以浏览评测集、发起检索或生成评测、查看总览 / 逐题明细 / 阈值扫描 / 消融对比，并选择任意两次评测对比。生成评测要求 MODEL_MODE=openai 和 LLM_API_KEY，且只运行基线；消融和参数对比属于检索评测。api 服务把仓库的 eval 目录挂载到容器内；Linux 主机上如果容器用户无权写入 eval/results，需要调整该目录权限。

## 追踪与用户反馈

每次成功的问答都存进 runs 表：response 里是完整的阶段记录和检索诊断，另有从中提取的追踪摘要（app/observability.py），单独成列以便筛选和统计：

- route、refused（是否为固定拒答）、duration_ms（总耗时）、top_score（检索候选最高分，拒答时也能看出离阈值差多少）；
- trace（JSON）：各阶段耗时、查询改写结果、召回 / 融合 / 过滤数量、前 10 个候选的分片 ID、chunk_key、名次与重排分、回答模型、提示词版本（PROMPT_VERSION，改提示词时加一）和 Token 用量（ChatOpenAI 开启 stream_usage，演示模式为空）。

处理失败的问答写入 run_errors 表：错误摘要、状态码、最后完成的阶段（失败发生在它之后）和已完成阶段的耗时。错误详情只在数据库里，不返回给客户端。runs.id 就是请求的 request_id，也是反馈和排查时用的编号。

用户反馈：每条回答下方可以点“有帮助 / 没帮助”，点踩立即保存，之后可以补充原因（答错了、没答全、资料里有却说找不到、引用不对、其他）和正确答案。每条回答只保留最新一条反馈，存在 feedback 表。

- POST /feedback：{request_id, rating: 1 或 -1, reason?, comment?}，只能评价自己的回答；
- GET /feedback：当前用户的反馈列表，附带问题、回答和追踪摘要；默认只列点踩，rating=0 列出全部；
- GET /history 的每条记录带上 feedback 字段。

排查坏例的常用查询：

> SELECT id, question, top_score, duration_ms FROM runs WHERE refused ORDER BY created DESC LIMIT 20;
>
> SELECT f.reason, f.comment, r.question, r.trace FROM feedback f JOIN runs r ON r.id = f.run_id WHERE f.rating = -1 ORDER BY f.updated DESC;
>
> SELECT last_step, COUNT(*) FROM run_errors GROUP BY last_step;

## 数据管理与数据查询

侧边栏的"数据管理"页面维护 8 种业务数据：商品、客户、订单、库存、物流单、售后工单、促销活动、商品评价。每种数据一个 Tab，只显示当前用户有查看权限的类型；支持搜索、来源筛选、排序、分页、手动录入、编辑和删除（软删除）。

- 配置驱动：字段、类型、枚举、引用关系、敏感字段、同义词都写在 app/data/schema.py。页面表单、后端校验、AI 生成的提示词、聊天查询给模型的字段说明都从这一份配置生成，新增一种数据只需建表加配置。
- 权限：管理员在"设置 → 数据权限"里按部门勾选查看、新增、修改、删除；用户权限是所在部门的并集，每次请求从数据库读取，修改立即生效。迁移 0003 预置了客服部、运营部、仓储部、财务部和一套默认权限。手机号等敏感字段只对有修改权限的人显示完整值，聊天回答里始终脱敏。
- AI 生成：填写条数和描述后先生成预览，确认后才写入。引用字段由代码从已有数据里挑选，订单金额、日期、运单号、手机号由代码生成，模型只负责内容字段；写入时逐行重新校验。AI 数据带 batch_id，可以整批删除。demo 模式没有大模型时使用本地模板。
- 聊天查询：意图识别新增 data 路由（规则 → 本地小模型 → 大模型）。DataQueryTool（app/tools/data_query.py）让模型只输出 JSON 查询计划，代码校验字段、操作符和权限后编译成 SQL 执行，回答由模板直接拼出数据库结果。demo 模式或模型输出不合法时使用规则生成查询计划。单个订单号的状态查询仍走原来的订单工具，它也会检查订单查看权限。

示例问题：

> 哪些商品快缺货了
>
> 这周有几单待发货的订单
>
> A1002 的快递到哪了
>
> 现在有什么促销活动

## 数据库迁移

MySQL 表结构由 Alembic 管理。每次改表写成 migrations/versions/ 下的一个迁移脚本，脚本按编号连成一条链；数据库里的 alembic_version 表记录这个库已经执行到哪一个。执行 alembic upgrade head 时只按顺序执行还没执行过的脚本，所以新库、旧库、各个环境都用同一条命令升级。

docker compose up 时，migrate 服务会先执行 alembic upgrade head，成功后 API 和 Worker 才启动。第一个迁移 0001_baseline 同时适用于空库和接入 Alembic 之前的旧库：空库直接建表；旧库补齐缺少的列、索引，并把没有版本信息的文档登记为第 1 版。

改表的流程：

1. 修改 app/mysql/store.py 中的表定义，例如给 orders 加一列 phone；
2. 生成迁移草稿，编号按顺序接着写：

> docker compose run --rm -v ./migrations:/app/migrations migrate alembic revision --autogenerate --rev-id 0002 -m "orders 增加 phone"

3. 检查生成的 upgrade() 和 downgrade()。自动生成只比较结构：改列名会变成"删列再加列"（数据会丢），补旧数据这类数据修改也要自己写；
4. 重新构建并启动，migrate 服务会先执行新的迁移；确认无误后把迁移脚本和代码一起提交：

> docker compose up -d --build

常用命令：

> docker compose run --rm migrate alembic current　　　查看当前版本
>
> docker compose run --rm migrate alembic history　　　查看全部迁移
>
> docker compose run --rm migrate alembic downgrade -1　回退一步

tests/test_migrations.py 会在 SQLite 上执行全部迁移，并与 store.py 的表定义比较；改了表定义却忘了写迁移，测试会失败并列出差异。

## 测试

可以在容器内运行，或使用 Python 3.11+ 的独立虚拟环境：

> python3 -m venv .venv
>
> .venv/bin/pip install -r requirements-test.txt
>
> .venv/bin/python -m pytest -q tests

回归测试使用 SQLite、fakeredis 和 Milvus 测试替身，验证权限隔离、知识检索、幂等、记忆恢复、限流、会话锁、依赖故障和引用校验。它们不能代替真实 MySQL / Redis / Milvus 集成验证；demo.py 用于运行中的真实服务冒烟检查。

## 继续走向生产

单机内网 MVP 已具备内部试点所需的基本闭环；正式承载关键业务前仍需要对接企业统一登录（SSO）、JWT 密钥轮换、HTTPS、真实模型质量评估、监控告警、备份恢复和负载测试。本项目当前评测集和本地重排模型将相关性阈值 RERANK_MIN_SCORE 默认设为 0.85；换用语料或模型后仍必须用“评测”页面的阈值扫描并在留出集验证，关闭重排时不做相关性过滤。

当前部署使用单实例 API 和单机存储，不提供高可用；MySQL 表结构由 migrate 服务在启动前统一升级；建 Milvus collection 仍在 API 启动时执行，不应直接增加并发启动副本。默认示例订单即使切换真实模型也仍是演示数据。

参考：[Milvus Docker 部署](https://milvus.io/docs/install_standalone-docker.md)、[MilvusClient 创建集合](https://milvus.io/api-reference/pymilvus/v2.6.x/MilvusClient/Collections/create_collection.md)。

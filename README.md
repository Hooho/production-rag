# Production RAG

企业内部知识库问答系统，基于 RAG 实现文档检索和智能问答。

## 项目功能

- 文档上传与解析
- 支持 TXT、Markdown、PDF、DOCX
- 文档分块与版本管理
- 向量检索
- 关键词检索
- 混合检索
- 查询改写
- 结果重排
- 上下文记忆
- 引用来源展示
- 用户、部门和文档权限管理
- RAG 检索评测
- Web 管理控制台
- 业务数据查询与管理

## 启动项目

### 环境要求

- Docker Engine 或 Docker Desktop
- Docker Compose v2
- 建议 Docker 至少分配 8 GB 内存

### 获取项目

> git clone https://github.com/Hooho/production-rag.git
>
> cd production-rag

### 配置环境

> cp .env.example .env

修改 `.env` 中的密码、JWT 密钥和模型配置。

默认使用 `MODEL_MODE=demo`，不需要外部大模型 API Key。

首次启动会下载本地 Embedding 和重排模型。模型会缓存到 Docker 数据卷，后续启动不会重复下载。

### 一键启动

> docker compose up --build -d

查看服务状态：

> docker compose ps

查看日志：

> docker compose logs -f api

### 访问地址

Web 控制台：

> http://localhost:3001

API 文档：

> http://localhost:8000/docs

### 停止服务

> docker compose stop

如果使用 Colima，需要确保项目目录已经加入 Colima 的挂载目录。

# 单 Agent + LangGraph 节点编排 架构

一个 Agent 通过 LangGraph 统一管理意图识别、路由、Memory、检索、充分性判断和答案生成；订单查询、业务数据查询和知识检索是 Tool

各个能力有模块划分，但由同一个主 Agent 和同一张 LangGraph 直接组合、调用和管理。

以 LangGraph 中心 的模块化架构

## 项目功能

- 文档上传与解析，支持 TXT、Markdown、PDF、DOCX
- 文档分块与版本管理
- 向量检索
- 关键词检索
- 混合检索
- 查询改写
- 结果重排
- 上下文记忆
- 引用来源展示
- 用户、部门和文档权限管理
- RAG 检索评测体系

## 启动项目

### 环境要求

- Docker Engine 或 Docker Desktop
- Docker Compose v2

### 配置环境

> cp .env.example .env

复制后即可使用默认开发密钥启动。

首次启动会下载本地 Embedding 和重排模型。模型会缓存到 Docker 数据卷，后续启动不会重复下载。

### 一键启动

> docker compose up --build -d

### 访问地址

Web 控制台：

> http://localhost:3001

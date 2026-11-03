"""知识图谱：从分片里抽取实体和关系，跨文档合并成一张图（见 claude/graph-retrieval-plan.md）。

- schemas.py：清单（抽哪些实体类型、关系分哪几类），内置默认清单
- extract.py：逐片抽取，复用相同分片的抽取结果
- resolve.py：规范化名字，把每个名字归到全局实体
- build.py：建图任务（worker 分批执行）
- query.py：页面读取的数据，按文档权限过滤
"""

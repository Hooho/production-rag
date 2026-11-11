import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// 同一个组件必须正确解释历史记录和新流程，避免把旧的主题词数据当成完整问题。
test("graph trace renders new relation pipeline and preserves legacy records", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { GraphRetrievalTrace } = await server.ssrLoadModule(
      "/src/GraphRetrievalTrace.tsx",
    );
    const graph = {
      status: "ok",
      reason: null,
      scope: [],
      keywords: {
        source: "agent",
        entities: ["段永平"],
        themes: ["投资"],
        question: "段永平投资哪些公司",
      },
      name_matches: [],
      entities: [],
      entity_relations: [],
      relation_matches: [],
      tables: { entity: [], relation: [] },
      dropped_more: {},
      timings: {},
    };
    const legacy = renderToStaticMarkup(
      createElement(GraphRetrievalTrace, { graph }),
    );
    const modern = renderToStaticMarkup(
      createElement(GraphRetrievalTrace, {
        graph: {
          ...graph,
          pipeline: "hybrid_relations_v2",
          relation_candidates: [],
          relation_candidate_counts: { total: 188, in_pool: 100, kept: 30 },
        },
      }),
    );
    const withEntities = renderToStaticMarkup(
      createElement(GraphRetrievalTrace, {
        graph: {
          ...graph,
          pipeline: "hybrid_relations_v2",
          entities: [
            {
              entity_id: "a",
              name: "有关系的实体",
              type: "人物",
              names: [],
              score: 1,
            },
            {
              entity_id: "b",
              name: "零关系实体应隐藏",
              type: "人物",
              names: [],
              score: 1,
            },
          ],
          entity_relations: [
            {
              relation_id: "r",
              entity_id: "a",
              entity_name: "有关系的实体",
              source: "有关系的实体",
              source_entity: "有关系的实体",
              source_entity_id: "a",
              source_type: "人物",
              target: "公司",
              target_entity: "公司",
              target_entity_id: "c",
              target_type: "组织",
              category: "投资",
              description: "买入股票",
              evidence: "",
              kept: true,
              score: 1,
              chunk_id: "d:1",
              document_id: "d",
              version_id: "v",
              version_number: 1,
              title: "文档",
              reason: null,
            },
          ],
        },
      }),
    );
    assert.match(withEntities, /有关系的实体/);
    assert.doesNotMatch(withEntities, /零关系实体应隐藏/);
    assert.match(modern, /aria-label="关系候选筛选步骤"/);
    assert.match(modern, /title="查看候选的 188 条关系及对应分片"/);
    assert.match(modern, /title="查看进入重排的 100 条关系及对应分片"/);
    assert.match(modern, /title="查看留下的 30 条关系及对应分片"/);
    const many = renderToStaticMarkup(
      createElement(GraphRetrievalTrace, {
        graph: {
          ...graph,
          name_matches: Array.from({ length: 8 }, (_, i) => ({
            keyword: `关键词${i}`,
            name: `名字${i}`,
            entity_id: `e${i}`,
            entity_name: `名字${i}`,
            score: i / 10,
            kept: true,
          })),
        },
      }),
    );
    const summary = many.match(
      /<table class="diag-table grt-table grt-count-table">([\s\S]*?)<\/table>/,
    )?.[1];
    assert.ok(summary);
    assert.equal((summary.match(/<tr>/g) ?? []).length, 7); // 表头＋每页六条
    assert.ok(summary.indexOf("关键词7") < summary.indexOf("关键词6"));
    assert.doesNotMatch(summary, /关键词0|关键词1/);
    assert.match(modern, /候选合并与关系重排/);
    assert.doesNotMatch(modern, /<td>概括<\/td>/);
    assert.match(legacy, /<td>概括<\/td>/);
    assert.doesNotMatch(legacy, /候选合并与关系重排/);
  } finally {
    await server.close();
  }
});

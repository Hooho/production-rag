from sqlalchemy import select

from app.mysql.store import data_audit, orders
from test_app import headers, question, session, setup  # noqa: F401  setup 是 pytest fixture


# 管理员建部门并授予权限，再把用户加进部门。
def grant(client, username, group_id, data_type, **flags):
    client.post("/admin/groups", headers=headers("admin"), json={"id": group_id, "name": group_id})
    response = client.put("/admin/data-permissions", headers=headers("admin"),
        json={"group_id": group_id, "data_type": data_type, **flags})
    assert response.status_code == 200
    user = client.get("/admin/users", headers=headers("admin")).json()["users"]
    groups = []
    for item in user:
        if item["username"] == username:
            groups = item["groups"]
    if group_id not in groups:
        groups.append(group_id)
    assert client.patch(f"/admin/users/{username}", headers=headers("admin"), json={"groups": groups}).status_code == 200


# 以管理员身份新增一条记录并返回 id。
def create(client, data_type, values, owner="admin"):
    response = client.post(f"/data/{data_type}/records", headers=headers(owner), json={"values": values})
    assert response.status_code == 201, response.text
    return response.json()["id"]


# 准备一个商品、一个客户和一个订单。
def seed(client):
    product = create(client, "products", {"name": "蓝牙耳机", "category": "数码", "price": 199.5})
    customer = create(client, "customers", {"name": "张三", "phone": "13812345678", "level": "VIP",
        "registered_at": "2026-01-02"})
    order = create(client, "orders", {"customer_id": customer, "product_id": product, "quantity": 2,
        "status": "待发货", "ordered_at": "2026-09-28"})
    return product, customer, order


def test_types_follow_permissions(setup):
    client, _ = setup
    admin_types = client.get("/data/types", headers=headers("admin")).json()["types"]
    assert len(admin_types) == 8
    assert client.get("/data/types", headers=headers()).json()["types"] == []
    assert client.get("/data/orders/records", headers=headers()).status_code == 403
    grant(client, "alice", "service", "orders", read=True)
    types = client.get("/data/types", headers=headers()).json()["types"]
    assert [item["key"] for item in types] == ["orders"]
    assert types[0]["permissions"] == ["read"]
    # 只能看，不能新增和删除。
    assert client.post("/data/orders/records", headers=headers(), json={"values": {}}).status_code == 403
    assert client.delete("/data/orders/records/A1001", headers=headers()).status_code == 403


def test_create_validates_and_derives_amount(setup):
    client, store = setup
    product, customer, order = seed(client)
    assert product == "P0001" and customer == "C0001"
    # 演示订单已有 A1001，新订单接着编号。
    assert order == "A1002"
    with store.engine.connect() as connection:
        row = connection.execute(select(orders).where(orders.c.id == order)).mappings().first()
        audits = connection.execute(select(data_audit)).mappings().all()
    assert row["amount"] == 399.0
    assert row["owner"] == "admin" and row["source"] == "manual"
    assert len(audits) == 3
    bad = client.post("/data/orders/records", headers=headers("admin"), json={"values": {
        "customer_id": "C9999", "product_id": product, "quantity": 0, "status": "飞走了", "amount": 1}})
    assert bad.status_code == 422
    errors = bad.json()["errors"]
    assert set(errors) == {"customer_id", "quantity", "status", "amount", "ordered_at"}
    # 退款金额不能超过订单金额。
    refund = client.post("/data/after_sales/records", headers=headers("admin"), json={"values": {
        "order_id": order, "type": "退款", "reason": "重复下单", "amount": 500}})
    assert refund.status_code == 422
    assert "amount" in refund.json()["errors"]


def test_list_search_mask_and_soft_delete(setup):
    client, _ = setup
    seed(client)
    grant(client, "alice", "service", "customers", read=True)
    items = client.get("/data/customers/records", headers=headers()).json()["items"]
    assert items[0]["phone"] == "138****5678"
    # 没有修改权限的人不能用手机号片段搜索。
    assert client.get("/data/customers/records?q=1381234", headers=headers()).json()["total"] == 0
    assert client.get("/data/customers/records?q=1381234", headers=headers("admin")).json()["total"] == 1
    orders_page = client.get("/data/orders/records?q=A1002", headers=headers("admin")).json()
    assert orders_page["items"][0]["customer_id_label"] == "张三"
    assert client.delete("/data/orders/records/A1002", headers=headers("admin")).status_code == 200
    assert client.get("/data/orders/records?q=A1002", headers=headers("admin")).json()["total"] == 0
    assert client.delete("/data/orders/records/A1002", headers=headers("admin")).status_code == 404


def test_update_checks_rules(setup):
    client, _ = setup
    product, _, order = seed(client)
    response = client.patch(f"/data/orders/records/{order}", headers=headers("admin"), json={"values": {"quantity": 3}})
    assert response.status_code == 200
    page = client.get(f"/data/orders/records?q={order}", headers=headers("admin")).json()
    assert page["items"][0]["amount"] == 598.5
    create(client, "inventory", {"product_id": product, "warehouse": "上海仓", "quantity": 5, "safety_stock": 10})
    duplicate = client.post("/data/inventory/records", headers=headers("admin"), json={"values": {
        "product_id": product, "warehouse": "上海仓", "quantity": 1, "safety_stock": 1}})
    assert duplicate.status_code == 422


def test_ai_generate_preview_commit_and_delete_batch(setup):
    client, _ = setup
    missing = client.post("/data/orders/generate", headers=headers("admin"), json={"count": 3})
    assert missing.status_code == 422
    assert "请先" in missing.json()["detail"]
    preview = client.post("/data/products/generate", headers=headers("admin"), json={"count": 5, "prompt": "数码"})
    assert preview.status_code == 200
    body = preview.json()
    assert body["generator"] == "template"
    assert len(body["rows"]) == 5
    rows = []
    for row in body["rows"]:
        assert row["errors"] == {}
        assert row["values"]["category"] == "数码"
        rows.append(row["values"])
    committed = client.post("/data/products/batches", headers=headers("admin"), json={"rows": rows}).json()
    assert len(committed["created"]) == 5 and committed["failed"] == []
    page = client.get("/data/products/records?source=ai", headers=headers("admin")).json()
    assert page["total"] == 5
    # 依赖的数据有了之后，可以继续生成订单、物流单等关联数据。
    create(client, "customers", {"name": "李四", "phone": "13900000000", "registered_at": "2026-02-03"})
    for data_type in ("orders", "inventory", "reviews", "promotions"):
        generated = client.post(f"/data/{data_type}/generate", headers=headers("admin"), json={"count": 3}).json()
        valid = []
        for row in generated["rows"]:
            assert row["errors"] == {}, (data_type, row)
            valid.append(row["values"])
        assert client.post(f"/data/{data_type}/batches", headers=headers("admin"), json={"rows": valid}).json()["failed"] == []
    for data_type in ("shipments", "after_sales"):
        generated = client.post(f"/data/{data_type}/generate", headers=headers("admin"), json={"count": 3}).json()
        for row in generated["rows"]:
            assert row["errors"] == {}, (data_type, row)
    deleted = client.delete(f"/data/products/batches/{committed['batch_id']}", headers=headers("admin")).json()
    assert deleted["deleted"] == 5


def test_permission_admin_only(setup):
    client, _ = setup
    assert client.get("/admin/data-permissions", headers=headers()).status_code == 403
    assert client.put("/admin/data-permissions", headers=headers("admin"),
        json={"group_id": "nope", "data_type": "orders", "read": True}).status_code == 404


# 发一个问题，返回回答结果。
def ask(client, text, owner="admin"):
    session_id = session(client, owner)
    response = client.post("/chat", headers=headers(owner), json=question(session_id, text))
    assert response.status_code == 200, response.text
    return response.json()


def test_rule_detects_data_queries():
    from app.tools.data_query import looks_like_data_query
    assert looks_like_data_query("哪些商品快缺货了")
    assert looks_like_data_query("这周有几单待发货的订单")
    assert looks_like_data_query("A1001 的快递到哪了")
    assert looks_like_data_query("现在有什么活动")
    assert not looks_like_data_query("退货政策是什么")
    assert not looks_like_data_query("售后服务的规定有哪些")
    # 单个订单的状态仍交给原来的订单工具。
    assert not looks_like_data_query("查询订单 A1001")
    assert not looks_like_data_query("我的订单现在到哪里了")


def test_chat_data_query_follows_permissions(setup):
    client, _ = setup
    product, customer, order = seed(client)
    create(client, "inventory", {"product_id": product, "warehouse": "上海仓", "quantity": 5, "safety_stock": 20})
    denied = ask(client, "哪些商品快缺货了", owner="alice")
    assert denied["route"] == "data"
    assert "没有查看库存" in denied["answer"]
    assert "蓝牙耳机" not in denied["answer"]

    answer = ask(client, "哪些商品快缺货了")
    assert answer["route"] == "data"
    assert "蓝牙耳机" in answer["answer"] and "上海仓" in answer["answer"]
    tool = next(step for step in answer["steps"] if step["id"] == "tool")
    assert tool["result"]["plan"]["filters"] == [{"field": "quantity", "op": "field_lt", "value": "safety_stock"}]

    count = ask(client, "待发货的订单有几单")
    assert count["route"] == "data"
    assert "共有 1 条订单记录" in count["answer"]
    total = ask(client, "订单总金额是多少")
    assert "399.0" in total["answer"]

    # 聊天回答里的手机号始终脱敏，即使提问的是管理员。
    vip = ask(client, "VIP 客户有多少个")
    assert "共有 1 条客户记录" in vip["answer"]
    assert "13812345678" not in vip["answer"] and "138****5678" in vip["answer"]

    create(client, "shipments", {"order_id": order, "carrier": "顺丰", "tracking_no": "SF123",
        "shipped_at": "2026-09-28"})
    shipment = ask(client, f"{order} 的快递到哪了")
    assert shipment["route"] == "data"
    assert "SF123" in shipment["answer"]


def test_order_tool_uses_data_permission(setup):
    client, _ = setup
    # bob 没有订单权限，只能查自己的订单；加入有订单查看权限的部门后可以查任意订单。
    assert "没有找到" in ask(client, "订单 A1001", owner="bob")["answer"]
    grant(client, "bob", "service", "orders", read=True)
    assert "已发货" in ask(client, "订单 A1001", owner="bob")["answer"]
    assert ask(client, "退货政策是什么", owner="bob")["route"] == "knowledge"


# 模型给出的查询计划必须逐项校验：越权的数据类型、不存在的字段、敏感字段和不支持的操作符都要拒绝。
def test_check_plan_rejects_unsafe_plans():
    import pytest
    from app.data.service import DataError
    from app.tools.data_query import DataQueryTool
    tool = DataQueryTool()
    permissions = {"customers": {"read"}, "orders": set()}
    readable = ["customers"]
    plan = tool.check_plan({"data_type": "customers", "filters": [{"field": "level", "op": "eq", "value": "VIP"}],
        "aggregate": {"op": "count"}, "limit": 999}, readable, permissions)
    assert plan["limit"] == 20 and plan["aggregate"] == {"op": "count", "field": None}
    bad_plans = [
        {"data_type": "orders"},
        {"data_type": "customers", "filters": [{"field": "password", "op": "eq", "value": "x"}]},
        {"data_type": "customers", "filters": [{"field": "phone", "op": "contains", "value": "138"}]},
        {"data_type": "customers", "filters": [{"field": "level", "op": "drop", "value": "x"}]},
        {"data_type": "customers", "filters": [{"field": "level", "op": "eq", "value": "钻石"}]},
        {"data_type": "customers", "aggregate": {"op": "sum", "field": "name"}},
    ]
    for bad in bad_plans:
        with pytest.raises(DataError):
            tool.check_plan(bad, readable, permissions)

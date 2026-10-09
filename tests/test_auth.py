from datetime import datetime, timedelta, timezone

import jwt

from app.auth import create_user, seed_users
from test_app import JWT_SECRET, headers, publish, question, session, setup  # noqa: F401  复用 API 测试的内存存储夹具


# 登录并返回令牌。
def login(client, username, password):
    return client.post("/auth/login", json={"username": username, "password": password})


# 以 alice 身份导入一份文档，返回文档 id。
# 普通用户选「所有人」时先按仅自己保存并提交公开申请；这里的测试关注权限过滤，直接用管理员通过申请。
def ingest(client, content, owner="alice", **permission):
    response = client.post("/documents", headers=headers(owner), json={"title": "售后", "content": content, **permission})
    assert response.status_code == 200, response.text
    document_id = response.json()["document_id"]
    if response.json().get("review_pending") == "publish":
        publish(client, document_id, owner)
    return document_id


# 返回某个用户在知识库列表里看到的文档 id。
def visible_ids(client, owner):
    ids = []
    for item in client.get("/documents", headers=headers(owner)).json()["documents"]:
        ids.append(item["document_id"])
    return ids


# 用户名密码登录拿到令牌，访问令牌可以调用接口；密码错误统一提示。
def test_login_and_me(setup):
    client, _ = setup
    response = login(client, "alice", "alice-password")
    assert response.status_code == 200
    tokens = response.json()
    assert tokens["user"]["username"] == "alice"
    me = client.get("/auth/me", headers={"Authorization": "Bearer " + tokens["access_token"]})
    assert me.json()["username"] == "alice" and me.json()["is_admin"] is False
    assert login(client, "alice", "wrong").json()["detail"] == "用户名或密码错误"
    assert login(client, "nobody", "wrong").json()["detail"] == "用户名或密码错误"
    assert client.get("/auth/me").status_code == 401


# 同一用户名连续失败 5 次后暂时拒绝登录，正确密码也不行。
def test_login_rate_limit(setup):
    client, _ = setup
    for _ in range(5):
        assert login(client, "bob", "wrong").status_code == 401
    assert login(client, "bob", "bob-password").status_code == 429


# 伪造或过期的令牌都被拒绝：别的密钥签名、alg=none、过期、把别的用途的令牌当访问令牌。
def test_invalid_access_tokens_rejected(setup):
    client, _ = setup
    now = datetime.now(timezone.utc)
    tokens = [
        jwt.encode({"sub": "alice", "typ": "access", "exp": now + timedelta(minutes=5)}, "other-secret-" + "y" * 32),
        jwt.encode({"sub": "alice", "typ": "access", "exp": now + timedelta(minutes=5)}, None, algorithm="none"),
        jwt.encode({"sub": "alice", "typ": "access", "exp": now - timedelta(minutes=1)}, JWT_SECRET),
        jwt.encode({"sub": "alice", "typ": "refresh", "exp": now + timedelta(minutes=5)}, JWT_SECRET),
    ]
    for token in tokens:
        assert client.get("/auth/me", headers={"Authorization": "Bearer " + token}).status_code == 401


# 刷新令牌每次使用后作废并换新；旧令牌被再次使用时，这个用户的全部刷新令牌都作废。
def test_refresh_rotation_and_reuse_detection(setup):
    client, _ = setup
    first = login(client, "alice", "alice-password").json()
    second = client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert second.status_code == 200
    assert second.json()["refresh_token"] != first["refresh_token"]
    reused = client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert reused.status_code == 401
    # 旧令牌被重复使用后，刚换到的新令牌也一起作废。
    assert client.post("/auth/refresh", json={"refresh_token": second.json()["refresh_token"]}).status_code == 401


# 退出登录后刷新令牌不能再用。
def test_logout_revokes_refresh_token(setup):
    client, _ = setup
    tokens = login(client, "alice", "alice-password").json()
    assert client.post("/auth/logout", json={"refresh_token": tokens["refresh_token"]}).status_code == 200
    assert client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).status_code == 401


# 管理员停用用户后，他手里还没过期的访问令牌立即失效，刷新令牌也作废。
def test_disabled_user_loses_access(setup):
    client, _ = setup
    tokens = login(client, "bob", "bob-password").json()
    bob = {"Authorization": "Bearer " + tokens["access_token"]}
    assert client.get("/auth/me", headers=bob).status_code == 200
    assert client.patch("/admin/users/bob", json={"disabled": True}, headers=headers("admin")).status_code == 200
    assert client.get("/auth/me", headers=bob).status_code == 401
    assert client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).status_code == 401
    assert login(client, "bob", "bob-password").status_code == 401


# 用户和部门管理只允许管理员；保留用户名和停用自己被拒绝。
def test_admin_manages_users_and_groups(setup):
    client, _ = setup
    assert client.get("/admin/users", headers=headers()).status_code == 403
    assert client.post("/admin/groups", json={"id": "sales", "name": "销售部"}, headers=headers()).status_code == 403
    assert client.post("/admin/groups", json={"id": "sales", "name": "销售部"}, headers=headers("admin")).status_code == 201
    assert client.post("/admin/groups", json={"id": "sales", "name": "重复"}, headers=headers("admin")).status_code == 409
    created = client.post("/admin/users", json={"username": "carol", "password": "carol-password",
        "groups": ["sales"]}, headers=headers("admin"))
    assert created.status_code == 201 and created.json()["groups"] == ["sales"]
    assert login(client, "carol", "carol-password").status_code == 200
    reserved = client.post("/admin/users", json={"username": "eval", "password": "eval-password"}, headers=headers("admin"))
    assert reserved.status_code == 422
    unknown_group = client.post("/admin/users", json={"username": "dave", "password": "dave-password",
        "groups": ["nope"]}, headers=headers("admin"))
    assert unknown_group.status_code == 422
    assert client.patch("/admin/users/admin", json={"disabled": True}, headers=headers("admin")).status_code == 422
    names = []
    for user in client.get("/admin/users", headers=headers("admin")).json()["users"]:
        names.append(user["username"])
    assert names == ["admin", "alice", "bob", "carol"]


# 管理员可以修改部门名称并删除部门；删除接口由后端负责清理关联关系。
def test_admin_edits_and_deletes_groups(setup):
    client, _ = setup
    created = client.post("/admin/groups", json={"name": "销售部"}, headers=headers("admin"))
    assert created.status_code == 201
    group_id = created.json()["id"]
    assert group_id == "dept_001"
    assert client.patch("/admin/groups/sales", json={"name": "华东销售部"}, headers=headers()).status_code == 403
    updated = client.patch(f"/admin/groups/{group_id}", json={"name": "华东销售部"}, headers=headers("admin"))
    assert updated.status_code == 200 and updated.json() == {"id": group_id, "name": "华东销售部"}
    assert {item["name"] for item in client.get("/groups", headers=headers()).json()["groups"]} == {"华东销售部"}
    assert client.delete(f"/admin/groups/{group_id}", headers=headers()).status_code == 403
    deleted = client.delete(f"/admin/groups/{group_id}", headers=headers("admin"))
    assert deleted.status_code == 200 and deleted.json() == {"id": group_id}
    assert client.patch(f"/admin/groups/{group_id}", json={"name": "不存在"}, headers=headers("admin")).status_code == 404


# 初始用户按环境变量创建，已存在时不覆盖密码。
def test_seed_users_from_env(setup, monkeypatch):
    _, store = setup
    monkeypatch.setenv("ADMIN_PASSWORD", "changed-password")
    monkeypatch.setenv("ALICE_PASSWORD", "changed-password")
    seed_users(store.engine)
    client = setup[0]
    assert login(client, "alice", "alice-password").status_code == 200


# 默认私有：别人在列表、详情、分块和检索里都看不到。
def test_private_document_invisible_to_others(setup):
    client, store = setup
    document_id = ingest(client, "退货政策：ALICE-PRIVATE 退货期限 7 天。")
    assert document_id in visible_ids(client, "alice")
    assert document_id not in visible_ids(client, "bob")
    assert client.get(f"/documents/{document_id}", headers=headers("bob")).status_code == 404
    assert client.get(f"/documents/{document_id}/chunks", headers=headers("bob")).status_code == 404
    assert store.current_versions("bob") == {}
    answer = client.post("/chat", headers=headers("bob"), json=question(session(client, "bob"), "退货政策"))
    assert "ALICE-PRIVATE" not in answer.text


# 公开文档所有登录用户都能读、能检索，但只有上传者能删除和修改权限。
def test_public_document_readable_but_not_editable(setup):
    client, store = setup
    document_id = ingest(client, "退货政策：公开制度，退货期限 15 天。", visibility="public")
    assert document_id in visible_ids(client, "bob")
    detail = client.get(f"/documents/{document_id}", headers=headers("bob")).json()
    assert detail["visibility"] == "public" and detail["can_edit"] is False and detail["owner"] == "alice"
    assert client.get(f"/documents/{document_id}/chunks", headers=headers("bob")).status_code == 200
    answer = client.post("/chat", headers=headers("bob"), json=question(session(client, "bob"), "退货政策"))
    assert "15 天" in answer.json()["answer"]
    assert client.delete(f"/documents/{document_id}", headers=headers("bob")).status_code == 403
    change = client.put(f"/documents/{document_id}/permission", json={"visibility": "private"}, headers=headers("bob"))
    assert change.status_code == 403
    # 上传者改回私有后，别人下一次请求就看不到了。
    assert client.put(f"/documents/{document_id}/permission", json={"visibility": "private"},
        headers=headers()).status_code == 200
    assert document_id not in visible_ids(client, "bob")
    assert store.current_versions("bob") == {}


# 共享给部门：部门成员能看到，其他人看不到；部门变动立即生效。
def test_shared_document_follows_group_membership(setup):
    client, _ = setup
    client.post("/admin/groups", json={"id": "sales", "name": "销售部"}, headers=headers("admin"))
    create_user(setup[1].engine, "carol", "carol-password")
    assert client.post("/documents", headers=headers(), json={"title": "售后", "content": "内部价格",
        "visibility": "shared", "groups": []}).status_code == 422
    assert client.post("/documents", headers=headers(), json={"title": "售后", "content": "内部价格",
        "visibility": "shared", "groups": ["nope"]}).status_code == 422
    document_id = ingest(client, "销售内部：折扣上限 8 折。", visibility="shared", groups=["sales"])
    assert document_id not in visible_ids(client, "bob")
    client.patch("/admin/users/bob", json={"groups": ["sales"]}, headers=headers("admin"))
    assert document_id in visible_ids(client, "bob")
    assert document_id not in visible_ids(client, "carol")
    detail = client.get(f"/documents/{document_id}", headers=headers("bob")).json()
    assert detail["groups"] == ["sales"]
    client.patch("/admin/users/bob", json={"groups": []}, headers=headers("admin"))
    assert document_id not in visible_ids(client, "bob")


# 检索的权限范围标明每份文档是自己上传、共享给我（经由哪个部门）还是公开，检索诊断里按来源计数。
def test_readable_scope_marks_document_source(setup):
    client, store = setup
    client.post("/admin/groups", json={"id": "sales", "name": "销售部"}, headers=headers("admin"))
    shared_id = ingest(client, "销售内部：折扣上限 8 折。", visibility="shared", groups=["sales"])
    public_id = ingest(client, "退货政策：公开制度。", visibility="public")
    client.patch("/admin/users/bob", json={"groups": ["sales"]}, headers=headers("admin"))
    own_id = ingest(client, "BOB 自己的笔记。", owner="bob")
    scope = store.readable_scope("bob")
    sources = {item["document_id"]: item for item in scope["documents"]}
    assert sources[shared_id]["source"] == "shared" and sources[shared_id]["groups"] == ["销售部"]
    assert sources[public_id]["source"] == "public"
    assert sources[own_id]["source"] == "own"
    assert set(scope["versions"]) == set(sources)
    from app.tools.search import DocumentSearchTool
    summary = DocumentSearchTool.scope_summary(scope["documents"])
    assert (summary["shared"], summary["public"], summary["groups"]) == (1, 1, ["销售部"])


# 评测用户 eval 不是注册用户，看不到别人公开的文档，评测检索不受其他用户的数据影响。
def test_eval_owner_ignores_public_documents(setup):
    client, store = setup
    ingest(client, "退货政策：公开制度。", visibility="public")
    assert store.current_versions("eval") == {}


# 上传文件时也可以设置可见范围；替换为新版本时沿用原来的设置。
def test_upload_form_sets_permission(setup, tmp_path, monkeypatch):
    client, _ = setup
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    response = client.post("/documents/upload", headers=headers(), data={"visibility": "public"},
        files={"file": ("a.txt", "退货期限 7 天。".encode(), "text/plain")})
    assert response.status_code == 202
    document_id = response.json()["document_id"]
    # 普通用户选「所有人」：先按仅自己保存，公开申请等管理员审核。
    assert response.json()["review_pending"] == "publish"
    detail = client.get(f"/documents/{document_id}", headers=headers()).json()
    assert detail["visibility"] == "private" and detail["publish_review"]["status"] == "pending"
    # 管理员上传的直接公开。
    response = client.post("/documents/upload", headers=headers("admin"), data={"visibility": "public"},
        files={"file": ("b.txt", "换货期限 15 天。".encode(), "text/plain")})
    assert response.json()["review_pending"] is None
    detail = client.get(f"/documents/{response.json()['document_id']}", headers=headers("admin")).json()
    assert detail["visibility"] == "public" and detail["publish_review"] is None

from test_app import setup, headers  # noqa: F401


def test_template_crud_permissions_and_independent_copy(setup):
    client, _ = setup
    body = {
        "name": "图检索对比",
        "config": {
            "version": 2,
            "kind": "retrieval",
            "mode": "fixed",
            "methods": ["dense", "graph"],
            "split": "all",
            "suite_ids": ["suite-a"],
            "corpus_ids": ["doc-a", "doc-b"],
            "params": {"settings": {"source_token_budget": 6000}},
        },
    }
    assert (
        client.post(
            "/eval/config-templates", headers=headers("alice"), json=body
        ).status_code
        == 403
    )
    created = client.post("/eval/config-templates", headers=headers("admin"), json=body)
    assert created.status_code == 201, created.text
    template_id = created.json()["id"]
    listed = client.get("/eval/config-templates", headers=headers("admin")).json()[
        "items"
    ]
    assert len(listed) == 1 and listed[0]["config"]["corpus_ids"] == ["doc-a", "doc-b"]
    assert listed[0]["config"]["params"]["settings"] == {"source_token_budget": 6000}
    copied = client.post(
        "/eval/config-templates",
        headers=headers("admin"),
        json={**body, "name": "副本"},
    ).json()["id"]
    body["name"] = "修改后"
    body["config"]["methods"] = ["keyword"]
    assert (
        client.put(
            f"/eval/config-templates/{template_id}", headers=headers("admin"), json=body
        ).status_code
        == 200
    )
    listed = {
        item["id"]: item
        for item in client.get(
            "/eval/config-templates", headers=headers("admin")
        ).json()["items"]
    }
    assert listed[template_id]["name"] == "修改后"
    assert listed[copied]["config"]["methods"] == ["dense", "graph"]
    assert (
        client.delete(
            f"/eval/config-templates/{template_id}", headers=headers("admin")
        ).status_code
        == 200
    )
    assert (
        client.put(
            f"/eval/config-templates/{template_id}", headers=headers("admin"), json=body
        ).status_code
        == 404
    )


def test_template_rejects_invalid_configuration(setup):
    client, _ = setup
    for body in [
        {"name": " ", "config": {}},
        {"name": "x", "config": {"methods": ["unknown"]}},
        {"name": "x", "config": {"params": {"secret": "key"}}},
        {"name": "x", "config": {"kind": "generation", "mode": "agent"}},
    ]:
        assert (
            client.post(
                "/eval/config-templates", headers=headers("admin"), json=body
            ).status_code
            == 422
        )

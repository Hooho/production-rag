from sqlalchemy import select

from ..auth import load_user
from ..data.service import user_permissions
from ..mysql.store import orders


class OrderTool:
    """查询当前用户有权限访问的单个订单，不接受任意 SQL。"""

    # 根据订单号和当前用户返回订单结果。
    # 原来只能查 owner 是自己的订单；接入数据管理后，有订单查看权限的部门（客服、仓储等）也能查任意订单。
    # 权限在这里再查一次：订单号会被规则直接路由到这个工具，不经过数据查询工具的权限检查。
    # 已软删除的订单视为不存在。
    def execute(self, store, owner, order_id):
        if not order_id:
            return {"answer": "请提供订单编号，例如 A1001。", "order_id": None}
        user = load_user(store.engine, owner)
        can_read_all = user is not None and "read" in user_permissions(store.engine, user)["orders"]
        conditions = [orders.c.id == order_id, orders.c.deleted_at.is_(None)]
        if not can_read_all:
            conditions.append(orders.c.owner == owner)
        with store.engine.connect() as connection:
            order = connection.execute(select(orders).where(*conditions)).mappings().first()
        if not order:
            return {"answer": "没有找到属于你的该订单。", "order_id": order_id}
        return {"answer": f"订单 {order_id}：{order['status']}；预计 {order['arrival']}。",
            "order_id": order_id}

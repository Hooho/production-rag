# 用户认证：密码哈希、JWT 访问令牌和可撤销的刷新令牌。
# 登录后发两种令牌：
# - 访问令牌（JWT）：每个请求都带着它，服务端只验证签名和过期时间，不用保存；有效期短（30 分钟），泄露后影响有限。
# - 刷新令牌：随机字符串，只用来换新的访问令牌；有效期长（7 天），所以保存在服务端，退出、改密码、停用时可以立即作废。
import hashlib
import hmac
import os
import re
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from sqlalchemy import delete, select

from .mysql.store import refresh_tokens, user_group_members, user_groups, users


ACCESS_MINUTES = 30
REFRESH_DAYS = 7
# 用户名同时是各业务表里的 owner，只允许小写字母、数字、下划线和短横线，也能安全地拼进 Milvus 过滤条件。
USERNAME_PATTERN = re.compile(r"^[a-z0-9_-]{3,32}$")
GROUP_PATTERN = re.compile(r"^[a-z0-9_-]{1,32}$")
# eval 是评测语料的 owner，不能被注册成真实用户，否则这个用户会看到评测语料。
RESERVED_USERNAMES = {"eval"}
MIN_PASSWORD_LENGTH = 8
# scrypt 参数：n=2^14 时一次计算约几十毫秒，正常登录无感，暴力猜密码的成本却大幅提高。
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1


# 当前 UTC 时间的 ISO 字符串，与其他表的时间字段格式一致。
def now_text():
    return datetime.now(timezone.utc).isoformat()


# 用 scrypt 计算密码哈希，结果带上参数和随机盐，格式为 scrypt$n$r$p$盐$哈希。
# 不用 sha256：它算得太快，数据库泄露后可以每秒尝试上亿个密码；scrypt 故意算得慢且耗内存。
def hash_password(password):
    salt = os.urandom(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${key.hex()}"


# 校验密码；用 compare_digest 比较，避免按比较耗时逐位猜出哈希。
def verify_password(password, stored):
    try:
        _, n, r, p, salt, expected = stored.split("$")
        key = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    except ValueError:
        return False
    return hmac.compare_digest(key.hex(), expected)


# 用户不存在时也算一次哈希，让"用户不存在"和"密码错误"的耗时相同，不能靠响应时间探测用户名。
DUMMY_HASH = hash_password(secrets.token_hex(16))


# 签发访问令牌。sub 是用户名；typ 区分令牌用途，防止把别的用途的令牌当访问令牌用。
def create_access_token(username, secret):
    issued = datetime.now(timezone.utc)
    payload = {"sub": username, "typ": "access", "iat": issued, "exp": issued + timedelta(minutes=ACCESS_MINUTES)}
    return jwt.encode(payload, secret, algorithm="HS256")


# 验证访问令牌并返回用户名；签名不对、过期、用途不对都抛出 ValueError。
# algorithms 必须写死：否则攻击者可以把令牌头改成 alg=none 绕过签名。
def decode_access_token(token, secret):
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"], options={"require": ["sub", "exp", "typ"]})
    except jwt.PyJWTError as error:
        raise ValueError(str(error))
    if payload["typ"] != "access":
        raise ValueError("令牌用途不对")
    return payload["sub"]


# 刷新令牌只保存 sha256：数据库被读到也拿不到可以直接使用的令牌。
def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


# 签发一对新令牌，刷新令牌写入数据库。
def issue_tokens(engine, username, secret):
    refresh = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=REFRESH_DAYS)
    with engine.begin() as connection:
        connection.execute(refresh_tokens.insert().values(token_hash=token_hash(refresh), username=username,
            expires=expires.isoformat(), revoked=False, created=now_text()))
    return {"access_token": create_access_token(username, secret), "refresh_token": refresh,
        "token_type": "bearer", "expires_in": ACCESS_MINUTES * 60}


# 用刷新令牌换一对新令牌，旧的刷新令牌同时作废（轮换）。
# 已经作废的刷新令牌又被使用，说明它可能被偷了：攻击者和用户中有一方在用旧令牌。
# 这时作废这个用户的全部刷新令牌，双方都要重新登录，攻击者手里的令牌也就没用了。
def rotate_refresh_token(engine, refresh, secret):
    with engine.begin() as connection:
        row = connection.execute(select(refresh_tokens).where(
            refresh_tokens.c.token_hash == token_hash(refresh))).mappings().first()
        if row is None:
            raise ValueError("刷新令牌无效")
        if row["revoked"]:
            revoke_user_tokens(connection, row["username"])
    # 在事务提交之后再报错：在 with engine.begin() 里抛出异常会让事务回滚，上面的全部作废就白做了。
    if row["revoked"]:
        raise ValueError("刷新令牌已失效，请重新登录")
    with engine.begin() as connection:
        if datetime.fromisoformat(row["expires"]) < datetime.now(timezone.utc):
            raise ValueError("登录已过期，请重新登录")
        user = connection.execute(select(users).where(users.c.username == row["username"])).mappings().first()
        if user is None or user["disabled"]:
            raise ValueError("用户已停用")
        # 条件更新：两个请求同时拿同一个令牌来刷新时，只有一个能把它从"未作废"改成"作废"，另一个失败。
        result = connection.execute(refresh_tokens.update().where(
            refresh_tokens.c.token_hash == row["token_hash"], refresh_tokens.c.revoked.is_(False)).values(revoked=True))
        if result.rowcount != 1:
            raise ValueError("刷新令牌已失效，请重新登录")
    return row["username"], issue_tokens(engine, row["username"], secret)


# 退出登录：作废这个刷新令牌。访问令牌无法作废，最多 30 分钟后自然过期。
def revoke_refresh_token(engine, refresh):
    with engine.begin() as connection:
        connection.execute(refresh_tokens.update().where(
            refresh_tokens.c.token_hash == token_hash(refresh)).values(revoked=True))


# 作废一个用户的全部刷新令牌，用于改密码和停用。
def revoke_user_tokens(connection, username):
    connection.execute(refresh_tokens.update().where(refresh_tokens.c.username == username).values(revoked=True))


# 核对用户名和密码，成功返回用户信息，失败返回 None（不区分是用户不存在还是密码错误）。
def authenticate(engine, username, password):
    with engine.connect() as connection:
        row = connection.execute(select(users).where(users.c.username == username)).mappings().first()
    if row is None:
        verify_password(password, DUMMY_HASH)
        return None
    if not verify_password(password, row["password_hash"]) or row["disabled"]:
        return None
    return row


# 读取用户及其所属部门；用户不存在返回 None。每个请求都查一次，停用和部门变更立即生效。
def load_user(engine, username):
    with engine.connect() as connection:
        row = connection.execute(select(users).where(users.c.username == username)).mappings().first()
        if row is None:
            return None
        groups = connection.execute(select(user_group_members.c.group_id).where(
            user_group_members.c.username == username).order_by(user_group_members.c.group_id)).scalars().all()
    return {"username": row["username"], "is_admin": bool(row["is_admin"]), "disabled": bool(row["disabled"]),
        "groups": list(groups), "created": row["created"]}


# 校验部门都存在，返回去重后的列表；有不存在的部门时抛出 ValueError。
def check_groups(connection, group_ids):
    result = []
    for group_id in group_ids:
        if group_id in result:
            continue
        exists = connection.execute(select(user_groups.c.id).where(user_groups.c.id == group_id)).first()
        if exists is None:
            raise ValueError(f"部门不存在：{group_id}")
        result.append(group_id)
    return result


# 覆盖写入用户所属部门。
def set_user_groups(connection, username, group_ids):
    connection.execute(delete(user_group_members).where(user_group_members.c.username == username))
    for group_id in check_groups(connection, group_ids):
        connection.execute(user_group_members.insert().values(username=username, group_id=group_id))


# 创建用户；用户名不合法、被保留或已存在、密码太短时抛出 ValueError。
def create_user(engine, username, password, is_admin=False, groups=()):
    if not USERNAME_PATTERN.match(username) or username in RESERVED_USERNAMES:
        raise ValueError("用户名只能包含 3～32 位小写字母、数字、下划线和短横线，且不能是保留名")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"密码至少 {MIN_PASSWORD_LENGTH} 位")
    with engine.begin() as connection:
        if connection.execute(select(users.c.username).where(users.c.username == username)).first():
            raise ValueError("用户名已存在")
        connection.execute(users.insert().values(username=username, password_hash=hash_password(password),
            is_admin=is_admin, disabled=False, created=now_text()))
        set_user_groups(connection, username, groups)


# 按环境变量创建初始用户：ADMIN_PASSWORD 创建管理员 admin；ALICE_PASSWORD、BOB_PASSWORD 创建演示用户
# （原来的 API Key 用户就是 alice 和 bob，沿用同名账号，已有的会话和文档仍属于他们）。
# 用户已存在时不做任何修改，改密码走管理接口，避免每次重启都用 .env 覆盖用户自己改过的密码。
def seed_users(engine):
    for username, variable, is_admin in (("admin", "ADMIN_PASSWORD", True), ("alice", "ALICE_PASSWORD", False),
            ("bob", "BOB_PASSWORD", False)):
        password = os.getenv(variable, "")
        if not password:
            continue
        with engine.connect() as connection:
            exists = connection.execute(select(users.c.username).where(users.c.username == username)).first()
        if not exists:
            create_user(engine, username, password, is_admin=is_admin)

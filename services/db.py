"""SQLite 持久化：连接管理、建表、轻量迁移。

设计原则：
- 单文件数据库，零外部依赖，适合小团队/单机部署；
- 每请求一个连接（flask.g），WAL 模式，外键开启；
- 表结构用 IF NOT EXISTS，启动时自动建表，后续加列走 MIGRATIONS。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    device_id     TEXT UNIQUE,
    wechat_openid TEXT UNIQUE,
    unionid       TEXT,
    cloud_uid     TEXT,
    cloud_email   TEXT,
    nickname      TEXT NOT NULL DEFAULT '',
    avatar        TEXT NOT NULL DEFAULT '',
    city          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    last_seen     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS oauth_states (
    state      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    next_path  TEXT NOT NULL DEFAULT '/'
);

CREATE TABLE IF NOT EXISTS buddies (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#FFE3C7',
    area         TEXT NOT NULL DEFAULT '',
    lat          REAL,
    lng          REAL,
    cuisines     TEXT NOT NULL DEFAULT '[]',
    budget       INTEGER,
    last_met     TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    source       TEXT NOT NULL DEFAULT 'manual',
    created_at   TEXT NOT NULL,
    UNIQUE(owner_id, name)
);
CREATE INDEX IF NOT EXISTS idx_buddies_owner ON buddies(owner_id);

CREATE TABLE IF NOT EXISTS invites (
    token        TEXT PRIMARY KEY,
    inviter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_name TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    accepted_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_inviter ON invites(inviter_id);

CREATE TABLE IF NOT EXISTS deals (
    id                   TEXT PRIMARY KEY,
    store_id             TEXT,
    store_name           TEXT NOT NULL,
    platform             TEXT NOT NULL,
    title                TEXT NOT NULL,
    items                TEXT NOT NULL DEFAULT '[]',
    price_cents          INTEGER NOT NULL,
    original_price_cents INTEGER,
    sold                 INTEGER NOT NULL DEFAULT 0,
    valid_until          TEXT,
    url                  TEXT NOT NULL,
    source               TEXT NOT NULL DEFAULT 'merchant',
    updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deals_store ON deals(store_id, store_name);

CREATE TABLE IF NOT EXISTS dice_records (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    buddy_id   TEXT NOT NULL,
    my_roll    INTEGER NOT NULL,
    buddy_roll INTEGER NOT NULL,
    diff       INTEGER NOT NULL,
    payer      TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dice_user ON dice_records(user_id, created_at);
"""


def connect(path: str) -> sqlite3.Connection:
    """每请求一个连接。

    journal_mode 是持久化属性，只在 init_db 里设置一次：
    每个连接都执行 `PRAGMA journal_mode = WAL` 会在并发打开时抢排他锁，
    Windows 上表现为偶发 `attempt to write a readonly database`。
    """
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 8000")
    return conn


def init_db(app) -> None:
    path = app.config["DATABASE_PATH"]
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.executescript(SCHEMA)
        _ensure_columns(conn)
        conn.commit()
    finally:
        conn.close()


def _ensure_columns(conn: sqlite3.Connection) -> None:
    """轻量迁移：老库补上后加的列（SQLite 没有 IF NOT EXISTS 的 ADD COLUMN）。"""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    additions = (
        ("cloud_uid", "ALTER TABLE users ADD COLUMN cloud_uid TEXT"),
        ("cloud_email", "ALTER TABLE users ADD COLUMN cloud_email TEXT"),
    )
    for name, ddl in additions:
        if name not in existing:
            conn.execute(ddl)
    # cloud_uid 唯一（NULL 允许重复，未登录用户不受影响）
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cloud ON users(cloud_uid)")


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect(current_app.config["DATABASE_PATH"])
    return g.db


def close_db(_error=None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_app(app) -> None:
    init_db(app)
    # 常驻连接：避免最后一个请求关闭时删除 -wal/-shm，
    # 与并发打开的新连接在 Windows 上竞争，出现 SQLITE_READONLY
    keeper = connect(app.config["DATABASE_PATH"])
    keeper.execute("SELECT 1").fetchone()
    app.extensions["db_keeper"] = keeper
    app.teardown_appcontext(close_db)

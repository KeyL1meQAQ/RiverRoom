import copy
import os
from pathlib import Path

from sqlalchemy import JSON, Column, Integer, MetaData, String, Table, create_engine, delete, select, update


class Store:
    def __init__(self, url: str | None = None):
        Path('data').mkdir(exist_ok=True)
        url = url or os.getenv('DATABASE_URL', 'sqlite:///data/poker.db')
        self.engine = create_engine(url, pool_pre_ping=True)
        meta = MetaData()
        self.rooms = Table('rooms', meta, Column('id', String, primary_key=True),
                           Column('version', Integer, nullable=False), Column('state', JSON, nullable=False))
        meta.create_all(self.engine)

    def all(self):
        with self.engine.connect() as conn:
            return [row.state for row in conn.execute(select(self.rooms.c.state))]

    def save(self, room: dict, expected: int | None = None):
        with self.engine.begin() as conn:
            if expected is None:
                conn.execute(self.rooms.insert().values(id=room['id'], version=room['version'], state=copy.deepcopy(room)))
            else:
                result = conn.execute(update(self.rooms).where(self.rooms.c.id == room['id'],
                    self.rooms.c.version == expected).values(version=room['version'], state=copy.deepcopy(room)))
                if result.rowcount != 1:
                    raise RuntimeError('Room version conflict')

    def remove(self, room_id):
        with self.engine.begin() as conn:
            conn.execute(delete(self.rooms).where(self.rooms.c.id == room_id))

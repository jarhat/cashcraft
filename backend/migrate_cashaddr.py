"""Offline migration of the legacy NetCraft reward and statistics tables."""

import argparse
import sqlite3
from contextlib import closing
from pathlib import Path


TABLES = (
    "mining_rewards",
    "mina_mining_progress",
    "guest_mining_progress",
    "guest_mining_rewards",
    "mining_totals",
    "ore_scores",
)


def migrate(world: Path, cashaddr: Path) -> dict[str, int]:
    world = world.resolve(strict=True)
    cashaddr = cashaddr.resolve()
    if world == cashaddr or (cashaddr.exists() and world.samefile(cashaddr)):
        raise ValueError("NetCraft world and CashAddr databases must be different files.")

    with closing(sqlite3.connect(world.as_uri() + "?mode=rw", uri=True)) as db, db:
        source = {
            name: sql
            for name, sql in db.execute("SELECT name, sql FROM main.sqlite_schema WHERE type='table'")
            if name in TABLES
        }
        if not source:
            return {}
        cashaddr.parent.mkdir(parents=True, exist_ok=True)
        if not cashaddr.exists():
            cashaddr.touch(mode=0o600, exist_ok=False)
        db.execute("ATTACH DATABASE ? AS cashaddr", (cashaddr.as_uri() + "?mode=rw",))
        for schema in ("main", "cashaddr"):
            if db.execute(f"PRAGMA {schema}.journal_mode=DELETE").fetchone()[0] != "delete":
                raise ValueError(f"Could not enable rollback journaling for {schema}.")
            db.execute(f"PRAGMA {schema}.synchronous=FULL")
        # One rollback-journal transaction covers inserts and source table removal.
        db.execute("BEGIN EXCLUSIVE")
        destination = {
            name
            for (name,) in db.execute("SELECT name FROM cashaddr.sqlite_schema WHERE type='table'")
        }
        for name in source.keys() & destination:
            if db.execute(f"SELECT 1 FROM cashaddr.{name} LIMIT 1").fetchone():
                raise ValueError(f"CashAddr table {name} already contains data; refusing to merge.")
            db.execute(f"DROP TABLE cashaddr.{name}")
        moved = {}
        for name, sql in source.items():
            # Keep legacy columns (including nullable coordinates) and constraints intact.
            _, separator, definition = sql.partition("(")
            if not separator:
                raise ValueError(f"Unexpected table definition for {name}.")
            db.execute(f"CREATE TABLE cashaddr.{name} ({definition}")
            moved[name] = db.execute(
                f"INSERT INTO cashaddr.{name} SELECT * FROM main.{name}"
            ).rowcount
            if name == "mining_rewards" and db.execute(
                "SELECT 1 FROM main.sqlite_schema WHERE type='index' AND name='mining_rewards_xyz_idx'"
            ).fetchone():
                db.execute(
                    "CREATE UNIQUE INDEX cashaddr.mining_rewards_xyz_idx ON mining_rewards (x,y,z)"
                )
            db.execute(f"DROP TABLE main.{name}")
        return moved


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--world", type=Path, required=True)
    parser.add_argument("--cashaddr", type=Path, required=True)
    args = parser.parse_args()
    try:
        moved = migrate(args.world, args.cashaddr)
    except (OSError, sqlite3.Error, ValueError) as exc:
        parser.exit(1, f"CashAddr migration failed: {exc}\n")
    if not moved:
        print("No legacy reward or stats tables found in the world database.")
    for table, rows in moved.items():
        print(f"Moved {table}: {rows} row(s)")


if __name__ == "__main__":
    main()

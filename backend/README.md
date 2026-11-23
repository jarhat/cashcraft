# Backend persistence

The deployed storage engine is **SQLite**. `NETCRAFT_DB` (NetCraft only;
Compose: `/data/netcraft.db`) stores world state: block edits, lights, signs
and fluid simulation state. `CASHADDR_DB_PATH` (both NetCraft and auth;
Compose: `/data/cash-addresses.sqlite3`) stores CashAddr registrations,
auth data, welcome and mining payouts, guest/address mining progress, ore
totals and rankings, challenge mining progress, short links, donation
addresses and pickaxe orders.
Auth does not query the world database.

NetCraft attaches CashAddr to its world connection and commits mining edits
and their rewards/stats in a single transaction. Both files use rollback
journals rather than WAL so SQLite can recover a transaction that modifies
both files. Keep both databases on a local filesystem that supports SQLite
locking. The Compose services intentionally share the same `/data` bind
mount: both SQLite writers must be able to see the same recovery journal
path and create journal files as UID 10001. Do not enable WAL or put the
database files on separate hosts. Back up both files together with the payout
wallet.

## Migrate an existing Compose installation

1. Before starting the new services, stop both the old auth and NetCraft
   services. Back up the intact `data/` directory (including any journal/WAL
   files still present) and the BCHN payout wallet. Use a consistent backup,
   not a file copy while either service is running.
2. With both writers stopped, run from the repository root using Python 3
   and an account with access to both files and their directory:

   ```sh
   python3 backend/migrate_cashaddr.py \
     --world data/netcraft.db --cashaddr data/cash-addresses.sqlite3
   ```

   Use the actual on-disk paths for other installations. This moves the six
   legacy mining tables and prints row counts; it does not move world data or
   overwrite auth tables. It preserves payout IDs, signed transactions,
   transaction IDs, sent timestamps, and legacy rows without coordinates.
   The command is a no-op when the legacy tables are absent. It refuses to
   merge into a nonempty destination mining table; investigate or restore
   the matching backup rather than deleting payout data to force the merge.
3. Check the counts, then start the upgraded services with `CASHADDR_DB_PATH`
   pointing to the same file for both. The Compose permissions service fixes
   database ownership. Confirm world edits, rankings and payout totals before
   enabling payouts if doing a staged rollout. Fresh installs skip migration.

To roll back before accepting new writes, restore **both** SQLite files and
their associated sidecars from the same stopped snapshot. If any payouts
were attempted after the snapshot, reconcile signed transactions against BCHN
before resuming payouts; restoring old data alone can cause duplicate payments.

## PostgreSQL migration path (not enabled)

`CASHADDR_DB_PATH` is a SQLite filename, not a PostgreSQL DSN. The current
containers do not accept `DATABASE_URL` and no PostgreSQL service is required.
If adding PostgreSQL, migrate CashAddr first and leave NetCraft world data in
SQLite. Implement a durable, idempotent world-side outbox (or another
recoverable cross-store protocol) **before** switching: PostgreSQL cannot
participate in SQLite's attached transaction, so independent writes could
lose or double-credit mining payouts.

For that cutover, provision PostgreSQL with a dedicated least-privilege role
and database, add versioned migrations, and stop both writers. Export the
entire CashAddr database, including `challenge_mining`, into the new schema in
a single import transaction, retaining primary keys, foreign keys, coordinates
and uniqueness constraints, signed transactions and sent state. Reset
PostgreSQL identity sequences past imported IDs and compare row counts,
payout totals and pending transaction IDs. Test
retry/idempotency and reconciliation against a non-production BCHN setup
before enabling payouts. Keep the pre-cutover SQLite backup; reconcile
on-chain transactions before any rollback after new writes or broadcasts.

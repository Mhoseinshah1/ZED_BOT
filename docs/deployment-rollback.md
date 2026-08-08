# Application deployment rollback

`zedbot update` and `zedbot rollback` share a non-waiting host `flock`. Before
an update changes Git, API, Bot and Worker must share one valid `GIT_SHA` and
immutable image ID, API health must pass, and the Worker heartbeat must be fresh.

Rollback metadata is atomically written to
`/opt/zedbot/deployments/previous.json` (root-owned, mode 600, parent mode 700).
It contains identities, migration names, a compatibility checksum and state,
never secrets, environment values or database contents. States are `prepared`,
`application-recreated`, `available`, `available-after-failed-deploy`, and
`rolled-back`.

```bash
zedbot rollback-status
zedbot rollback
zedbot rollback --yes
```

Rollback interrupts API, Bot and Worker and runs only:

```bash
docker compose up -d --no-deps --no-build --force-recreate api bot worker
```

It never addresses, recreates or restarts PostgreSQL or Redis, never runs
migrations/seeding, and never restores database data. Success requires API
health, running Bot/Worker, matching SHAs and a fresh Worker heartbeat. Failure
preserves both image identities and never automatically oscillates images.

The typed migration gate treats the existing applied baseline as safe. Every
newly pending migration must be explicitly named in
`packages/database/prisma/rollback-compatibility.json`. Missing declarations or
failed, incomplete, database-only, unknown or malformed state blocks before
migration execution and application recreation. There is no override. Only
expand-compatible changes should be declared; contract changes require staged
expand/migrate/contract releases. The declaration is checksummed in metadata
and checked against freshly queried migration state immediately before rollback.

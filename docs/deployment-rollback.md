# Application deployment rollback

`zedbot update` and `zedbot rollback` share a non-waiting host `flock`. Before
an update changes Git, API, Bot and Worker must share one valid `GIT_SHA` and
immutable image ID, API health must pass, and the Worker heartbeat must be fresh.

Generation metadata uses four distinct roles: health-confirmed `current.json`,
health-confirmed rollback-only `previous.json`, untrusted
`candidate-<generation>.json`, and diagnostic-only `failed.json`. Files contain
identities, generation-owned evidence checksums and lifecycle state, never
secrets, environment values or database contents.

```bash
zedbot rollback-status
zedbot rollback
zedbot rollback --yes
```

## Strictly read-only rollback status

`zedbot rollback-status` is a point-in-time observation. It reads only the
fixed `/opt/zedbot/deployments` evidence allowlist and neither takes nor creates
the deployment lock. It does not create a directory or temporary file, recover
a transition, bootstrap or convert an installation, write metadata, inspect
Docker/Compose, query PostgreSQL or Redis, run readiness checks, or contact
Telegram. A check which would require one of those operations is reported as
unavailable, blocked, or indeterminate instead.

JSON is the default output and uses schema `zedbot.rollback-status/v1` with
numeric `schemaVersion: 1`, stable `rollbackStatus`, nullable `eligible`, `reasonCode`, safe `reason`, validated
generation identities, an `evidence` object, and bounded `warnings`. Human
output is available through `scripts/rollback.sh status --human` and is derived
from that same result. Exit status 0 means canonical evidence makes rollback
eligible; 2 means inspection completed but rollback is unavailable or blocked;
3 means evidence is ambiguous, invalid, changing, or unsafe; and 4 means an
internal inspection or argument failure occurred.

Stable reason codes are `ELIGIBLE`, `FIRST_INSTALL_EMPTY`,
`NO_PREVIOUS_GENERATION`, `LEGACY_NOT_CONVERTED`, `OPERATION_INCOMPLETE`,
`PARTIAL_INSTALLATION_EVIDENCE`, `INVALID_CURRENT_METADATA`,
`INVALID_CURRENT_EVIDENCE`, `INVALID_PREVIOUS_METADATA`,
`ROLLBACK_EVIDENCE_MISMATCH`, `INVALID_LEGACY_EVIDENCE`, `EVIDENCE_CHANGED`,
`INVALID_BOOTSTRAP_EVIDENCE`, `MIXED_INSTALLATION_EVIDENCE`,
`AMBIGUOUS_INSTALLATION`, `UNSAFE_STATE_PATH`, `INSPECTION_FAILED`, and
`INVALID_ARGUMENT`. Consumers use these enums and the schema instead of
parsing the human reason.

Availability requires a complete, distinct, known-good `current.json` and
`previous.json`, supported roles/schema, exact generation-owned Compose and
migration evidence, and matching checksums. Mutable tags, containers,
timestamps, environment values, readiness markers, candidate/failed files, and
status output are never authorization evidence. A first install without a real
previous generation is unavailable; unconverted legacy or incomplete bootstrap
state is blocked; partial or unsafe state is indeterminate.

The observer bounds metadata reads and compares file identity before and after
validation. Concurrently disappearing or substituted evidence therefore never
reports available. It may warn that live image existence and database state
were not inspected. A later rollback always acquires its operation lock and
freshly revalidates the same mandatory canonical evidence plus all operational
image, database, Generic Application Readiness, and Real Bot Readiness gates;
the status result is never persisted or consumed as proof.

Rollback interrupts API, Bot and Worker and runs only:

```bash
docker compose up -d --no-deps --no-build --pull never --force-recreate api bot worker
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

## Exact migration declaration evidence

Rollback compatibility uses only format 2. The manifest has exactly
`formatVersion` and `backwardCompatibleMigrations`; every declaration has
exactly `name` and `sqlSha256`. Names are direct Prisma migration-directory
names (`14 digits`, underscore, then lowercase letters/digits/underscores), and
checksums are exactly 64 lowercase hexadecimal characters. Unknown keys,
duplicates, legacy formats, traversal, and malformed values are rejected.

The SHA-256 is calculated over the exact `migration.sql` bytes, including line
endings and an empty file. The manifest and `migrations/` directory are always
resolved beneath one trusted repository root. Their directory sets must match
exactly: added, removed, renamed, malformed, or byte-modified migrations fail
closed. A regular `migration_lock.toml` is the only permitted non-directory
entry and does not participate in declaration hashing or ordering.

During update, validation reads only the verified immutable source snapshot.
The canonical declaration array is sorted by name for semantic comparison, but
the checksum recorded in candidate metadata covers the exact manifest bytes.
The updater also retains a read-only generation evidence copy of that exact
manifest/migrations pair. Rollback reads only that generation-bound evidence;
it does not combine it with the mutable checkout. Legacy metadata without the
format version, evidence source, manifest checksum, and exact declarations is
not rollback-compatible and is not upgraded by inference.

Diagnostics distinguish malformed JSON/schema, unavailable paths, mismatched
directory sets, malformed migration directories, exact SQL checksum failures,
manifest-byte checksum changes, declaration-set mismatch, and unknown,
database-only, failed, incomplete, or pending database state. None has an
override or warn-and-continue path.

## Canonical Compose contract

Deployment operations use one runtime project identity: project directory
`/opt/zedbot/app`, project name `zedbot`, and explicit runtime env file
`/opt/zedbot/app/.env`. The env path is not caller-selectable, implicit `.env`
discovery is disabled, and a symlink, missing path, or wrong file type fails
closed. Update takes `docker-compose.yml` only from the verified immutable
source snapshot. The same exact file is checksummed and retained with generation
evidence; rollback accepts only that generation-bound copy.

Every Docker/Compose child starts with an empty environment containing only a
deterministic `PATH`, locale, and `COMPOSE_DISABLE_ENV_FILE=1`. Thus ambient
`COMPOSE_*`, `DOCKER_*`, builder, profile, context, daemon, config, and env-file
variables—including values sourced earlier from the runtime env—cannot redirect
resolution. Docker is addressed through the explicit `default` context.

Before retention, build, compatibility checks, migration, or recreation,
Compose renders JSON. The validator selects exact service keys `api`, `bot`,
and `worker` and requires each image to be exactly `zedbot-app:latest`.
PostgreSQL, Redis, and unrelated services may be present but are not counted as
application images. Missing services/images, alternate repositories, tags,
digests, interpolation results, or malformed structured output abort the flow.

Update and rollback recreate applications only with the equivalent of:

```text
docker --context default compose --project-directory /opt/zedbot/app \
  -f <verified snapshot or generation-evidence docker-compose.yml> \
  --project-name zedbot --env-file /opt/zedbot/app/.env \
  up -d --no-deps --no-build --pull never --force-recreate api bot worker
```

Rollback validates the retained image ID before retagging and never builds or
pulls. Neither path uses project-wide `up`, `down`, `stop`, `restart`,
`--remove-orphans`, PostgreSQL, or Redis recreation. Deeper directory-component,
metadata, lock, and race hardening remains correction area 6 and is not claimed
by this Compose-path validation.
# Bot readiness

Deployment readiness for the Bot proves that the container is running without
a restart loop, can load the built readiness CLI, and can complete bounded
connections to PostgreSQL and Redis. It represents completed local runtime and
critical-dependency initialization. It intentionally does not call Telegram,
so a Telegram outage alone cannot leave an update waiting indefinitely.

## Four-role generation lifecycle

`current.json` is exactly the health-confirmed generation serving now.
`previous.json` is exactly the health-confirmed generation which served
immediately before current and is the only rollback target. A candidate is
never known-good or rollback material. `failed.json` may explain why rollback
is needed and record the intended previous identity, but is never selected as
the rollback generation or retagged as the rollback image.

Candidate creation, build, tagging, compatibility, migration, recreation and
health failure leave both known-good files unchanged. After target health is
confirmed, `transition.json` records a resumable update rotation: old current
is written as previous, then the healthy candidate is written as current.
Every partial phase is deterministic and must be recovered before another
lifecycle operation; malformed transition state fails closed.

Rollback validates only complete `previous.json`, including its immutable image
reference, Compose evidence, migration evidence and exact checksums. After
application health succeeds, a rollback transition promotes previous to
current and consumes previous without ever placing the failed generation there.
Diagnostic failed metadata remains. Interrupted promotion is recovered from
the transaction record, and a retry resolves the same previous known-good
identity. No timestamp fallback, caller selection, image pruning or broad
deletion is performed. Missing `current.json` and legacy metadata cannot be
inferred; bootstrap or explicit reconciliation is required.

## Confirmed operation-state ordering

`operation-state.json` records only the last positively confirmed boundary.
Update advances through `current-validated`, `current-image-retained`,
`candidate-metadata-prepared`, `candidate-image-built`,
`deployment-reference-tagged`, `compatibility-confirmed`,
`migrations-confirmed`, `application-recreated`, `health-confirmed`,
`promotion-prepared`, `promoted`. Rollback advances through
`previous-selected`, `rollback-evidence-validated`,
`retained-image-validated`, `deployment-reference-retagged`,
`compatibility-confirmed`, `application-recreated`, `health-confirmed`,
`promotion-prepared`, `promoted`.

Every successor requires the exact predecessor. The operation and its explicit
verification run before a fresh state-directory-local temporary payload is
validated and atomically renamed. A write failure leaves the predecessor
authoritative. Unknown, skipped, duplicate strict, or backward transitions fail
closed. Retry revalidates trusted inputs and may acknowledge an already
persisted boundary, but cannot infer progress from files, timestamps,
containers, or mutable tags.

`application-recreated` means the canonical application-only Compose command
returned success and separate inspection found exactly one distinct `api`,
`bot`, and `worker` container using the expected immutable image ID. Missing,
duplicated, mixed, partial, or substituted results fail without advancing.
PostgreSQL and Redis are never part of this confirmation. Recreation does not
imply health: `health-confirmed` is a separate later gate, and metadata rotation
cannot begin before it.

Rollback availability still requires complete reachable `previous.json`
image, Compose, and migration evidence. Candidate or failed metadata never has
that meaning. `transition.json` remains the deterministic promotion recovery
record. Broader descriptor, ownership, signal, readiness, legacy-upgrade, and
read-only-status hardening remains in correction areas 6–11.

## Canonical deployment state and lock policy

Update and rollback reset deployment-state identity to the fixed
`/opt/zedbot/deployments` directory before state access. `current.json`,
`previous.json`, `failed.json`, `transition.json`, `operation-state.json`,
`bot-recreation.json`, and `deployment.lock` must be exact direct children;
candidate metadata is limited
to its validated generation-derived filename. Relative paths, traversal/dot
spellings, alternate child paths, symlinked components, and external metadata
destinations fail closed.

Existing state files must be root-owned mode-600 regular files and the state
directory root-owned mode 700. Replacement uses a fresh state-directory
`mktemp`, flushes the completed file, atomically renames it, flushes the
directory, and revalidates the destination. Mutation and canonical state-file
removal require proof that the process still owns the canonical lock inode.

The persistent lock inode is created through a unique temporary file and
atomic hard link, then verified against its opened descriptor before a
non-waiting exclusive lock is taken. An existing unlocked, root-owned mode-600
regular inode is the only accepted stale-lock condition. Active, symlinked,
substituted, wrong-type, wrong-owner, or wrong-mode locks fail closed. A process
can release only the inode recorded at acquisition; substitution causes cleanup
refusal. Process exit releases the advisory lock without marking deployment
state successful. Broader signal orchestration remains deferred to area 9.

## Shared readiness policy

Update and rollback use the same structured readiness evaluator and bounded
poller in `scripts/lib/common.sh`. The canonical Compose model binds dependency
identities to `postgres:16-alpine` and `redis:7-alpine`, and application
identities to `zedbot-app:latest` for exactly `api`, `bot`, and `worker`.

Every poll obtains fresh evidence for exactly one unique container per required
service. It verifies the fixed project and service labels, expected image
reference, immutable image ID, process state, declared health result, and—for
applications—the expected full deployment SHA and common target image ID.
Empty, malformed, truncated, duplicate, stale, mixed-generation,
contradictory, or command-failure evidence fails closed. Only a complete
`starting` set is retryable; exited, restarting, dead, unhealthy, unknown, or
identity-mismatched evidence stops polling.

Dependency polling is bounded to 30 seconds and application polling to 90
seconds, both at a positive three-second interval. Timeout, cancellation, and
inspection failure never become success. PostgreSQL and Redis are readiness
dependencies only; recreation remains exactly `api bot worker` with
`--no-deps --no-build --pull never --force-recreate`.

Successful recreation records only `application-recreated`. The later
`health-confirmed` boundary requires the complete application set to pass this
gate. The additional Real Bot process-owned gate is described below; broader
signal handling remains correction area 9.

## Real Bot process-owned readiness

The Bot writes `/tmp/zedbot-bot-readiness.json` from its real grammY `onStart`
callback only after the application and handlers have been constructed, local
consumers and loops plus shutdown handlers have been installed, the database
client has initialized, and the full baked Git SHA is available. The mode-600
marker contains only non-secret process/generation identity and completed-
component flags. It contains no token, chat, webhook, environment, or
credential data.

Startup, shutdown, and terminal startup rejection remove the marker. The local
readiness CLI rejects symlinks, unsafe modes, malformed schemas, dead or wrong
processes, and incomplete components. It performs no Telegram request.

After exact application recreation is verified, update or rollback atomically
records `bot-recreation.json` beneath the canonical locked deployment-state
directory. That boundary binds the operation/generation to the newly recreated
Bot container and immutable image. Real Bot polling then requires fresh
structured evidence matching that boundary, the current operation, canonical
project/service, exact container, image reference/ID, and full deployment SHA.
A marker from an old container or attempt cannot cross this boundary.

Polling is bounded to 90 seconds at three-second intervals. Only the exact
`starting` response caused by an absent marker is retryable. Restart, process
exit, terminal CLI failure, malformed or truncated output, identity change,
cancellation, timeout, or stale evidence fails closed. The generic area-7 gate
still runs first; its success alone cannot write `health-confirmed`. Only the
subsequent Real Bot gate permits health confirmation and later promotion.
## Signal and interruption safety

Update and rollback install the same operation-level `EXIT`, `SIGINT`,
`SIGTERM`, and `SIGHUP` policy before protected work. The first handled signal
marks the operation interrupted and preserves status 130, 143, or 129. No
later child command or confirmed state transition may start, and cleanup cannot
turn a failure or signal into success.

External commands run as a tracked invocation-owned process group with lock
descriptor 9 closed. Interruption sends `TERM` only to that verified group,
waits for a bounded interval, escalates to `KILL` when necessary, and reaps it.
No process-name matching or global service termination is used.

Cleanup is idempotent and removes only invocation-registered temporary
artifacts whose inode and parent-directory inode still match. Missing artifacts
are harmless; symlink or inode substitution is preserved and reported. The
persistent canonical lock file is never deleted—only this shell's verified
advisory lock is released. Canonical lifecycle metadata remains governed by the
existing atomic write and validation policy.

Retry is a new locked operation and revalidates canonical metadata, immutable
identities, generic readiness, and Real Bot readiness. Temporary artifacts,
process identifiers, and readiness evidence from an interrupted attempt are
not accepted as success evidence. First-install and rollback-status policy
remain outside this hardening area.

## First-install and legacy-upgrade identity

Update and rollback proceed only when the locked authoritative classifier finds
an existing canonical `current.json` with complete reachable evidence. Missing,
partial, mixed, malformed, symlinked, unsupported-version, or ambiguous state
is not interpreted as first install or rollback availability.

A genuine first install requires an explicit first-install invocation against a
canonical state directory containing no installation evidence. Its strict
`bootstrap.json` binds operation, generation, source commit/tree, and confirmed
phase. The initial candidate must still pass migration declarations, dependency
readiness, exact `api bot worker` recreation, Generic Application Readiness,
and Real Bot Readiness. Only then may it become `current`; no fabricated
`previous.json` is created.

The sole convertible legacy form is a complete format-2 known-good generation
at `legacy-install-v1.json` with valid generation-owned Compose and migration
evidence. Conversion is locked and atomic, preserves that file for diagnosis,
and records a matching promoted bootstrap transaction. All less-complete legacy
forms fail closed with operator-directed reconciliation. Rollback-status
redesign remains Area 11.

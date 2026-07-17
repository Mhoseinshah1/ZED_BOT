# Backup encryption: the ZBK1 envelope

At-rest encryption for database backups is a small, versioned envelope
built exclusively from Node's audited crypto primitives — **no custom
cryptography**. Implementation: `packages/shared/src/backup-crypto.ts`
(envelope + key derivation) and `apps/worker/src/backup/zbk1-stream.ts`
(streaming writer). Encryption is enabled by setting a non-empty
`BACKUP_ENCRYPTION_PASSWORD`; an empty value produces plain `.dump` files.

## Envelope layout (version 1, magic `ZBK1`)

```
offset  size  content
0       4     magic  "ZBK1" (ASCII)
4       1     version = 0x01
5       16    scrypt salt        (random, per backup)
21      12    AES-GCM nonce (IV) (random, per backup)
33      …     ciphertext         (pg_dump custom-format stream)
EOF-16  16    GCM authentication tag
```

Header size is fixed at **33 bytes** (`BACKUP_ENVELOPE_HEADER_BYTES`); the
auth tag is always the file's **last 16 bytes**. The smallest valid
encrypted file is therefore 33 + 1 + 16 = 50 bytes — anything shorter is
rejected as `envelope-too-short`. The writer emits header → ciphertext
chunks → tag as a single stream, so encryption adds no second pass and no
plaintext ever touches disk during creation.

## Cipher and key derivation

- **AES-256-GCM** (`createCipheriv("aes-256-gcm", …)`): authenticated
  encryption — decryption fails loudly on a wrong password *or* any
  bit-level tampering, instead of silently producing garbage.
- Key: 32 bytes derived from `BACKUP_ENCRYPTION_PASSWORD` via **scrypt**
  with `N = 2^15 (32768), r = 8, p = 1, maxmem = 128 MiB` —
  interactive-grade parameters, documented here on purpose so a future
  version bump is a conscious decision (a parameter change would require a
  new envelope version).

## Per-backup salt and nonce

Every backup gets a **fresh random 16-byte salt and 12-byte nonce**
(`randomBytes`), never reused across files. Consequences:

- The same database content encrypted twice yields unrelated ciphertexts.
- Each file independently derives its key from the password + its own
  salt, so files remain individually decryptable forever — including after
  a password rotation, **with the password that was active when the file
  was written**. Rotating `BACKUP_ENCRYPTION_PASSWORD` does not re-encrypt
  old files; keep old passwords for as long as you keep old backups.

## What is stored vs what is not

| Stored in the file (non-secret, required for decryption) | Never stored anywhere |
| --- | --- |
| magic, version, salt, nonce, auth tag | the password |
| — | the derived AES key |

The password and key are never logged, persisted or transmitted. The
database row and manifest record only the boolean `encrypted`; the admin
UI shows only **presence** («رمزنگاری بکاپ: فعال ✅» / «غیرفعال ⚠️»).

## Password handling rules

- Source: `BACKUP_ENCRYPTION_PASSWORD` in `.env` (chmod 600). The installer
  auto-generates one and prints a warning to copy it **off the server** —
  encrypted backups are useless without it.
- Only the worker (and its CLIs) ever reads the value; the bot reads
  presence only (`isBackupEncryptionEnabled`).
- Wrong password and file tampering are **indistinguishable by design**:
  every decryption/authentication failure collapses to the single safe
  code `decrypt-failed`, with no crypto details echoed to Telegram, logs
  or job results.
- Verification of an encrypted file stream-decrypts to a short-lived
  plaintext temp file under `os.tmpdir()` (exclusive create, mode 600)
  that is **unconditionally unlinked** in a `finally` block.
- Shell scripts never handle the crypto: `backup-db.sh` delegates
  encryption to the worker image's `encrypt-backup` CLI so the ZBK1 format
  has exactly one implementation.

## Interoperability notes

- `openssl enc` **cannot** decrypt ZBK1 files: it supports neither the
  scrypt KDF nor streaming AES-GCM in `enc` mode. Any instruction that
  suggests `openssl` for `.dump.enc` files predates the ZBK1 envelope and
  will not work — use the worker's verify CLI / the openssl-free Node
  decrypt path in [backup-restore-runbook.md](backup-restore-runbook.md).
- The envelope parser rejects unknown magics and versions
  (`backup envelope: bad magic` / `unsupported version`), so a future
  `ZBK2`/v2 can coexist without ambiguity.
- Legacy `.sql.gz` backups are **not** encrypted at all — documented
  limitation, see [backup-architecture.md](backup-architecture.md).

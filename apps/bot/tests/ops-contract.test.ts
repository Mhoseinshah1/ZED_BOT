import { randomBytes } from "node:crypto";

import {
  BACKUP_ENVELOPE_HEADER_BYTES,
  BACKUP_ENVELOPE_MAGIC,
  BACKUP_ENVELOPE_NONCE_BYTES,
  BACKUP_ENVELOPE_SALT_BYTES,
  BACKUP_ENVELOPE_TAG_BYTES,
  classifyBackupFileName,
  createBackupDecryptor,
  createBackupEncryptor,
  parseBackupEnvelopeHeader,
  REDACTED_VALUE,
  sanitizeOpsMetadata,
  scrubSecretsFromText,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

// =============================================================================
// Pure unit tests for the shared ops contract (packages/shared/src/ops.ts +
// backup-crypto.ts): metadata sanitizing, secret scrubbing, the backup
// filename classifier and the ZBK1 authenticated-encryption envelope. No
// database, no redis, no filesystem.
// =============================================================================

const PASSWORD = "ops-contract-test-pass";

interface Envelope {
  file: Buffer;
  header: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function encryptBuffer(plaintext: Buffer, password: string): Envelope {
  const { header, cipher } = createBackupEncryptor(password);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { file: Buffer.concat([header, ciphertext, tag]), header, ciphertext, tag };
}

function decryptBuffer(file: Buffer, password: string): Buffer {
  const header = parseBackupEnvelopeHeader(file.subarray(0, BACKUP_ENVELOPE_HEADER_BYTES));
  const tag = file.subarray(file.length - BACKUP_ENVELOPE_TAG_BYTES);
  const body = file.subarray(header.dataStart, file.length - BACKUP_ENVELOPE_TAG_BYTES);
  const decipher = createBackupDecryptor(password, header, tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

describe("sanitizeOpsMetadata", () => {
  it("redacts every denylisted key", () => {
    const input = {
      token: "abc",
      password: "abc",
      secret: "abc",
      database_url: "abc",
      api_key: "abc",
      apiKey: "abc",
      subscription_url: "abc",
      sub_id: "abc",
      subId: "abc",
      remote_client_id: "abc",
      credential: "abc",
      private_key: "abc",
      authorization: "abc",
      cookie: "abc",
      merchant_id: "abc",
      config: "abc",
      BOT_TOKEN: "abc", // case-insensitive
    };
    const out = sanitizeOpsMetadata(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(out[key], key).toBe(REDACTED_VALUE);
    }
  });

  it("redacts recursively and preserves benign values", () => {
    const out = sanitizeOpsMetadata({
      orderId: "o-1",
      amount: 50_000,
      ok: true,
      when: new Date("2026-07-17T00:00:00.000Z"),
      big: 123n,
      none: null,
      nested: { deeper: { password: "hunter2", note: "fine" } },
      list: [{ token: "x" }, "postgres://u:p@h:5432/db", 7],
    }) as {
      orderId: string;
      amount: number;
      ok: boolean;
      when: string;
      big: string;
      none: null;
      nested: { deeper: { password: string; note: string } };
      list: [Record<string, unknown>, string, number];
    };
    expect(out.orderId).toBe("o-1");
    expect(out.amount).toBe(50_000);
    expect(out.ok).toBe(true);
    expect(out.when).toBe("2026-07-17T00:00:00.000Z");
    expect(out.big).toBe("123");
    expect(out.none).toBeNull();
    expect(out.nested.deeper.password).toBe(REDACTED_VALUE);
    expect(out.nested.deeper.note).toBe("fine");
    expect(out.list[0].token).toBe(REDACTED_VALUE);
    // String VALUES are scrubbed even under harmless keys.
    expect(out.list[1]).toBe(REDACTED_VALUE);
    expect(out.list[2]).toBe(7);
  });

  it("bounds depth, key count, array length and string length", () => {
    // Depth: objects deeper than 4 levels collapse to [truncated].
    const deep = { l1: { l2: { l3: { l4: { l5: { leaf: "x" } } } } } };
    const deepOut = sanitizeOpsMetadata(deep) as {
      l1: { l2: { l3: { l4: { l5: unknown } } } };
    };
    expect(deepOut.l1.l2.l3.l4.l5).toBe("[truncated]");

    // Key count: at most 30 keys survive, plus one truncation marker.
    const wide: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) {
      wide[`k${i}`] = i;
    }
    const wideOut = sanitizeOpsMetadata(wide) as Record<string, unknown>;
    expect(Object.keys(wideOut)).toHaveLength(31);
    expect(wideOut["…"]).toBe("[truncated]");

    // Arrays are capped at 20 entries.
    const arrOut = sanitizeOpsMetadata(Array.from({ length: 50 }, (_v, i) => i)) as number[];
    expect(arrOut).toHaveLength(20);

    // Long strings are capped at 500 chars + ellipsis ("x" is not a hex
    // char, so the 48+-hex secret scrubber leaves it alone).
    const longOut = sanitizeOpsMetadata("x".repeat(800)) as string;
    expect(longOut).toHaveLength(501);
    expect(longOut.endsWith("…")).toBe(true);
  });
});

describe("scrubSecretsFromText", () => {
  it("scrubs connection URLs (postgres/postgresql/redis/vless)", () => {
    const scrubbed = scrubSecretsFromText(
      [
        "db1 postgres://user:pass@db:5432/app failed",
        "db2 postgresql://user:pass@db:5432/app?sslmode=require failed",
        "cache redis://:secret-pw@127.0.0.1:6379/0 down",
        "link vless://11111111-2222-3333-4444-555555555555@host:443?security=tls#tag",
      ].join("\n"),
    );
    expect(scrubbed).not.toContain("postgres://");
    expect(scrubbed).not.toContain("postgresql://");
    expect(scrubbed).not.toContain("redis://");
    expect(scrubbed).not.toContain("vless://");
    expect(scrubbed).not.toContain("secret-pw");
    expect(scrubbed).toContain(REDACTED_VALUE);
    // Surrounding prose survives.
    expect(scrubbed).toContain("db1");
    expect(scrubbed).toContain("down");
  });

  it("scrubs bot tokens, JWTs and long hex secrets", () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"; // 35-char secret part
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const hex = "deadbeef".repeat(8); // 64 hex chars
    const scrubbed = scrubSecretsFromText(`t=${token} j=${jwt} h=${hex} end`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(scrubbed).not.toContain("eyJ");
    expect(scrubbed).not.toContain(hex);
    expect(scrubbed).toContain("end");
    expect(scrubbed).toContain(REDACTED_VALUE);
  });

  it("leaves benign text untouched", () => {
    const text = "user 42 paid 10000 toman for order ab12cd34 (attempt 2)";
    expect(scrubSecretsFromText(text)).toBe(text);
  });
});

describe("classifyBackupFileName", () => {
  it("accepts exactly the three backup kinds with their short id", () => {
    expect(classifyBackupFileName("zedbot-db-20260710-183000.dump")).toEqual({
      kind: "dump",
      shortId: "20260710-183000",
    });
    expect(classifyBackupFileName("zedbot-db-20260710-183000.dump.enc")).toEqual({
      kind: "dump-encrypted",
      shortId: "20260710-183000",
    });
    expect(classifyBackupFileName("zedbot-db-20260710-183000.sql.gz")).toEqual({
      kind: "legacy-sql-gz",
      shortId: "20260710-183000",
    });
  });

  it("rejects partials, manifests, traversal names and junk", () => {
    for (const bad of [
      "zedbot-db-20260710-183000.dump.partial",
      "zedbot-db-20260710-183000.dump.enc.partial",
      "zedbot-db-20260710-183000.dump.manifest.json",
      "zedbot-db-20260710-183000.dump.enc.manifest.json",
      "../zedbot-db-20260710-183000.dump",
      "zedbot-db-20260710-183000.dump/../../etc/passwd",
      "zedbot-db-2026071-183000.dump", // short date
      "zedbot-db-20260710-183000.sql", // not gzipped legacy
      "zedbot-db-20260710-183000.dump.bak",
      "prefix-zedbot-db-20260710-183000.dump",
      "zedbot-db-20260710-183000.DUMP", // anchored + case-sensitive
      "zedbot-db-20260710-183000.dump.enc.extra",
      "junk.txt",
      "",
    ]) {
      expect(classifyBackupFileName(bad), bad).toBeNull();
    }
  });
});

describe("ZBK1 backup envelope", () => {
  // Plaintext embeds the pg_dump magic and SQL-looking text so the "no
  // plaintext leaks into the envelope" assertion is meaningful.
  const plaintext = Buffer.concat([
    Buffer.from("PGDMP"),
    Buffer.from("SELECT * FROM secret_table; -- zedbot-plaintext-marker"),
    randomBytes(2048),
  ]);

  it("round-trips: encrypt -> parse header -> decrypt equals the plaintext", () => {
    expect(BACKUP_ENVELOPE_HEADER_BYTES).toBe(
      BACKUP_ENVELOPE_MAGIC.length + 1 + BACKUP_ENVELOPE_SALT_BYTES + BACKUP_ENVELOPE_NONCE_BYTES,
    );
    const { file } = encryptBuffer(plaintext, PASSWORD);
    expect(file.subarray(0, 4).toString("ascii")).toBe("ZBK1");
    const header = parseBackupEnvelopeHeader(file.subarray(0, BACKUP_ENVELOPE_HEADER_BYTES));
    expect(header.version).toBe(1);
    expect(header.salt).toHaveLength(BACKUP_ENVELOPE_SALT_BYTES);
    expect(header.nonce).toHaveLength(BACKUP_ENVELOPE_NONCE_BYTES);
    expect(header.dataStart).toBe(BACKUP_ENVELOPE_HEADER_BYTES);
    expect(decryptBuffer(file, PASSWORD).equals(plaintext)).toBe(true);
  });

  it("throws on final() for a wrong password", () => {
    const { file } = encryptBuffer(plaintext, PASSWORD);
    expect(() => decryptBuffer(file, "not-the-password")).toThrow();
  });

  it("uses a fresh salt + nonce per backup, so identical plaintext never repeats ciphertext", () => {
    const a = encryptBuffer(plaintext, PASSWORD);
    const b = encryptBuffer(plaintext, PASSWORD);
    const headerA = parseBackupEnvelopeHeader(a.header);
    const headerB = parseBackupEnvelopeHeader(b.header);
    expect(headerA.salt.equals(headerB.salt)).toBe(false);
    expect(headerA.nonce.equals(headerB.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // Both still decrypt to the same plaintext.
    expect(decryptBuffer(a.file, PASSWORD).equals(plaintext)).toBe(true);
    expect(decryptBuffer(b.file, PASSWORD).equals(plaintext)).toBe(true);
  });

  it("fails authentication when a single ciphertext byte is tampered", () => {
    const { file } = encryptBuffer(plaintext, PASSWORD);
    const tampered = Buffer.from(file);
    const target = BACKUP_ENVELOPE_HEADER_BYTES + 10; // inside the ciphertext
    tampered[target] = tampered[target] ^ 0xff;
    expect(() => decryptBuffer(tampered, PASSWORD)).toThrow();
  });

  it("never leaks plaintext marker bytes into the encrypted output", () => {
    const { file } = encryptBuffer(plaintext, PASSWORD);
    expect(file.includes(Buffer.from("PGDMP"))).toBe(false);
    expect(file.includes(Buffer.from("SELECT * FROM secret_table"))).toBe(false);
    expect(file.includes(Buffer.from("zedbot-plaintext-marker"))).toBe(false);
  });

  it("rejects malformed envelope headers (short / bad magic / bad version)", () => {
    expect(() => parseBackupEnvelopeHeader(Buffer.alloc(4))).toThrow(/header too short/);
    const { file } = encryptBuffer(plaintext, PASSWORD);
    const badMagic = Buffer.from(file.subarray(0, BACKUP_ENVELOPE_HEADER_BYTES));
    badMagic.write("NOPE", 0, "ascii");
    expect(() => parseBackupEnvelopeHeader(badMagic)).toThrow(/bad magic/);
    const badVersion = Buffer.from(file.subarray(0, BACKUP_ENVELOPE_HEADER_BYTES));
    badVersion[4] = 9;
    expect(() => parseBackupEnvelopeHeader(badVersion)).toThrow(/unsupported version/);
  });
});

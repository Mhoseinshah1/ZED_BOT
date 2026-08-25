import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import path from "node:path";

export const MIGRATION_DECLARATION_FORMAT_VERSION = 2 as const;
export const MIGRATION_DECLARATION_SOURCE_CATEGORY = "verified-repository-prisma" as const;

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface MigrationDeclaration {
  name: string;
  sqlSha256: string;
}

export interface MigrationDeclarationManifest {
  formatVersion: 2;
  backwardCompatibleMigrations: MigrationDeclaration[];
}

export interface ValidatedMigrationDeclarationPair {
  manifest: MigrationDeclarationManifest;
  declarations: MigrationDeclaration[];
  manifestSha256: string;
  sourceCategory: typeof MIGRATION_DECLARATION_SOURCE_CATEGORY;
  manifestPath: string;
  migrationsPath: string;
}

export type MigrationDeclarationValidation =
  | { ok: true; value: ValidatedMigrationDeclarationPair }
  | { ok: false; blocker: string };

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function parseMigrationDeclarationManifest(value: unknown): MigrationDeclarationManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["formatVersion", "backwardCompatibleMigrations"])) return null;
  if (candidate.formatVersion !== MIGRATION_DECLARATION_FORMAT_VERSION) return null;
  if (!Array.isArray(candidate.backwardCompatibleMigrations)) return null;
  const declarations: MigrationDeclaration[] = [];
  for (const raw of candidate.backwardCompatibleMigrations) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const declaration = raw as Record<string, unknown>;
    if (!exactKeys(declaration, ["name", "sqlSha256"])) return null;
    if (typeof declaration.name !== "string" || !MIGRATION_NAME.test(declaration.name)) return null;
    if (typeof declaration.sqlSha256 !== "string" || !SHA256.test(declaration.sqlSha256)) return null;
    declarations.push({ name: declaration.name, sqlSha256: declaration.sqlSha256 });
  }
  if (new Set(declarations.map(({ name }) => name)).size !== declarations.length) return null;
  return {
    formatVersion: MIGRATION_DECLARATION_FORMAT_VERSION,
    backwardCompatibleMigrations: declarations.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function validateMigrationDeclarationPair(repositoryRoot: string): MigrationDeclarationValidation {
  const prismaRoot = path.join(repositoryRoot, "packages", "database", "prisma");
  const manifestPath = path.join(prismaRoot, "rollback-compatibility.json");
  const migrationsPath = path.join(prismaRoot, "migrations");
  let trustedRoot: string;
  let rawManifest: Buffer;
  try {
    trustedRoot = realpathSync(repositoryRoot);
    if (realpathSync(prismaRoot) !== path.join(trustedRoot, "packages", "database", "prisma")) {
      return { ok: false, blocker: "migration-pair-path-escape" };
    }
    rawManifest = readFileSync(manifestPath);
  } catch {
    return { ok: false, blocker: "migration-manifest-unavailable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest.toString("utf8")) as unknown;
  } catch {
    return { ok: false, blocker: "migration-manifest-malformed-json" };
  }
  const manifest = parseMigrationDeclarationManifest(parsed);
  if (manifest === null) return { ok: false, blocker: "migration-manifest-invalid-schema" };

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(migrationsPath, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return { ok: false, blocker: "migrations-directory-unavailable" };
  }
  if (entries.some((entry) => !entry.isDirectory()
    && !(entry.name === "migration_lock.toml" && entry.isFile()))) {
    return { ok: false, blocker: "migrations-directory-unexpected-entry" };
  }
  const actualNames = entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
  if (actualNames.some((name) => !MIGRATION_NAME.test(name))) {
    return { ok: false, blocker: "migration-directory-invalid-name" };
  }
  const declaredNames = manifest.backwardCompatibleMigrations.map(({ name }) => name);
  const missing = declaredNames.find((name) => !actualNames.includes(name));
  if (missing !== undefined) return { ok: false, blocker: `migration-directory-missing:${missing}` };
  const additional = actualNames.find((name) => !declaredNames.includes(name));
  if (additional !== undefined) return { ok: false, blocker: `migration-directory-undeclared:${additional}` };

  for (const declaration of manifest.backwardCompatibleMigrations) {
    const directory = path.join(migrationsPath, declaration.name);
    let children: Dirent<string>[];
    try {
      children = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return { ok: false, blocker: `migration-directory-unreadable:${declaration.name}` };
    }
    if (children.length !== 1 || children[0]?.name !== "migration.sql" || !children[0].isFile()) {
      return { ok: false, blocker: `migration-directory-malformed:${declaration.name}` };
    }
    const sqlPath = path.join(directory, "migration.sql");
    try {
      if (!lstatSync(sqlPath).isFile()) return { ok: false, blocker: `migration-sql-not-file:${declaration.name}` };
      const checksum = createHash("sha256").update(readFileSync(sqlPath)).digest("hex");
      if (checksum !== declaration.sqlSha256) return { ok: false, blocker: `migration-sql-checksum:${declaration.name}` };
    } catch {
      return { ok: false, blocker: `migration-sql-unavailable:${declaration.name}` };
    }
  }

  return {
    ok: true,
    value: {
      manifest,
      declarations: manifest.backwardCompatibleMigrations,
      manifestSha256: createHash("sha256").update(rawManifest).digest("hex"),
      sourceCategory: MIGRATION_DECLARATION_SOURCE_CATEGORY,
      manifestPath,
      migrationsPath,
    },
  };
}

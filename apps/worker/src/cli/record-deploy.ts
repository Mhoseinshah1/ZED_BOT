import { SettingType, connectDatabase, disconnectDatabase, prisma } from "@zedbot/database";
import {
  DEPLOYED_REPO_SHA_AT_SETTING_KEY,
  DEPLOYED_REPO_SHA_SETTING_KEY,
  normalizeGitSha,
  scrubSecretsFromText,
} from "@zedbot/shared";

// =============================================================================
// CLI: record the repository SHA of a COMPLETED deploy into the Setting table
// (called by scripts/update.sh / install.sh after containers are up). Usage:
//
//   node dist/cli/record-deploy.js <git-sha>
//
// The bot compares its own baked GIT_SHA against this value to detect stale
// running containers after an update. Prints one-line JSON {ok, sha} and
// exits 0 on success; {ok:false, error:"invalid-sha"} and exit 1 on a bad
// argument. Never prints env values or the connection string.
// =============================================================================

async function main(): Promise<void> {
  const sha = normalizeGitSha(process.argv[2]);
  if (sha === null) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid-sha" })}\n`);
    process.exit(1);
  }

  await connectDatabase();
  let exitCode = 1;
  try {
    const recordedAt = new Date().toISOString();
    await prisma.setting.upsert({
      where: { key: DEPLOYED_REPO_SHA_SETTING_KEY },
      update: { value: sha },
      create: {
        key: DEPLOYED_REPO_SHA_SETTING_KEY,
        value: sha,
        type: SettingType.STRING,
        isPublic: false,
      },
    });
    await prisma.setting.upsert({
      where: { key: DEPLOYED_REPO_SHA_AT_SETTING_KEY },
      update: { value: recordedAt },
      create: {
        key: DEPLOYED_REPO_SHA_AT_SETTING_KEY,
        value: recordedAt,
        type: SettingType.STRING,
        isPublic: false,
      },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, sha })}\n`);
    exitCode = 0;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  // Scrubbed: a Prisma connection error must never leak DATABASE_URL.
  const message = scrubSecretsFromText(err instanceof Error ? err.message : String(err));
  process.stderr.write(`record-deploy failed: ${message.slice(0, 200)}\n`);
  process.exit(1);
});

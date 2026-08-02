import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("TypeScript source integrity", () => {
  it("contains no literal NUL bytes in tracked or untracked TypeScript sources", () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
    const candidates = new Set(
      [
        git("ls-files", "--", "*.ts", "*.tsx"),
        git("diff", "--name-only", "--", "*.ts", "*.tsx"),
        git("ls-files", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"),
      ]
        .join("\n")
        .split("\n")
        .filter(Boolean),
    );
    const contaminated = [...candidates]
      .filter(Boolean)
      .filter((file) => existsSync(resolve(repositoryRoot, file)))
      .filter((file) => readFileSync(resolve(repositoryRoot, file)).includes(0));

    expect(contaminated, `literal NUL byte found in: ${contaminated.join(", ")}`).toEqual([]);
  });
});

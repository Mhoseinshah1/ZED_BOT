import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("TypeScript source integrity", () => {
  it("contains no literal NUL bytes in tracked or untracked TypeScript sources", () => {
    const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
    const candidates: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) visit(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          candidates.push(path);
        }
      }
    };
    for (const workspace of ["apps", "packages"]) {
      const workspaceRoot = join(repositoryRoot, workspace);
      for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sourceRoot = join(workspaceRoot, entry.name, "src");
        try {
          visit(sourceRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const contaminated = candidates
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => relative(repositoryRoot, file));

    expect(contaminated, `literal NUL byte found in: ${contaminated.join(", ")}`).toEqual([]);
  });
});

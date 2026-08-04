import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, "../src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("Mini App API transport boundary", () => {
  const sources = files(API_SRC).map(file => ({ file, source: readFileSync(file, "utf8") }));

  it("has no Bot package import of any kind", () => {
    const violations = sources
      .filter(({ source }) => /["']@zedbot\/bot(?:\/|["'])/.test(source))
      .map(({ file }) => path.relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });

  it("has no grammY, Bot handler, keyboard or direct panel-adapter import", () => {
    const forbidden = /["'](?:grammy(?:\/|["'])|@zedbot\/panel-adapters(?:\/|["']))|apps\/bot\/src\/(?:handlers|keyboards)/;
    const violations = sources
      .filter(({ source }) => forbidden.test(source))
      .map(({ file }) => path.relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });

  it("routes through the shared commerce authority", () => {
    const routes = readFileSync(path.join(API_SRC, "miniapp/commerce/routes.ts"), "utf8");
    expect(routes).toContain('from "@zedbot/service-renewal"');
    for (const authority of [
      "createPurchaseCheckout",
      "createOperationCheckout",
      "issueQuoteForCheckout",
      "settleWalletOrder",
    ]) {
      expect(routes).toContain(authority);
    }
  });
});

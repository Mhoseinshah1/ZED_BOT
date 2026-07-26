import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import { createLogger, optionalEnv } from "@zedbot/shared";
import type { FastifyInstance } from "fastify";

const logger = createLogger("api");

// =============================================================================
// Serving the Mini App bundle from the API process.
//
// SAME ORIGIN is the point. The session cookie is scoped to /api/miniapp and
// marked SameSite=Lax, and the frontend calls the API with relative paths - all
// of which only works because the page and the API answer on one origin. A
// separate static host would mean SameSite=None, a CORS policy and a
// cross-origin cookie, three things this design exists to avoid.
//
// Serving from the API process rather than from Nginx's filesystem also keeps
// the deployment honest: the bundle ships INSIDE the image that serves it, so
// the HTML and the API it talks to are always the same build. A shared volume
// between two containers is exactly how a stale index.html ends up calling an
// endpoint that no longer exists.
//
// Caching is split, and the split is what makes it safe:
//
//   * index.html      -> no-store. It names the current hashed bundles; a cached
//                        copy would keep pointing at files a deploy deleted.
//   * assets/*-<hash> -> immutable, one year. The name changes whenever the
//                        content does, so a stale copy is impossible by
//                        construction and no purge is ever needed.
// =============================================================================

/** Where the built bundle lands inside the runtime image. */
const MINIAPP_DIST_ENV = "MINIAPP_DIST_DIR";

const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Resolves the directory holding the built Mini App.
 *
 * The env override exists for the Docker image, where the bundle is copied to a
 * fixed path rather than sitting next to the API's source tree. The relative
 * fallback is what a developer gets after `pnpm --filter @zedbot/miniapp build`.
 */
export function resolveMiniAppDist(): string | null {
  const configured = optionalEnv(MINIAPP_DIST_ENV, "").trim();
  const candidates =
    configured !== ""
      ? [configured]
      : [
          // .../apps/api/{dist,src}/miniapp/ -> up three -> apps/miniapp/dist.
          // The same relative path holds for the compiled image and for a
          // developer running the source through tsx.
          fileURLToPath(new URL("../../../miniapp/dist", import.meta.url)),
        ];
  for (const candidate of candidates) {
    if (existsSync(`${candidate}/index.html`)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Registers the static routes, or logs and returns if there is nothing built.
 *
 * A missing bundle is NOT fatal. The API's job is the payment callbacks and the
 * Mini App JSON; refusing to boot because a frontend was not built would take
 * down webhooks over a cosmetic problem.
 */
export async function miniAppStaticRoutes(app: FastifyInstance): Promise<void> {
  const root = resolveMiniAppDist();
  if (root === null) {
    logger.info("mini app bundle not found; /miniapp will not be served");
    return;
  }

  await app.register(fastifyStatic, {
    root,
    prefix: "/miniapp/",
    // Serving index.html for a bare directory request is handled explicitly
    // below so its Cache-Control is never the asset one.
    index: false,
    // No directory listing: the bundle's file names are not a public index.
    list: false,
    // Dotfiles have no business in a built bundle; refuse rather than serve.
    dotfiles: "deny",
    setHeaders: (response, path) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (path.endsWith("index.html")) {
        response.setHeader("Cache-Control", "no-store");
        return;
      }
      // Everything under assets/ carries a content hash in its name.
      response.setHeader("Cache-Control", `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
    },
  });

  // The SPA entry. Registered for the prefix itself and for the unslashed
  // form so /miniapp and /miniapp/ both land on the app.
  //
  // There is NO catch-all fallback here. The frontend has no client-side
  // router - navigation is component state - so a wildcard would only serve
  // HTML for paths that should honestly 404, and it would happily answer
  // /miniapp/api/... with an HTML page, which is precisely the path-confusion
  // shape the Nginx configuration is written to prevent.
  const sendIndex = async (
    _request: unknown,
    reply: { header: (k: string, v: string) => unknown; sendFile: (f: string) => unknown },
  ): Promise<unknown> => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.sendFile("index.html");
  };
  app.get("/miniapp", sendIndex);
  app.get("/miniapp/", sendIndex);

  logger.info("mini app bundle served under /miniapp");
}

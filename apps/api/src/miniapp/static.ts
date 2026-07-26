import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import { createLogger, optionalEnv } from "@zedbot/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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
    // `wildcard: false` makes the plugin register ONE route per file that
    // actually exists in the bundle, instead of claiming /miniapp/* wholesale.
    // That is what leaves the wildcard free below - and it is what makes the
    // difference between "this asset is missing" and "this is a frontend
    // route" decidable by the router rather than guessed by a handler.
    wildcard: false,
    // Serving index.html for a bare directory request is handled explicitly
    // below so its Cache-Control is never the asset one.
    index: false,
    // No directory listing: the bundle's file names are not a public index.
    list: false,
    // Dotfiles have no business in a built bundle; refuse rather than serve.
    dotfiles: "deny",
    // The plugin's own Cache-Control would be `public, max-age=0` and would
    // land alongside - not behind - the values set below. Turning it off makes
    // `setHeaders` the single writer, so what this file says is what ships.
    cacheControl: false,
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

  const sendIndex = async (_request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.sendFile("index.html");
  };

  // /miniapp and /miniapp/ both open the app.
  app.get("/miniapp", sendIndex);
  app.get("/miniapp/", sendIndex);

  // The SPA fallback, and the three things it deliberately refuses.
  //
  // A blanket "serve index.html for anything under /miniapp" is the usual
  // shape, and it is wrong in ways that matter here:
  //
  //   * a missing hashed asset would answer 200 with HTML. The browser would
  //     then try to execute a document as JavaScript, and the actual problem -
  //     a half-deployed bundle - would look like a mystifying syntax error
  //     instead of a 404.
  //   * /miniapp/api/... would answer with a page, which is exactly the
  //     path-confusion shape the Nginx location is written to prevent. Refused
  //     here too, so the guarantee does not depend on the edge alone.
  //   * a traversal attempt would be answered rather than rejected. Nothing can
  //     escape the root (the only file this handler ever sends is a fixed
  //     name), but a 404 states the refusal instead of hiding it behind a 200.
  app.get<{ Params: { "*": string } }>("/miniapp/*", async (request, reply) => {
    const rest = request.params["*"] ?? "";
    const decoded = safeDecode(rest);
    if (decoded === null || decoded.split("/").some((segment) => segment === "..")) {
      return reply.code(404).type("application/json").send({ ok: false, code: "NOT_FOUND" });
    }
    if (decoded === "api" || decoded.startsWith("api/")) {
      return reply.code(404).type("application/json").send({ ok: false, code: "NOT_FOUND" });
    }
    // A final segment containing a dot is a FILE request - an extension of any
    // length, or a dotfile. Reaching the fallback means the router found no
    // such file among the bundle's real ones, so it is an honest 404. Frontend
    // routes are path segments without dots (`/miniapp/services/<uuid>`), so
    // nothing legitimate is caught by this.
    const last = decoded.split("/").pop() ?? "";
    if (last.includes(".")) {
      return reply.code(404).type("application/json").send({ ok: false, code: "NOT_FOUND" });
    }
    return sendIndex(request, reply);
  });

  logger.info("mini app bundle served under /miniapp");
}

/** Percent-decoding that reports malformed input rather than throwing. */
function safeDecode(raw: string): string | null {
  try {
    // Twice: an encoded-encoded traversal ("%252e%252e") decodes to "%2e%2e"
    // on the first pass, which is still a traversal attempt and must be caught
    // rather than passed through as an innocuous-looking literal.
    const once = decodeURIComponent(raw);
    return decodeURIComponent(once.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  } catch {
    return null;
  }
}

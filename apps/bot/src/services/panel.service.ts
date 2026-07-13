import { PanelStatus, prisma, type Panel, type PanelType, type Prisma } from "@zedbot/database";

export const PANELS_PAGE_SIZE = 8;

export interface CreatePanelInput {
  type: PanelType;
  name: string;
  baseUrl: string;
  username?: string | null;
  passwordEncrypted?: string | null;
  tokenEncrypted?: string | null;
  /** XUI only: "SESSION_COOKIE" | "API_TOKEN" (null = SESSION_COOKIE). */
  authMode?: string | null;
}

/** Creates a panel with schema defaults and the next display order. */
export async function createPanel(input: CreatePanelInput): Promise<Panel> {
  const last = await prisma.panel.findFirst({
    orderBy: { displayOrder: "desc" },
    select: { displayOrder: true },
  });
  return prisma.panel.create({
    data: {
      type: input.type,
      name: input.name,
      baseUrl: input.baseUrl,
      username: input.username ?? null,
      passwordEncrypted: input.passwordEncrypted ?? null,
      tokenEncrypted: input.tokenEncrypted ?? null,
      authMode: input.authMode ?? null,
      status: PanelStatus.ACTIVE,
      isVisible: true,
      displayOrder: (last?.displayOrder ?? 0) + 1,
    },
  });
}

export interface PanelListPage {
  panels: Panel[];
  page: number;
  pages: number;
  total: number;
}

/** Fix C: optional status filter - "a" ACTIVE panels, "i" everything else. */
export type PanelListFilter = "a" | "i";

export async function listPanels(page: number, filter?: PanelListFilter): Promise<PanelListPage> {
  const where: Prisma.PanelWhereInput =
    filter === "a"
      ? { status: PanelStatus.ACTIVE }
      : filter === "i"
        ? { status: { not: PanelStatus.ACTIVE } }
        : {};
  const total = await prisma.panel.count({ where });
  const pages = Math.max(1, Math.ceil(total / PANELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const panels = await prisma.panel.findMany({
    where,
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    skip: (safePage - 1) * PANELS_PAGE_SIZE,
    take: PANELS_PAGE_SIZE,
  });
  return { panels, page: safePage, pages, total };
}

/** Linked-product count for the panel list/detail (read-only). */
export async function countPanelProducts(panelId: string): Promise<number> {
  return prisma.product.count({ where: { panelId } });
}

export async function getPanelById(id: string): Promise<Panel | null> {
  return prisma.panel.findUnique({ where: { id } });
}

/**
 * Resolves a panel from the 8-char short id used in callback data (Telegram
 * limits callback data to 64 bytes, full UUIDs would not fit alongside the
 * action). UUID prefixes are unique enough at panel scale; ambiguity returns
 * null instead of guessing.
 */
export async function getPanelByShortId(shortId: string): Promise<Panel | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.panel.findMany({
    where: { id: { startsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function panelShortId(panel: Pick<Panel, "id">): string {
  return panel.id.slice(0, 8);
}

export async function updatePanel(id: string, data: Prisma.PanelUpdateInput): Promise<Panel> {
  return prisma.panel.update({ where: { id }, data });
}

/**
 * "Delete" without losing history: the row is kept (services/orders will
 * reference it in later phases), the panel just becomes inactive + hidden.
 */
export async function softDeletePanel(id: string): Promise<Panel> {
  return prisma.panel.update({
    where: { id },
    data: { status: PanelStatus.INACTIVE, isVisible: false },
  });
}

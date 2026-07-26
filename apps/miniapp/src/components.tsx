import type { ReactNode } from "react";

import type { ApiFailure } from "./api";
import { formatBytes, formatDate, formatNumber, usagePercent } from "./format";
import { FAILURE_TEXT, lookup, SERVICE_STATUS_TEXT, UI } from "./i18n";
import { openInTelegram } from "./telegram";

// =============================================================================
// Presentational pieces shared by the screens.
//
// Everything renders through JSX text nodes, so React escapes it. Nothing here
// touches `dangerouslySetInnerHTML`, and nothing builds markup by
// concatenation - which matters because service names, notes and panel labels
// are operator- and buyer-authored strings.
// =============================================================================

export function Card(props: { title?: string; children: ReactNode }): ReactNode {
  return (
    <section className="card">
      {props.title !== undefined ? <h2 className="card__title">{props.title}</h2> : null}
      {props.children}
    </section>
  );
}

export function Row(props: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="row">
      <span className="row__key">{props.label}</span>
      <span className="row__value">{props.value}</span>
    </div>
  );
}

export function Spinner(props: { label?: string }): ReactNode {
  return (
    <div className="center">
      <div className="spinner" role="status" aria-label={props.label ?? UI.loading} />
      <p className="center__body">{props.label ?? UI.loading}</p>
    </div>
  );
}

export function StatusBadge(props: { status: string }): ReactNode {
  const modifier =
    props.status === "ACTIVE"
      ? "badge--active"
      : props.status === "EXPIRED" || props.status === "FAILED" || props.status === "DELETED"
        ? "badge--danger"
        : props.status === "LIMITED" || props.status === "DISABLED"
          ? "badge--warning"
          : "";
  return <span className={`badge ${modifier}`}>{lookup(SERVICE_STATUS_TEXT, props.status)}</span>;
}

export function UsageBar(props: { used: string; total: string }): ReactNode {
  const percent = usagePercent(props.used, props.total);
  const unlimited = props.total === "0";
  return (
    <div className="usage">
      <div className="usage__track">
        <div
          className="usage__fill"
          style={{ width: unlimited ? "0%" : `${percent}%` }}
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <div className="usage__legend">
        <span>{`${UI.used}: ${formatBytes(props.used)}`}</span>
        <span>{unlimited ? "نامحدود" : `${UI.volume}: ${formatBytes(props.total)}`}</span>
      </div>
    </div>
  );
}

export function ServiceCard(props: {
  service: {
    id: string;
    username: string;
    status: string;
    productName: string | null;
    panelName: string | null;
    usedBytes: string;
    volumeBytes: string;
    expiresAt: string | null;
  };
  onOpen: (id: string) => void;
}): ReactNode {
  const { service } = props;
  return (
    <button type="button" className="card card--tappable" onClick={() => props.onOpen(service.id)}>
      <div className="row">
        <span className="row__value">{service.productName ?? service.username}</span>
        <StatusBadge status={service.status} />
      </div>
      <div className="txn__meta">
        {service.panelName ?? "—"} · {service.username}
      </div>
      <UsageBar used={service.usedBytes} total={service.volumeBytes} />
      <div className="usage__legend">
        <span>{UI.expiresAt}</span>
        <span>{service.expiresAt === null ? UI.neverExpires : formatDate(service.expiresAt)}</span>
      </div>
    </button>
  );
}

/**
 * The bot's public link.
 *
 * `VITE_BOT_USERNAME` is the ONLY build-time value this app reads, and it is a
 * public handle - the same one printed on every message the bot sends. No
 * token, no panel address and no secret is ever compiled into the bundle: the
 * bundle is one artifact served to everyone, so anything inside it is public by
 * definition.
 */
export function botLink(): string | null {
  const raw = import.meta.env.VITE_BOT_USERNAME;
  if (typeof raw !== "string") {
    return null;
  }
  const handle = raw.trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{4,32}$/.test(handle) ? `https://t.me/${handle}` : null;
}

/**
 * The one screen every failure lands on.
 *
 * It renders a code, never a server message, and it offers "open the bot" only
 * for the gates the bot can actually clear - terms and channel membership -
 * plus the account states where support lives there. Retrying is offered only
 * where retrying could plausibly work.
 */
export function FailureScreen(props: { failure: ApiFailure; onRetry?: () => void }): ReactNode {
  const text = FAILURE_TEXT[props.failure.code];
  const link = botLink();
  const showBotAction = text.action !== undefined && link !== null;
  return (
    <div className="center">
      <h1 className="center__title">{text.title}</h1>
      <p className="center__body">{text.body}</p>
      <div className="center__actions">
        {showBotAction ? (
          <button type="button" className="button" onClick={() => openInTelegram(link)}>
            {text.action}
          </button>
        ) : null}
        {text.retryable && props.onRetry !== undefined ? (
          <button
            type="button"
            className={showBotAction ? "button button--ghost" : "button"}
            onClick={props.onRetry}
          >
            {UI.retry}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Stat(props: { value: number; label: string }): ReactNode {
  return (
    <div className="stat">
      <div className="stat__value">{formatNumber(props.value)}</div>
      <div className="stat__label">{props.label}</div>
    </div>
  );
}

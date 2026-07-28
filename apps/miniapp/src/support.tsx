import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  createSupportTicket,
  fetchServices,
  fetchSupportMessages,
  fetchSupportSummary,
  fetchSupportTicket,
  fetchSupportTickets,
  newClientRequestId,
  replySupportTicket,
  type ApiFailure,
  type MessageDto,
  type ServiceSummaryDto,
  type SupportSummaryDto,
  type TicketDetailDto,
  type TicketSummaryDto,
} from "./api";
import { botLink, Card, FailureScreen, Row, Spinner, Stat } from "./components";
import { formatDate, toPersianDigits } from "./format";
import {
  FAILURE_TEXT,
  lookup,
  SERVICE_STATUS_TEXT,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_TEXT,
  SUPPORT_CATEGORY_WANTS_SERVICE,
  TICKET_SENDER_TEXT,
  TICKET_STATUS_TEXT,
  TICKET_WAITING_TEXT,
  UI,
  type SupportCategoryCode,
} from "./i18n";
import { useResource } from "./screens";
import { openInTelegram } from "./telegram";

// =============================================================================
// The Support Centre — the ONE part of this app that writes.
//
// Everything in `screens.tsx` is a read. This file is deliberately separate
// because the rules are different here, and mixing the two would let a reader
// assume the read-only guarantees still hold on a screen that posts.
//
// Three properties hold every line below:
//
//   TEXT ONLY. There is no upload control and no attachment download, because
//   there is no endpoint for either. `hasAttachments` is a boolean — no file
//   id, no name, no size — and the only thing this app does with it is say a
//   file exists and hand off to the bot, where the delivery flow already knows
//   who may read it. A download here would mean re-deciding that question in a
//   second place, and the second answer eventually differs from the first.
//
//   ONE KEY PER SUBMISSION. Every write carries a `clientRequestId` minted
//   ONCE per draft and REUSED VERBATIM on every retry. That is the entire
//   point: after a timeout the client cannot know whether the ticket was
//   created, and a retry that minted a fresh key would open a second one. The
//   server's idempotency record only protects a client that replays the key.
//
//   THE SERVER IS AUTHORITATIVE. The length checks here mirror the domain's
//   bounds so a user is told about a 4000-character message before they wait
//   for a round trip — they do not replace the server's checks, and a failure
//   code always wins over what this file believed.
//
// NOTHING IS PERSISTED. Drafts, idempotency keys and navigation are React
// state and die with the component. A draft in `localStorage` would be a copy
// of a user's support text sitting in a store any script on the page can read.
// =============================================================================

/** Mirrors `TICKET_SUBJECT_MIN/MAX` in `packages/support-tickets/contract.ts`. */
const SUBJECT_MIN = 3;
const SUBJECT_MAX = 100;
/** Mirrors `TICKET_MESSAGE_MIN/MAX`. */
const MESSAGE_MIN = 1;
const MESSAGE_MAX = 3000;

// --- shared pieces -----------------------------------------------------------

/**
 * A ticket's lifecycle state.
 *
 * Not `StatusBadge` from `components.tsx`: that one is wired to the SERVICE
 * status vocabulary, and feeding it a ticket status would render the raw code.
 */
function TicketStatusBadge(props: { status: string }): ReactNode {
  const modifier =
    props.status === "CLOSED"
      ? "badge--danger"
      : props.status === "WAITING_USER" || props.status === "ANSWERED"
        ? "badge--warning"
        : "badge--active";
  return <span className={`badge ${modifier}`}>{lookup(TICKET_STATUS_TEXT, props.status)}</span>;
}

/**
 * An inline failure, for a write that failed on a screen that still has state
 * worth keeping.
 *
 * The full-screen `FailureScreen` is wrong here: it would throw away a draft
 * the user just typed to show them a retry button. This renders the same
 * locally-authored Persian text next to the form instead.
 */
function InlineFailure(props: { failure: ApiFailure }): ReactNode {
  const text = FAILURE_TEXT[props.failure.code];
  return (
    <div className="form__error" role="alert">
      <strong className="form__error-title">{text.title}</strong>
      <span>{text.body}</span>
    </div>
  );
}

/** A validation message the client produced, before any request went out. */
function InlineHint(props: { text: string }): ReactNode {
  return (
    <p className="form__hint" role="alert">
      {props.text}
    </p>
  );
}

function subjectError(raw: string): string | null {
  const clean = raw.trim();
  if (clean.length < SUBJECT_MIN) {
    return UI.supportSubjectTooShort;
  }
  return clean.length > SUBJECT_MAX ? UI.supportSubjectTooLong : null;
}

function messageError(raw: string): string | null {
  const clean = raw.trim();
  if (clean.length < MESSAGE_MIN) {
    return UI.supportMessageTooShort;
  }
  return clean.length > MESSAGE_MAX ? UI.supportMessageTooLong : null;
}

function counter(value: string, max: number): string {
  return `${toPersianDigits(String(value.trim().length))}/${toPersianDigits(String(max))} ${UI.supportCharacterCount}`;
}

// --- 1. landing --------------------------------------------------------------

export function SupportScreen(props: {
  onOpenTickets: () => void;
  onOpenTicket: (id: string) => void;
  onNewTicket: () => void;
}): ReactNode {
  const { state, reload } = useResource<{
    summary: SupportSummaryDto;
    recentTickets: TicketSummaryDto[];
  }>(fetchSupportSummary);
  if (state.phase === "loading") {
    return <Spinner label={UI.loading} />;
  }
  if (state.phase === "failed") {
    return <FailureScreen failure={state.failure} onRetry={reload} />;
  }
  const { summary, recentTickets } = state.data;
  return (
    <>
      {/*
        FOUR COUNTS, and the two in the middle are the point. "Open" was one
        number for two very different situations — a ticket the team owes a
        reply on and a ticket waiting on the user — and the second is the only
        one a person can act on. They are split so the screen can say so.
      */}
      <div className="stats stats--pair">
        <Stat value={summary.total} label={UI.supportTicketsTotal} />
        <Stat value={summary.waitingSupport} label={UI.supportTicketsWaitingSupport} />
        <Stat value={summary.waitingUser} label={UI.supportTicketsWaitingUser} />
        <Stat value={summary.closed} label={UI.supportTicketsClosed} />
      </div>

      <button type="button" className="button" onClick={props.onNewTicket}>
        {UI.supportNewTicket}
      </button>

      {/*
        The newest few, from the SAME response as the counts, so the two halves
        of this screen can never describe different moments.
      */}
      {recentTickets.length === 0 ? (
        <p className="empty">{UI.supportEmpty}</p>
      ) : (
        <Card title={UI.supportRecentTitle}>
          {recentTickets.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} onOpen={props.onOpenTicket} />
          ))}
        </Card>
      )}

      <button type="button" className="button button--ghost" onClick={props.onOpenTickets}>
        {UI.supportOpenList}
      </button>

      <p className="notice">{UI.supportWriteNotice}</p>
    </>
  );
}

// --- 2. ticket list ----------------------------------------------------------

export function SupportTicketsScreen(props: {
  onOpenTicket: (id: string) => void;
  onNewTicket: () => void;
}): ReactNode {
  const [items, setItems] = useState<TicketSummaryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPage = useCallback(async (after: string | null, reset: boolean) => {
    setLoading(true);
    const result = await fetchSupportTickets(after);
    setLoading(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(null);
    // Appended, never merged by id: the keyset cursor guarantees the next page
    // starts strictly after the last row shown, so pages cannot overlap.
    setItems((previous) => (reset ? result.items : [...previous, ...result.items]));
    setCursor(result.nextCursor);
    setDone(result.nextCursor === null);
  }, []);

  useEffect(() => {
    void loadPage(null, true);
  }, [loadPage]);

  if (failure !== null && items.length === 0) {
    return <FailureScreen failure={failure} onRetry={() => void loadPage(null, true)} />;
  }
  if (loading && items.length === 0) {
    return <Spinner label={UI.loading} />;
  }
  return (
    <>
      {items.length === 0 ? (
        <p className="empty">{UI.supportEmpty}</p>
      ) : (
        items.map((ticket) => (
          <TicketCard key={ticket.id} ticket={ticket} onOpen={props.onOpenTicket} />
        ))
      )}
      {!done ? (
        <button
          type="button"
          className="button button--ghost"
          disabled={loading}
          onClick={() => void loadPage(cursor, false)}
        >
          {loading ? UI.loading : UI.loadMore}
        </button>
      ) : null}
      {failure !== null ? <InlineFailure failure={failure} /> : null}
      <button type="button" className="button" onClick={props.onNewTicket}>
        {UI.supportNewTicket}
      </button>
    </>
  );
}

/**
 * One row of the list — and the ONLY component that renders a ticket summary,
 * so the landing preview and the full list cannot show different fields.
 *
 * Every value here comes from the eight the server sends. There is nothing else
 * to render: no database id, no panel, no origin. `waitingParty` is displayed
 * as the server sent it rather than re-derived from `status`, and the linked
 * service is a public id with a name — never an internal handle.
 */
function TicketCard(props: {
  ticket: TicketSummaryDto;
  onOpen: (id: string) => void;
}): ReactNode {
  const { ticket } = props;
  return (
    <button type="button" className="card card--tappable" onClick={() => props.onOpen(ticket.id)}>
      <div className="row">
        <span className="row__value">{ticket.subject ?? UI.supportNoSubject}</span>
        <TicketStatusBadge status={ticket.status} />
      </div>
      <div className="txn__meta">
        {ticket.category === null ? "—" : lookup(SUPPORT_CATEGORY_TEXT, ticket.category)} ·{" "}
        {toPersianDigits(ticket.id)}
      </div>
      {ticket.waitingParty === null ? null : (
        <div className="txn__meta">{lookup(TICKET_WAITING_TEXT, ticket.waitingParty)}</div>
      )}
      {ticket.service === null ? null : (
        <div className="usage__legend">
          <span>{UI.supportRelatedService}</span>
          <span>{serviceLabel(ticket.service)}</span>
        </div>
      )}
      <div className="usage__legend">
        <span>{UI.supportOpenedAt}</span>
        <span>{formatDate(ticket.createdAt)}</span>
      </div>
      <div className="usage__legend">
        <span>{UI.supportUpdatedAt}</span>
        <span>{formatDate(ticket.updatedAt)}</span>
      </div>
    </button>
  );
}

/**
 * How a linked service is named on screen.
 *
 * The account name the user logs in with, then its public id — the same pair
 * the bot shows, so "which one is this?" has one answer across both surfaces.
 * The id is a PUBLIC short id; the Mini App never receives the other kind.
 */
function serviceLabel(service: { id: string; label: string }): string {
  return `${service.label} · ${toPersianDigits(service.id)}`;
}

// --- 3. ticket detail --------------------------------------------------------

export function SupportTicketScreen(props: { ticketId: string }): ReactNode {
  const load = useCallback(() => fetchSupportTicket(props.ticketId), [props.ticketId]);
  const { state, reload } = useResource<{ ticket: TicketDetailDto }>(load);
  /**
   * The server's own fresher copy, when a reply produced one.
   *
   * A reply returns the whole ticket — status, `canReply`, `closedAt` — so the
   * screen adopts it rather than guessing at what changed.
   */
  const [fresher, setFresher] = useState<TicketDetailDto | null>(null);
  /**
   * Set when a reply came back `TICKET_CLOSED`.
   *
   * That response IS the server stating the ticket is closed, so the reply box
   * goes away immediately rather than after the refetch lands — and it stays
   * away for this screen's whole life even if a stale read says otherwise.
   */
  const [closedByServer, setClosedByServer] = useState(false);
  /** Bumped to remount the thread, so a new reply is actually fetched. */
  const [threadNonce, setThreadNonce] = useState(0);

  if (state.phase === "loading") {
    return <Spinner label={UI.loading} />;
  }
  if (state.phase === "failed") {
    return <FailureScreen failure={state.failure} onRetry={reload} />;
  }

  const ticket = fresher ?? state.data.ticket;
  const canReply = ticket.canReply && !closedByServer;
  const link = botLink();

  return (
    <>
      <Card>
        <div className="row">
          <span className="row__value">{ticket.subject ?? UI.supportNoSubject}</span>
          <TicketStatusBadge status={ticket.status} />
        </div>
        <div className="rows">
          <Row label={UI.supportTicketId} value={toPersianDigits(ticket.id)} />
          <Row
            label={UI.supportCategory}
            value={ticket.category === null ? "—" : lookup(SUPPORT_CATEGORY_TEXT, ticket.category)}
          />
          <Row label={UI.supportOpenedAt} value={formatDate(ticket.createdAt)} />
          <Row label={UI.supportUpdatedAt} value={formatDate(ticket.updatedAt)} />
          {ticket.closedAt === null ? null : (
            <Row label={UI.supportClosedAt} value={formatDate(ticket.closedAt)} />
          )}
          {ticket.service === null ? null : (
            <Row label={UI.supportRelatedService} value={serviceLabel(ticket.service)} />
          )}
        </div>
      </Card>

      {/*
        The attachment hand-off. An indicator and a way into the bot — never a
        link to a file, because no route serves one and this app is never told
        which file it would be.
      */}
      {ticket.hasAttachments ? (
        <Card title={UI.supportAttachmentsTitle}>
          <p className="support__attachment-body">{UI.supportAttachmentsBody}</p>
          {link === null ? (
            <p className="notice">{UI.botActionsUnavailable}</p>
          ) : (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => openInTelegram(link)}
            >
              {UI.supportAttachmentsAction}
            </button>
          )}
        </Card>
      ) : null}

      <TicketThread key={threadNonce} ticketId={props.ticketId} />

      {canReply ? (
        <ReplyBox
          ticketId={props.ticketId}
          onReplied={(updated) => {
            setFresher(updated);
            setThreadNonce((n) => n + 1);
          }}
          onTicketClosed={() => {
            setClosedByServer(true);
            setFresher(null);
            // Drop the copy from the last successful reply BEFORE refetching:
            // it is older than the fact just received, and leaving it in place
            // would let it outrank the reconciling read below.
            // Reconcile the rest of the screen — status, `closedAt` — with the
            // server rather than inventing values to match the one fact it gave.
            reload();
          }}
        />
      ) : (
        <p className="notice">{UI.supportClosedNotice}</p>
      )}
    </>
  );
}

/**
 * One ticket's messages.
 *
 * Pages arrive OLDEST-FIRST but the cursor walks BACKWARDS, so each further
 * page is older than everything on screen and is PREPENDED. Appending would
 * put the oldest messages at the bottom of the thread.
 */
function TicketThread(props: { ticketId: string }): ReactNode {
  const [items, setItems] = useState<KeyedMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const { ticketId } = props;
  const mintKey = useLocalKeys();

  const loadPage = useCallback(
    async (older: string | null, reset: boolean) => {
      setLoading(true);
      const result = await fetchSupportMessages(ticketId, older);
      setLoading(false);
      if (!result.ok) {
        setFailure(result);
        return;
      }
      setFailure(null);
      // KEYS ARE MINTED HERE, as the page is ingested. The server sends no
      // message identifier at all, and React only needs a value that is stable
      // for as long as this list is mounted — which a counter is, and which a
      // database id was never needed for.
      const keyed = result.items.map((message) => ({ key: mintKey(), message }));
      setItems((previous) => (reset ? keyed : [...keyed, ...previous]));
      setCursor(result.nextCursor);
      setDone(result.nextCursor === null);
    },
    [mintKey, ticketId],
  );

  useEffect(() => {
    void loadPage(null, true);
  }, [loadPage]);

  return (
    <Card title={UI.supportThread}>
      {!done && items.length > 0 ? (
        <button
          type="button"
          className="button button--ghost"
          disabled={loading}
          onClick={() => void loadPage(cursor, false)}
        >
          {loading ? UI.loading : UI.supportLoadOlder}
        </button>
      ) : null}
      {loading && items.length === 0 ? (
        <Spinner label={UI.loading} />
      ) : items.length === 0 ? (
        <p className="empty">{UI.supportNoMessages}</p>
      ) : (
        <div className="thread">
          {items.map((entry) => (
            <MessageBubble key={entry.key} message={entry.message} />
          ))}
        </div>
      )}
      {failure !== null ? <InlineFailure failure={failure} /> : null}
    </Card>
  );
}

/** A message and the render key this component gave it. */
interface KeyedMessage {
  key: string;
  message: MessageDto;
}

/**
 * React keys for a list whose rows have no identifier.
 *
 * A monotonic counter in a ref. Every message ever ingested by THIS mounted
 * thread gets a distinct key, and a key never changes once assigned — which is
 * exactly and only what React asks of a key.
 *
 * The alternatives are all worse. A server-sent uuid prefix put part of a
 * primary key on the wire for a purpose that never needed one. The array index
 * would be wrong here specifically: older pages are PREPENDED, so every
 * existing row's index shifts on each "load older" and React would treat the
 * whole thread as changed. `createdAt` is not unique — two messages can share a
 * millisecond — and a duplicate key silently drops a message from the DOM.
 *
 * A ref, not `useState`: keys are minted during a state update and must not
 * schedule another render to do it.
 */
function useLocalKeys(): () => string {
  const next = useRef(0);
  return useCallback(() => {
    next.current += 1;
    return `m${next.current}`;
  }, []);
}

function MessageBubble(props: { message: MessageDto }): ReactNode {
  const { message } = props;
  const mine = message.senderType === "USER";
  return (
    <div className={`message ${mine ? "message--mine" : "message--theirs"}`}>
      <div className="message__meta">
        <span>{lookup(TICKET_SENDER_TEXT, message.senderType)}</span>
        <span>{formatDate(message.createdAt)}</span>
      </div>
      {message.text === null || message.text === "" ? null : (
        <p className="message__text">{message.text}</p>
      )}
      {/*
        Presence, not a link. The server sends a boolean and nothing else, so
        there is no id here that could become a download even by accident.
      */}
      {message.hasAttachment ? (
        <p className="message__attachment">{UI.supportMessageHasAttachment}</p>
      ) : null}
    </div>
  );
}

// --- 4. the reply box --------------------------------------------------------

function ReplyBox(props: {
  ticketId: string;
  onReplied: (ticket: TicketDetailDto) => void;
  onTicketClosed: () => void;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const requestId = useIdempotencyKey();

  const send = async (): Promise<void> => {
    const problem = messageError(draft);
    if (problem !== null) {
      setHint(problem);
      return;
    }
    setHint(null);
    setBusy(true);
    setAttempted(true);
    const result = await replySupportTicket(props.ticketId, {
      message: draft.trim(),
      clientRequestId: requestId.current(),
    });
    setBusy(false);
    if (result.ok) {
      // A new draft is a new mutation, so the next one mints its own key.
      requestId.reset();
      setDraft("");
      setAttempted(false);
      setFailure(null);
      props.onReplied(result.ticket);
      return;
    }
    setFailure(result);
    if (result.code === "TICKET_CLOSED") {
      props.onTicketClosed();
      return;
    }
    if (result.code === "IDEMPOTENCY_CONFLICT") {
      // The server says this key is spent on different content. Replaying it
      // can only conflict again, so the next attempt is a genuinely new one.
      requestId.reset();
    }
  };

  return (
    <Card title={UI.supportReplyTitle}>
      <label className="form__label" htmlFor="support-reply">
        {UI.supportReplyTitle}
      </label>
      <textarea
        id="support-reply"
        className="form__textarea"
        rows={4}
        maxLength={MESSAGE_MAX}
        value={draft}
        placeholder={UI.supportReplyPlaceholder}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="form__counter">{counter(draft, MESSAGE_MAX)}</p>
      {hint !== null ? <InlineHint text={hint} /> : null}
      {failure !== null ? <InlineFailure failure={failure} /> : null}
      <button type="button" className="button" disabled={busy} onClick={() => void send()}>
        {busy
          ? UI.supportReplySending
          : failure !== null && attempted
            ? UI.supportReplyRetry
            : UI.supportReplySend}
      </button>
    </Card>
  );
}

// --- 5. the new-ticket wizard ------------------------------------------------

type WizardStep = "category" | "service" | "subject" | "message" | "review";

/** What the wizard remembers about a chosen service — public fields only. */
interface ChosenService {
  /** The PUBLIC short id. This is what gets sent, and it is all we ever hold. */
  id: string;
  label: string;
}

export function SupportNewTicketScreen(props: {
  onCreated: (ticketId: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [step, setStep] = useState<WizardStep>("category");
  const [category, setCategory] = useState<SupportCategoryCode | null>(null);
  const [service, setService] = useState<ChosenService | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const requestId = useIdempotencyKey();

  const submit = async (): Promise<void> => {
    // Re-checked at the moment of submission, not merely on the way in. The
    // review step is the only thing that sends, so it validates rather than
    // trusting that the earlier steps were passed through in order.
    if (category === null) {
      setStep("category");
      return;
    }
    const problem = subjectError(subject) ?? messageError(message);
    if (problem !== null) {
      setHint(problem);
      return;
    }
    setHint(null);
    setBusy(true);
    setAttempted(true);
    const result = await createSupportTicket({
      subject: subject.trim(),
      message: message.trim(),
      category,
      // The PUBLIC id, or nothing. The server resolves it against the
      // authenticated user inside the transaction that writes the ticket, so
      // what this app sends is a request to link, never the link itself.
      serviceId: service === null ? null : service.id,
      clientRequestId: requestId.current(),
    });
    setBusy(false);
    if (result.ok) {
      requestId.reset();
      props.onCreated(result.ticket.id);
      return;
    }
    setFailure(result);
    if (result.code === "IDEMPOTENCY_CONFLICT") {
      requestId.reset();
    }
    if (result.code === "INVALID_SERVICE") {
      // The server refused the link — the service was deleted, retired or was
      // never the caller's. Send them back to the step that can fix it rather
      // than leaving a dead selection on the review screen. The key is NOT
      // reset: the content is unchanged, and a retry of the same mutation must
      // stay the same mutation.
      setStep("service");
    }
  };

  if (step === "category") {
    return (
      <>
        <Card title={UI.supportStepCategory}>
          {SUPPORT_CATEGORIES.map((code) => (
            <button
              key={code}
              type="button"
              className={`button ${category === code ? "" : "button--ghost"}`}
              onClick={() => {
                setCategory(code);
                // A different category can mean a different question about
                // services, so a selection made under the old one is dropped
                // rather than silently carried into the new flow.
                setService(null);
                setStep("service");
              }}
            >
              {lookup(SUPPORT_CATEGORY_TEXT, code)}
            </button>
          ))}
        </Card>
        <button type="button" className="button button--ghost" onClick={props.onCancel}>
          {UI.supportCancel}
        </button>
      </>
    );
  }

  if (step === "service") {
    return (
      <ServiceStep
        category={category}
        selected={service}
        onContinue={(chosen) => {
          setService(chosen);
          setHint(null);
          setFailure(null);
          setStep("subject");
        }}
        onBack={() => {
          setHint(null);
          setStep("category");
        }}
      />
    );
  }

  if (step === "subject") {
    return (
      <>
        <Card title={UI.supportStepSubject}>
          <label className="form__label" htmlFor="support-subject">
            {UI.supportSubjectLabel}
          </label>
          <input
            id="support-subject"
            className="form__input"
            type="text"
            maxLength={SUBJECT_MAX}
            value={subject}
            placeholder={UI.supportSubjectPlaceholder}
            onChange={(event) => setSubject(event.target.value)}
          />
          <p className="form__counter">{counter(subject, SUBJECT_MAX)}</p>
          {hint !== null ? <InlineHint text={hint} /> : null}
        </Card>
        <button
          type="button"
          className="button"
          onClick={() => {
            const problem = subjectError(subject);
            setHint(problem);
            if (problem === null) {
              setStep("message");
            }
          }}
        >
          {UI.supportNext}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setHint(null);
            setStep("service");
          }}
        >
          {UI.supportPrevious}
        </button>
      </>
    );
  }

  if (step === "message") {
    return (
      <>
        <Card title={UI.supportStepMessage}>
          <label className="form__label" htmlFor="support-message">
            {UI.supportMessageLabel}
          </label>
          <textarea
            id="support-message"
            className="form__textarea"
            rows={6}
            maxLength={MESSAGE_MAX}
            value={message}
            placeholder={UI.supportMessagePlaceholder}
            onChange={(event) => setMessage(event.target.value)}
          />
          <p className="form__counter">{counter(message, MESSAGE_MAX)}</p>
          {hint !== null ? <InlineHint text={hint} /> : null}
        </Card>
        <button
          type="button"
          className="button"
          onClick={() => {
            const problem = messageError(message);
            setHint(problem);
            if (problem === null) {
              setStep("review");
            }
          }}
        >
          {UI.supportNext}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setHint(null);
            setStep("subject");
          }}
        >
          {UI.supportPrevious}
        </button>
      </>
    );
  }

  // The review step. Nothing has been sent yet, and nothing will be until the
  // confirmation below is pressed — the previous steps advance state only.
  return (
    <>
      <Card title={UI.supportStepReview}>
        <p className="form__lead">{UI.supportReviewLead}</p>
        <div className="rows">
          <Row
            label={UI.supportCategory}
            value={category === null ? "—" : lookup(SUPPORT_CATEGORY_TEXT, category)}
          />
          {/*
            The linked service, shown as TEXT. `label` is the account username —
            data, not markup — and it is rendered as a child so React escapes
            it; nothing here interpolates it into HTML, a URL or an attribute.
            The id beside it is the public short id, which is also the only one
            this app was ever given.
          */}
          <Row
            label={UI.supportRelatedService}
            value={service === null ? UI.supportServiceNone : serviceLabel(service)}
          />
          <Row label={UI.supportSubjectLabel} value={subject.trim()} />
        </div>
        <p className="form__label">{UI.supportMessageLabel}</p>
        <p className="form__review-message">{message.trim()}</p>
      </Card>
      {hint !== null ? <InlineHint text={hint} /> : null}
      {failure !== null ? <InlineFailure failure={failure} /> : null}
      <button type="button" className="button" disabled={busy} onClick={() => void submit()}>
        {busy ? UI.supportSending : failure !== null && attempted ? UI.supportRetrySend : UI.supportConfirmSend}
      </button>
      <button
        type="button"
        className="button button--ghost"
        disabled={busy}
        onClick={() => {
          setHint(null);
          setStep("message");
        }}
      >
        {UI.supportPrevious}
      </button>
      <button
        type="button"
        className="button button--ghost"
        disabled={busy}
        onClick={props.onCancel}
      >
        {UI.supportCancel}
      </button>
      <p className="notice">{UI.supportWriteNotice}</p>
    </>
  );
}

// --- 6. the service step -----------------------------------------------------

/**
 * "Which service is this about?" — asked once, never demanded.
 *
 * TWO PRESENTATIONS, ONE STEP. For CONNECTION and SERVICE_MANAGEMENT the
 * question is nearly always "which of my accounts", so the list is fetched and
 * shown on arrival. For PAYMENT, ACCOUNT and OTHER it usually is not, so the
 * step OFFERS the link instead: continue, or open the picker. Either way the
 * skip is a first-class button, because the person most likely to need support
 * is the one whose service is broken, missing or expired — refusing them a
 * ticket until they name one would lock out exactly the wrong people.
 *
 * ONLY PUBLIC IDS EXIST HERE. `/services` returns the same 8-character public
 * id the bot shows; this component never sees a database uuid, so it cannot
 * send one, and the server resolves what it does send against the authenticated
 * user inside the transaction that writes the ticket.
 *
 * A LOAD FAILURE IS NOT A DEAD END. If the list cannot be fetched the skip
 * stays, so an outage in one read cannot block the support channel.
 */
function ServiceStep(props: {
  category: SupportCategoryCode | null;
  selected: ChosenService | null;
  /** The ONE way forward. `null` means "no service", which is always allowed. */
  onContinue: (service: ChosenService | null) => void;
  onBack: () => void;
}): ReactNode {
  const wantsService =
    props.category !== null && SUPPORT_CATEGORY_WANTS_SERVICE[props.category];
  const [picking, setPicking] = useState(wantsService);
  /**
   * The DRAFT selection, owned here and handed up only on continue.
   *
   * Seeded from the wizard so returning to this step shows what was chosen, but
   * kept local so tapping around — pick one, change your mind, clear it — never
   * writes to the wizard until the person actually moves on.
   */
  const [chosen, setChosen] = useState<ChosenService | null>(props.selected);
  const [items, setItems] = useState<ServiceSummaryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(async (after: string | null, reset: boolean) => {
    setLoading(true);
    const result = await fetchServices(after);
    setLoading(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(null);
    setItems((previous) => (reset ? result.items : [...previous, ...result.items]));
    setCursor(result.nextCursor);
    setDone(result.nextCursor === null);
  }, []);

  useEffect(() => {
    if (picking) {
      void loadPage(null, true);
    }
  }, [loadPage, picking]);

  return (
    <>
      <Card title={UI.supportStepService}>
        <p className="form__lead">{UI.supportServiceLead}</p>

        {chosen === null ? null : (
          <>
            <div className="rows">
              <Row label={UI.supportRelatedService} value={serviceLabel(chosen)} />
            </div>
            {/* Undoing a choice must be as easy as making one. */}
            <button type="button" className="button button--ghost" onClick={() => setChosen(null)}>
              {UI.supportServiceClear}
            </button>
          </>
        )}

        {!picking ? (
          // The OFFER, for the categories that are usually not about one
          // service. Nothing is fetched until the user asks for the list.
          <button type="button" className="button button--ghost" onClick={() => setPicking(true)}>
            {UI.supportServiceChoose}
          </button>
        ) : loading && items.length === 0 ? (
          <Spinner label={UI.loading} />
        ) : items.length === 0 && failure === null ? (
          <p className="empty">{UI.supportServiceEmpty}</p>
        ) : (
          <>
            {items.map((service) => (
              <button
                key={service.id}
                type="button"
                className={`button ${chosen?.id === service.id ? "" : "button--ghost"}`}
                onClick={() => setChosen({ id: service.id, label: service.username })}
              >
                {`${service.username} · ${lookup(SERVICE_STATUS_TEXT, service.status)}`}
              </button>
            ))}
            {!done && items.length > 0 ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={loading}
                onClick={() => void loadPage(cursor, false)}
              >
                {loading ? UI.loading : UI.loadMore}
              </button>
            ) : null}
          </>
        )}

        {/*
          A failed list does not block the ticket — it is reported inline and
          the continue below still works, with no service attached.
        */}
        {failure !== null ? <InlineFailure failure={failure} /> : null}
      </Card>

      <button type="button" className="button" onClick={() => props.onContinue(chosen)}>
        {chosen === null ? UI.supportServiceSkip : UI.supportNext}
      </button>
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {UI.supportPrevious}
      </button>
    </>
  );
}

// --- 7. the idempotency key --------------------------------------------------

/**
 * One `clientRequestId` per submission, reused across every retry of it.
 *
 * THIS IS WHAT MAKES A RETRY SAFE. A failed write has three outcomes the
 * client cannot tell apart: it never arrived, it arrived and was refused, or it
 * arrived, was applied, and the response was lost. Only the third is dangerous,
 * and only replaying the SAME key protects against it — a fresh key on retry
 * describes a different mutation, so the server dutifully creates a second
 * ticket. Minting once and replaying is therefore not an optimisation; it is
 * the entire mechanism.
 *
 * A ref, not `useState`: the key must be read and written in the SAME tick as
 * the submit that uses it. A queued state update would let two fast taps both
 * read `null`, mint two keys and open two tickets — precisely the failure the
 * key exists to prevent. It is still ordinary in-memory React state: it dies
 * with the component, and nothing writes it to any browser store.
 */
function useIdempotencyKey(): { current: () => string; reset: () => void } {
  const key = useRef<string | null>(null);
  return {
    current: () => {
      if (key.current === null) {
        key.current = newClientRequestId();
      }
      return key.current;
    },
    reset: () => {
      key.current = null;
    },
  };
}

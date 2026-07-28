import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  createSupportTicket,
  fetchSupportMessages,
  fetchSupportSummary,
  fetchSupportTicket,
  fetchSupportTickets,
  newClientRequestId,
  replySupportTicket,
  type ApiFailure,
  type MessageDto,
  type SupportSummaryDto,
  type TicketDetailDto,
  type TicketSummaryDto,
} from "./api";
import { botLink, Card, FailureScreen, Row, Spinner, Stat } from "./components";
import { formatDate, toPersianDigits } from "./format";
import {
  FAILURE_TEXT,
  lookup,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_TEXT,
  TICKET_SENDER_TEXT,
  TICKET_STATUS_TEXT,
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
  onNewTicket: () => void;
}): ReactNode {
  const { state, reload } = useResource<{ summary: SupportSummaryDto }>(fetchSupportSummary);
  if (state.phase === "loading") {
    return <Spinner label={UI.loading} />;
  }
  if (state.phase === "failed") {
    return <FailureScreen failure={state.failure} onRetry={reload} />;
  }
  const summary = state.data.summary;
  return (
    <>
      <div className="stats stats--pair">
        <Stat value={summary.total} label={UI.supportTicketsTotal} />
        <Stat value={summary.open} label={UI.supportTicketsOpen} />
        <Stat value={summary.waitingUser} label={UI.supportTicketsWaitingUser} />
        <Stat value={summary.closed} label={UI.supportTicketsClosed} />
      </div>

      <button type="button" className="button" onClick={props.onNewTicket}>
        {UI.supportNewTicket}
      </button>
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
          {ticket.serviceId === null ? null : (
            <Row label={UI.supportRelatedService} value={toPersianDigits(ticket.serviceId)} />
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
  const [items, setItems] = useState<MessageDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const { ticketId } = props;

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
      setItems((previous) => (reset ? result.items : [...result.items, ...previous]));
      setCursor(result.nextCursor);
      setDone(result.nextCursor === null);
    },
    [ticketId],
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
          {items.map((message) => (
            <MessageBubble key={message.key} message={message} />
          ))}
        </div>
      )}
      {failure !== null ? <InlineFailure failure={failure} /> : null}
    </Card>
  );
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

type WizardStep = "category" | "subject" | "message" | "review";

export function SupportNewTicketScreen(props: {
  onCreated: (ticketId: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [step, setStep] = useState<WizardStep>("category");
  const [category, setCategory] = useState<SupportCategoryCode | null>(null);
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
                setStep("subject");
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
            setStep("category");
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

// --- 6. the idempotency key --------------------------------------------------

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

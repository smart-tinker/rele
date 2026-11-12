# Read-only message trace (issue #6)

The Queue and Delivery links open one local-panel card. Both authenticated GET
`/api/traces/requests/:id` and `/api/traces/deliveries/:id` project existing
records without calling native history, reconnect, reconcile, cancel, resume or
provider send. Refresh repeats only this GET. Existing protected actions remain
on their original pages. The card omits request/answer/error bodies, participants,
credentials, configuration, approval details and unrelated conversation content.

## Identity and limits

A request is selected by its durable Rele ID, never by native thread, event ID or
current binding alone. Deliveries must have that request ID and equal immutable
origin fields: platform, account, endpoint, source chat, source thread, source
message and sender ID. Display names and mutable participants do not establish
identity. Independent agent tool deliveries have no originating request; the
card keeps the request/ingress stages unknown rather than borrowing another
request from the same native thread. Repeated delivery IDs are shown once.
The direct request lookup is not limited by the dashboard's recent-250 window;
all existing delivery rows for that request are considered.

## Data map

| Stage | Existing field / event | Proves | Does not prove / gaps |
| --- | --- | --- | --- |
| Receipt | `inbound_events.request_id`, `created_at` | Rele saved a receipt associated with this request | Messenger completeness, receipt of every message, or failure to receive a message when no row exists |
| Admission / skip | `requests.id`, `created_at`, `status` | A local request was formed; `queued` is waiting in Rele | Historical permission settings and exact skip reason are not retained. Current settings are not used to reconstruct past decisions. No new ingress journal is introduced |
| Native acceptance | `queuedSubmissionId` or `turnId` | Persisted native queue acknowledgement or owned-turn identification | Enqueue timestamp is not separately stored; request `updatedAt` is only the last local record change. A queue ID does not prove a running turn or completed execution |
| Explicit enqueue rejection | New `meta[enqueue-rejected:<requestId>] = ISO timestamp` | This exact failed request revision came from an attempted enqueue returning typed `CodexRpcError`; the marker equals that revision's `updatedAt` | No content, code/message or indefinite event stream is saved. Pre-enqueue errors, lost ACK and old generic `failed` rows are not classified as explicit rejection. Approval decline is a different action |
| Execution | `requests.status`, `turnId`, `updatedAt`; `steeredInto` | Last saved request state. Steering means input was added to another running request | Terminal local request state without a `turnId` is labelled as request state; actual execution remains no-data. Fresh native state and completion of a shared turn are not inferred. `uncertain` remains uncertain even when IDs exist |
| Suppressed final | Existing `suppressed-final:<requestId>` projected as `suppressedFinal` | Successful request intentionally omitted a final answer (NOREPLY) | Delivery is not claimed. Absence of a delivery row alone never means suppression |
| Delivery | `deliveries.request_id`, immutable `origin`, `kind`, `key`, `status`, `remote_message_id`, `updated_at` | Per-part saved state. All saved final-answer parts must be `sent` with provider IDs before the card reports saved receipts | Recipient reading, a fresh provider readback, completeness beyond the persisted final-answer parts, or general transport health. Approval/error/clarification receipts never establish final-answer delivery |
| Uncertain delivery | Any matched final-answer part is `uncertain`; `sending` is in flight | At least one part has unknown or pending outcome | Other sent parts cannot make the whole answer delivered. Safe guidance is to inspect the original chat; no blind retry is offered |
| Disconnect | Current Codex status and selected source connection state with account ID equal to the immutable origin account | Whether the local connection currently reports connected | Previous message receipt/delivery and health of another source. Disconnection does not erase a saved receipt |
| Restored / fresh records | Record `createdAt` versus app `startedAt`; GET `capturedAt` | Whether the record predates this server session and when this projection was captured | A restored record is not a fresh native reconciliation. A current-session record is not fresh end-to-end acceptance either |
| Stale snapshot | Failed refresh or captured snapshot older than 30 seconds | Displayed evidence may be outdated; old data is retained visibly | No failure/completion is inferred from stale data. The card does not silently reconnect, replay or resume anything |

The rejection receipt uses the existing metadata/request lifecycle, without a
new schema or retention stream. Only the terminal enqueue rejection branch writes it, using the failed request revision's `updatedAt`. Shutdown requeues do not record it; a new enqueue attempt clears an older marker. Projection accepts it only for that exact failed revision, so later running, uncertain or generic-failure evidence wins. Read endpoints never write. Legacy failures intentionally remain unclassified.

## Verification boundary

Unit/engine and injected API fixtures cover success, queued/running, explicit
typed rejection versus pre-enqueue failure and uncertain enqueue, multipart
uncertain delivery, suppression, disconnection, duplicate source events,
pre-start records, independent tool messages and two sources sharing a native
thread. The browser fixture checks both entry links, immutable request/source
identity, absence of content/mutation controls, stale refresh, no mutations,
desktop/mobile overflow and screenshot capture.

These fixtures are synthetic. They do not establish Slack/Telegram delivery,
installed-package acceptance, release readiness or recipient reading. Final
commit, command results, screenshots and any FAIL/UNRUN/BLOCKED checks belong
to the PR evidence; issue closure and release acceptance remain separate.

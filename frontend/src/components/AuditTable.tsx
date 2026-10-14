import { useText } from "../i18n/useText";
import { useLanguage } from "../i18n/useLanguage";
import { formatWhen } from "../lib/format-when";
import type { AuditEvent } from "../lib/tenant-admin";

function plain(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(plain).join(", ") || "—";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
  return String(value);
}

/** Readable audit trail: time (in the workspace time zone), action label, actor, record and the main change details. */
export function AuditTable({ events, actors, timeZone, caption }: {
  events: AuditEvent[];
  actors: Map<string, string>;
  timeZone?: string;
  caption: string;
}) {
  const tr = useText();
  const { pick } = useLanguage();
  const detailKeys: Array<[string, string]> = [
    ["code", pick("الرمز", "Code")], ["name", pick("الاسم", "Name")], ["reason", pick("السبب", "Reason")],
    ["before", pick("قبل", "Before")], ["after", pick("بعد", "After")], ["permissions", pick("الصلاحيات", "Permissions")],
    ["settingsKeys", pick("الإعدادات", "Settings")]
  ];
  return (
    <div className="ta-table-wrap">
      <table className="ta-table">
        <caption className="ta-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{pick("الوقت", "Time")}</th>
            <th scope="col">{pick("العملية", "Action")}</th>
            <th scope="col">{pick("المنفذ", "Actor")}</th>
            <th scope="col">{pick("التفاصيل", "Details")}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const meta = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
              ? (event.metadata as Record<string, unknown>) : {};
            const rows = detailKeys.filter(([key]) => meta[key] !== undefined && meta[key] !== null && plain(meta[key]) !== "");
            return (
              <tr key={event.id}>
                <td data-label={pick("الوقت", "Time")}><time dateTime={event.occurredAt}>{formatWhen(event.occurredAt, timeZone)}</time></td>
                <td data-label={pick("العملية", "Action")}>
                  <strong>{tr(event.action)}</strong>
                  <small dir="ltr">{event.entityType}{event.entityId ? ` · ${event.entityId.slice(0, 8)}` : ""}</small>
                </td>
                <td data-label={pick("المنفذ", "Actor")}>
                  {event.actorUserId ? (actors.get(event.actorUserId) ?? <bdi dir="ltr">{event.actorUserId.slice(0, 8)}</bdi>) : pick("النظام", "System")}
                </td>
                <td data-label={pick("التفاصيل", "Details")}>
                  {rows.length ? (
                    <dl className="ta-details">
                      {rows.map(([key, label]) => (
                        <div key={key}><dt>{label}</dt><dd><bdi>{plain(meta[key])}</bdi></dd></div>
                      ))}
                    </dl>
                  ) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

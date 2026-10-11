import { useCallback, useEffect, useState } from "react";
import { api, type Invitation } from "../lib/api";
import { useText } from "../i18n/useText";
import { useLanguage } from "../i18n/useLanguage";

/** Invitations addressed to the signed-in identity. Accepting or declining is the owner's own decision. */
export function InvitationsBanner() {
  const { pick } = useLanguage();
  const tr = useText();
  const [items, setItems] = useState<Invitation[]>([]);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => api.invitations().then(setItems), []);
  useEffect(() => {
    let live = true;
    api.invitations().then((next) => { if (live) setItems(next); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  async function respond(id: string, accept: boolean) {
    setBusyId(id); setError("");
    try {
      await api.respondToInvitation(id, accept);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : pick("تعذر إكمال الطلب", "Unable to complete the request"));
    } finally {
      setBusyId("");
    }
  }

  if (!items.length) return null;
  return (
    <section className="work-panel invitations" aria-label={pick("الدعوات", "Invitations")}>
      <h2>{pick("دعوات بانتظار ردك", "Invitations waiting for your answer")}</h2>
      {error && <p className="form-error" role="alert">{tr(error)}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id} data-testid="invitation">
            <span>{pick(
              `${item.tenant.name}${item.organization ? ` · ${item.organization.nameAr ?? item.organization.name}` : ""}`,
              `${item.tenant.name}${item.organization ? ` · ${item.organization.nameEn ?? item.organization.name}` : ""}`
            )}{item.jobTitle ? ` (${item.jobTitle})` : ""}</span>
            <button className="primary-button" disabled={busyId === item.id} onClick={() => void respond(item.id, true)}>{pick("قبول", "Accept")}</button>
            <button className="ghost-button" disabled={busyId === item.id} onClick={() => void respond(item.id, false)}>{pick("رفض", "Decline")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

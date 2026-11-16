import type { CwMailTemplateKey } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, ErrorBanner, Field, Loading } from "../../components/ui";
import { CW_KEYS, type MailTemplate } from "./api";

const TITLE: Record<CwMailTemplateKey, { label: string; when: string }> = {
  booking_confirmed: { label: "Réservation confirmée", when: "Envoyé quand l'accueil accepte une demande." },
  booking_refused: { label: "Réservation refusée", when: "Envoyé quand l'accueil refuse une demande, avec le motif." },
  booking_cancelled: { label: "Réservation annulée", when: "Envoyé quand l'accueil annule une réservation, avec le motif et les frais éventuels." },
  booking_reminder: { label: "Rappel", when: "Envoyé avant le début, selon le délai choisi dans les règles de réservation." },
};

const PLACEHOLDER_LABEL: Record<string, string> = {
  client: "nom du client",
  espace: "place ou salle",
  date: "date",
  debut: "heure de début",
  fin: "heure de fin",
  montant: "montant à régler",
  options: "options prises",
  lien: "lien vers l'espace client",
  centre: "nom du centre",
  motif: "motif",
  frais: "frais d'annulation",
  code: "code d'arrivée",
};

function TemplateEditor({ template }: { template: MailTemplate }) {
  const client = useQueryClient();
  const toast = useToast();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const area = useRef<HTMLTextAreaElement>(null);
  const changed = subject !== template.subject || body !== template.body;
  const refresh = () => client.invalidateQueries({ queryKey: CW_KEYS.mailTemplates });
  const save = useMutation({
    mutationFn: () => api.put(`/coworking/mail-templates/${template.key}`, { subject, body }),
    onSuccess: async () => {
      await refresh();
      toast("Modèle enregistré.");
    },
  });
  const reset = useMutation({
    mutationFn: () => api.del(`/coworking/mail-templates/${template.key}`),
    onSuccess: async () => {
      setSubject(template.default.subject);
      setBody(template.default.body);
      await refresh();
      toast("Texte par défaut rétabli.");
    },
  });
  /** Inserts a placeholder at the cursor of the message. */
  const insert = (name: string) => {
    const el = area.current;
    const token = `{${name}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart;
    const next = body.slice(0, start) + token + body.slice(el.selectionEnd);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const info = TITLE[template.key];
  return (
    <Card
      title={info.label}
      actions={template.customized ? <Badge tone="blue">Texte du centre</Badge> : <Badge tone="gray">Texte par défaut</Badge>}
      footer={
        <>
          <button type="button" className="btn btn-g" disabled={!template.customized || reset.isPending} onClick={() => reset.mutate()}>
            Rétablir le texte par défaut
          </button>
          <button type="button" className="btn btn-p" disabled={!changed || !subject.trim() || !body.trim() || save.isPending} onClick={() => save.mutate()}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="card-b stack">
        <span className="cap">{info.when}</span>
        <Field label="Objet">
          <input className="input" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" hint="Une ligne dont une variable est vide pour ce client n'est pas envoyée.">
          <textarea ref={area} className="input" rows={12} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className="lab">Insérer</span>
          {template.placeholders.map((p) => (
            <button key={p} type="button" className="btn btn-g" title={PLACEHOLDER_LABEL[p]} onClick={() => insert(p)}>
              {`{${p}}`} <span className="cap">{PLACEHOLDER_LABEL[p]}</span>
            </button>
          ))}
        </div>
        <ErrorBanner error={save.error ?? reset.error} />
      </div>
    </Card>
  );
}

/** The wording of the e-mails sent to clients about their bookings. */
export function MailTemplatesTab() {
  const templates = useQuery({ queryKey: CW_KEYS.mailTemplates, queryFn: () => api.get<MailTemplate[]>("/coworking/mail-templates") });
  if (templates.error) return <ErrorBanner error={templates.error} retry={() => templates.refetch()} />;
  if (templates.isPending) return <Loading />;
  return (
    <>
      {templates.data.map((t) => (
        <TemplateEditor key={`${t.key}-${t.updatedAt ?? "default"}`} template={t} />
      ))}
    </>
  );
}

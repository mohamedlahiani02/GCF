import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, ErrorBanner, Field, Modal, Segmented } from "../../components/ui";
import { MEMBER_KIND, MEMBER_STATUS, memberName, type MemberRow, type Page } from "./api";

interface MemberForm {
  kind: MemberRow["kind"];
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  companyId: string;
  notes: string;
}

const EMPTY_FORM: MemberForm = { kind: "guest", firstName: "", lastName: "", email: "", phone: "", companyId: "", notes: "" };

/** Body of a create or update: blank optional fields are sent as null so a cleared field is really cleared. */
function memberBody(form: MemberForm, creating: boolean) {
  return {
    ...(creating ? { kind: form.kind } : {}),
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim() || null,
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    companyId: form.companyId || null,
    notes: form.notes.trim() || null,
  };
}

/** Pre-fills a quick creation from what was typed in the search: a phone number or a name. */
function formFromSearch(text: string): MemberForm {
  const value = text.trim();
  if (/^[+\d][\d\s.-]*$/.test(value)) return { ...EMPTY_FORM, phone: value };
  const [first = "", ...rest] = value.split(/\s+/);
  return { ...EMPTY_FORM, firstName: first, lastName: rest.join(" ") };
}

function MemberFields({
  form,
  onChange,
  creating,
  autoFocus,
}: {
  form: MemberForm;
  onChange: (f: MemberForm) => void;
  creating: boolean;
  autoFocus?: boolean;
}) {
  const companies = useQuery({
    queryKey: ["cw-companies"],
    queryFn: () => api.get<{ id: string; name: string }[]>("/coworking/companies"),
  });
  const set = (patch: Partial<MemberForm>) => onChange({ ...form, ...patch });
  return (
    <>
      {creating ? (
        <Segmented
          label="Type de client"
          value={form.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: "guest", label: "Client de passage" },
            { value: "member", label: "Membre (espace client)" },
          ]}
        />
      ) : null}
      <div className="grid2">
        <Field label="Prénom">
          <input className="input" autoFocus={autoFocus} required value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} />
        </Field>
        <Field label="Nom (facultatif)">
          <input className="input" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
        </Field>
        <Field label="Téléphone (facultatif)">
          <input className="input" type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field
          label={form.kind === "member" ? "E-mail" : "E-mail (facultatif)"}
          hint={form.kind === "member" && creating ? "L'espace client est ouvert à cette adresse ; l'invitation s'envoie depuis la fiche." : undefined}
        >
          <input className="input" type="email" required={form.kind === "member"} value={form.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
      </div>
      {companies.data?.length ? (
        <Field label="Société (facultatif)">
          <select className="input" value={form.companyId} onChange={(e) => set({ companyId: e.target.value })}>
            <option value="">Aucune</option>
            {companies.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </>
  );
}

/** Creates a client or edits one; the kind (member or guest) is chosen at creation only. */
export function MemberFormModal({ member, onClose, onSaved }: { member: MemberRow | null; onClose: () => void; onSaved: (m: MemberRow) => void }) {
  const [form, setForm] = useState<MemberForm>(
    member
      ? {
          kind: member.kind,
          firstName: member.firstName,
          lastName: member.lastName ?? "",
          email: member.email ?? "",
          phone: member.phone ?? "",
          companyId: member.companyId ?? "",
          notes: member.notes ?? "",
        }
      : EMPTY_FORM,
  );
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      member
        ? api.patch<MemberRow>(`/coworking/members/${member.id}`, memberBody(form, false))
        : api.post<MemberRow>("/coworking/members", memberBody(form, true)),
    onSuccess: async (saved) => {
      await client.invalidateQueries();
      onSaved(saved);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Modal
      title={member ? "Modifier le client" : "Nouveau client"}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="submit" form="member-form" className="btn btn-p" disabled={!form.firstName.trim() || save.isPending}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <form id="member-form" className="stack" onSubmit={submit}>
        <MemberFields form={form} onChange={setForm} creating={!member} autoFocus />
        <Field label="Notes internes (facultatif)">
          <textarea className="input" value={form.notes} maxLength={2000} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <ErrorBanner error={save.error} />
      </form>
    </Modal>
  );
}

/**
 * Finds a client by name, phone, e-mail or company, or creates one on the spot (a guest needs only a name). Enter
 * in the search field picks the first result, so the desk can work from the keyboard.
 */
export function MemberPicker({ onPick, autoFocus }: { onPick: (m: MemberRow) => void; autoFocus?: boolean | undefined }) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [creating, setCreating] = useState<MemberForm | null>(null);
  const toast = useToast();
  const client = useQueryClient();
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text.trim()), 200);
    return () => window.clearTimeout(t);
  }, [text]);
  const results = useQuery({
    queryKey: ["cw-members-pick", debounced],
    queryFn: () => api.get<Page<MemberRow>>("/coworking/members", { q: debounced, pageSize: 8 }),
    enabled: debounced.length >= 2,
  });
  const create = useMutation({
    mutationFn: (form: MemberForm) => api.post<MemberRow>("/coworking/members", memberBody(form, true)),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ["cw-members"] });
      toast(`Client ${memberName(created)} créé.`);
      onPick(created);
    },
  });
  const items = debounced.length >= 2 ? (results.data?.items ?? []) : [];
  const usable = items.filter((m) => m.status === "active");

  if (creating) {
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(creating);
        }}
      >
        <MemberFields form={creating} onChange={setCreating} creating autoFocus />
        <ErrorBanner error={create.error} />
        <div className="row" style={{ gap: 8 }}>
          <button
            type="submit"
            className="btn btn-p"
            disabled={!creating.firstName.trim() || (creating.kind === "member" && !creating.email.trim()) || create.isPending}
          >
            Créer le client
          </button>
          <button type="button" className="btn" onClick={() => setCreating(null)}>
            Retour à la recherche
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="stack">
      <Field label="Client" hint="Nom, téléphone, e-mail ou société. Entrée choisit le premier résultat.">
        <input
          className="input"
          type="search"
          autoFocus={autoFocus}
          placeholder="Rechercher un client…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (usable[0]) onPick(usable[0]);
            }
          }}
        />
      </Field>
      <ErrorBanner error={results.error} />
      {items.length ? (
        <div className="card" role="list" aria-label="Clients trouvés">
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              role="listitem"
              className="btn btn-g"
              disabled={m.status !== "active"}
              style={{ width: "100%", justifyContent: "space-between", borderRadius: 0 }}
              onClick={() => onPick(m)}
            >
              <span>
                {memberName(m)}
                {m.companyName ? <span className="cap"> · {m.companyName}</span> : null}
                {m.phone ? <span className="cap"> · {m.phone}</span> : null}
              </span>
              <span className="row center" style={{ gap: 6 }}>
                {m.currentPlan ? <Badge tone="violet">{m.currentPlan}</Badge> : null}
                {m.status === "active" ? (
                  <Badge tone="neutral">{MEMBER_KIND[m.kind]}</Badge>
                ) : (
                  <Badge tone={MEMBER_STATUS[m.status].tone}>{MEMBER_STATUS[m.status].label}</Badge>
                )}
              </span>
            </button>
          ))}
        </div>
      ) : debounced.length >= 2 && results.data ? (
        <span className="cap">Aucun client trouvé.</span>
      ) : null}
      <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setCreating(formFromSearch(text))}>
        + Créer un client
      </button>
    </div>
  );
}

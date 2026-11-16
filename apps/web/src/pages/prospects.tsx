import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, ReasonDialog, Segmented } from "../components/ui";
import { frDate, frDateTime, todayIso } from "../lib/format";
import type { Tone } from "../lib/labels";

type Stage = "new" | "contacted" | "visit" | "proposal" | "won" | "lost";
type Source = "website" | "walk_in" | "phone" | "referral" | "event" | "social" | "other";
type Interest = "training" | "coworking" | "rental" | "cafe" | "other";
interface Tag {
  id: string;
  name: string;
  color: string;
}
interface Prospect {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  interests: Interest[];
  source: Source;
  stage: Stage;
  lostReason: string | null;
  ownerId: string | null;
  ownerName: string | null;
  nextAction: string | null;
  nextActionOn: string | null;
  notes: string | null;
  siteLeadId: string | null;
  memberId: string | null;
  studentId: string | null;
  wonAt: string | null;
  updatedAt: string;
  tags: Tag[];
}
interface ProspectDetail extends Prospect {
  activities: { id: string; kind: "note" | "call" | "email" | "visit" | "stage"; text: string; at: string; userName: string | null }[];
}
interface ProspectList {
  items: Prospect[];
  today: string;
  counts: Record<Stage, number>;
  due: number;
}

const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  new: { label: "Nouveau", tone: "blue" },
  contacted: { label: "Contacté", tone: "teal" },
  visit: { label: "Visite", tone: "violet" },
  proposal: { label: "Proposition", tone: "amber" },
  won: { label: "Gagné", tone: "green" },
  lost: { label: "Perdu", tone: "gray" },
};
const OPEN: Stage[] = ["new", "contacted", "visit", "proposal"];
const SOURCE: Record<Source, string> = {
  website: "Site web",
  walk_in: "Passage",
  phone: "Téléphone",
  referral: "Recommandation",
  event: "Événement",
  social: "Réseaux sociaux",
  other: "Autre",
};
const INTEREST: Record<Interest, string> = { training: "Formation", coworking: "Coworking", rental: "Location de salle", cafe: "Café", other: "Autre" };
const ACTIVITY: Record<ProspectDetail["activities"][number]["kind"], string> = {
  note: "Note",
  call: "Appel",
  email: "E-mail",
  visit: "Visite",
  stage: "Étape",
};

const useTags = () => useQuery({ queryKey: ["prospect-tags"], queryFn: () => api.get<Tag[]>("/prospects/tags") });

function TagChip({ tag }: { tag: Tag }) {
  return (
    <span className="b" style={{ background: `${tag.color}1f`, color: tag.color, borderColor: `${tag.color}55` }}>
      {tag.name}
    </span>
  );
}

function ProspectForm({ prospect, onClose }: { prospect: Prospect | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const tags = useTags();
  const [name, setName] = useState(prospect?.name ?? "");
  const [company, setCompany] = useState(prospect?.company ?? "");
  const [email, setEmail] = useState(prospect?.email ?? "");
  const [phone, setPhone] = useState(prospect?.phone ?? "");
  const [source, setSource] = useState<Source>(prospect?.source ?? "walk_in");
  const [interests, setInterests] = useState<Interest[]>(prospect?.interests ?? []);
  const [tagIds, setTagIds] = useState<string[]>(prospect?.tags.map((t) => t.id) ?? []);
  const [nextAction, setNextAction] = useState(prospect?.nextAction ?? "");
  const [nextActionOn, setNextActionOn] = useState(prospect?.nextActionOn ?? "");
  const [notes, setNotes] = useState(prospect?.notes ?? "");
  const [newTag, setNewTag] = useState("");
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const addTag = useMutation({
    mutationFn: () => api.post<Tag>("/prospects/tags", { name: newTag.trim(), color: "#3d4ee0" }),
    onSuccess: async (tag) => {
      await client.invalidateQueries({ queryKey: ["prospect-tags"] });
      setTagIds((ids) => [...ids, tag.id]);
      setNewTag("");
    },
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        company: company.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        source,
        interests,
        tagIds,
        nextAction: nextAction.trim() || null,
        nextActionOn: nextActionOn || null,
        notes: notes.trim() || null,
      };
      return prospect ? api.patch<Prospect>(`/prospects/${prospect.id}`, body) : api.post<Prospect>("/prospects", body);
    },
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: ["prospects"] });
      await client.invalidateQueries({ queryKey: ["prospect", saved.id] });
      toast(prospect ? "Prospect enregistré." : `${saved.name} ajouté aux prospects.`);
      onClose();
      if (!prospect) navigate(`/prospects/${saved.id}`);
    },
  });
  return (
    <Modal
      title={prospect ? `Modifier ${prospect.name}` : "Nouveau prospect"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Un e-mail ou un téléphone est nécessaire.</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!name.trim() || (!email.trim() && !phone.trim()) || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Nom et prénom *">
          <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Société">
          <input className="input" value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="E-mail">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <input className="input" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Origine">
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as Source)}>
            {(Object.keys(SOURCE) as Source[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prochaine relance le">
          <input className="input" type="date" value={nextActionOn} onChange={(e) => setNextActionOn(e.target.value)} />
        </Field>
      </div>
      <Field label="Prochaine action">
        <input
          className="input"
          value={nextAction}
          maxLength={200}
          placeholder="Par exemple : envoyer la proposition"
          onChange={(e) => setNextAction(e.target.value)}
        />
      </Field>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Intéressé par</span>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {(Object.keys(INTEREST) as Interest[]).map((i) => (
            <label key={i} className="row center" style={{ gap: 6 }}>
              <input type="checkbox" className="chk" checked={interests.includes(i)} onChange={() => setInterests((l) => toggle(l, i))} />
              {INTEREST[i]}
            </label>
          ))}
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Étiquettes</span>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {(tags.data ?? []).map((t) => (
            <label key={t.id} className="row center" style={{ gap: 6 }}>
              <input type="checkbox" className="chk" checked={tagIds.includes(t.id)} onChange={() => setTagIds((l) => toggle(l, t.id))} />
              <TagChip tag={t} />
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            style={{ maxWidth: 220 }}
            value={newTag}
            maxLength={40}
            placeholder="Nouvelle étiquette"
            onChange={(e) => setNewTag(e.target.value)}
          />
          <button type="button" className="btn" disabled={!newTag.trim() || addTag.isPending} onClick={() => addTag.mutate()}>
            Ajouter
          </button>
        </div>
      </div>
      <Field label="Notes">
        <textarea className="input" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error ?? addTag.error} />
    </Modal>
  );
}

function ProspectCard({ p, today }: { p: Prospect; today: string }) {
  const late = p.nextActionOn !== null && p.nextActionOn <= today;
  return (
    <Link to={`/prospects/${p.id}`} className="card" style={{ display: "block", padding: 10, textDecoration: "none", color: "inherit" }}>
      <strong>{p.name}</strong>
      {p.company ? <div className="cap">{p.company}</div> : null}
      {p.nextActionOn ? (
        <div className="cap" style={late ? { color: "var(--red, #c4433b)", fontWeight: 600 } : undefined}>
          {late ? "À relancer" : "Relance"} le {frDate(p.nextActionOn)}
          {p.nextAction ? ` : ${p.nextAction}` : ""}
        </div>
      ) : null}
      {p.tags.length || p.interests.length ? (
        <div className="row" style={{ gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {p.interests.map((i) => (
            <Badge key={i} tone="neutral">
              {INTEREST[i]}
            </Badge>
          ))}
          {p.tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </div>
      ) : null}
    </Link>
  );
}

/** The follow-up board: open prospects by stage, then won and lost ones, with the follow-ups due. */
export function ProspectsPage() {
  usePage(["Prospects"]);
  const { can } = useSession();
  const tags = useTags();
  const [view, setView] = useState<"open" | "due" | "won" | "lost">("open");
  const [tagId, setTagId] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ["prospects", view, tagId, q],
    queryFn: () =>
      api.get<ProspectList>("/prospects", {
        stage: view === "due" ? "open" : view,
        ...(view === "due" ? { due: "true" } : {}),
        ...(tagId ? { tagId } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      }),
  });
  const data = list.data;
  return (
    <>
      <PageHeader
        title="Prospects"
        subtitle="Les personnes et sociétés intéressées, du premier contact à l'inscription."
        actions={
          can("prospects:write") ? (
            <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
              + Prospect
            </button>
          ) : null
        }
      />
      <div className="row center" style={{ gap: 12, flexWrap: "wrap" }}>
        <Segmented
          label="Vue"
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: `En cours${data ? ` (${OPEN.reduce((s, st) => s + data.counts[st], 0)})` : ""}` },
            { value: "due", label: `À relancer${data ? ` (${data.due})` : ""}` },
            { value: "won", label: `Gagnés${data ? ` (${data.counts.won})` : ""}` },
            { value: "lost", label: `Perdus${data ? ` (${data.counts.lost})` : ""}` },
          ]}
        />
        <select className="input" style={{ width: 200 }} aria-label="Étiquette" value={tagId} onChange={(e) => setTagId(e.target.value)}>
          <option value="">Toutes les étiquettes</option>
          {(tags.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          style={{ width: 240 }}
          placeholder="Nom, société, e-mail"
          aria-label="Rechercher"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending || !data ? (
        <Loading />
      ) : view === "open" ? (
        <div className="xs">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(220px, 1fr))", gap: 12, minWidth: 920 }}>
            {OPEN.map((stage) => {
              const items = data.items.filter((p) => p.stage === stage);
              return (
                <div key={stage} className="stack" style={{ gap: 8 }}>
                  <div className="row between center">
                    <Badge tone={STAGE[stage].tone}>{STAGE[stage].label}</Badge>
                    <span className="cap">{items.length}</span>
                  </div>
                  {items.map((p) => (
                    <ProspectCard key={p.id} p={p} today={data.today} />
                  ))}
                  {items.length === 0 ? <span className="cap">Aucun</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : data.items.length === 0 ? (
        <Card>
          <Empty title={view === "due" ? "Aucune relance en attente" : "Aucun prospect"} />
        </Card>
      ) : (
        <Card>
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Prospect</th>
                  <th>Étape</th>
                  <th>{view === "lost" ? "Motif" : view === "won" ? "Devenu" : "Relance"}</th>
                  <th>Suivi par</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/prospects/${p.id}`}>{p.name}</Link>
                      {p.company ? <div className="cap">{p.company}</div> : null}
                    </td>
                    <td>
                      <Badge tone={STAGE[p.stage].tone}>{STAGE[p.stage].label}</Badge>
                    </td>
                    <td>
                      {view === "lost"
                        ? p.lostReason
                        : view === "won"
                          ? p.memberId
                            ? "Client coworking"
                            : p.studentId
                              ? "Élève"
                              : ""
                          : p.nextActionOn
                            ? `${frDate(p.nextActionOn)}${p.nextAction ? ` : ${p.nextAction}` : ""}`
                            : ""}
                    </td>
                    <td>{p.ownerName ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {creating ? <ProspectForm prospect={null} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function ProspectPage() {
  const { id = "" } = useParams();
  const { can, session } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState(false);
  const [kind, setKind] = useState<"note" | "call" | "email" | "visit">("call");
  const [text, setText] = useState("");
  const prospect = useQuery({ queryKey: ["prospect", id], queryFn: () => api.get<ProspectDetail>(`/prospects/${id}`) });
  usePage(["Prospects", prospect.data?.name ?? "Prospect"]);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["prospect", id] }), client.invalidateQueries({ queryKey: ["prospects"] })]);
  const stage = useMutation({
    mutationFn: (next: Stage) => api.post(`/prospects/${id}/stage`, { stage: next }),
    onSuccess: refresh,
  });
  const activity = useMutation({
    mutationFn: () => api.post(`/prospects/${id}/activities`, { kind, text: text.trim() }),
    onSuccess: async () => {
      setText("");
      await refresh();
    },
  });
  const convert = useMutation({
    mutationFn: (target: "member" | "student") => api.post<ProspectDetail>(`/prospects/${id}/convert`, { target }),
    onSuccess: async (p) => {
      await refresh();
      toast(p.memberId ? "Client coworking créé : complétez sa fiche." : "Élève créé : complétez sa fiche.");
    },
  });
  if (prospect.isPending) return <Loading />;
  if (prospect.error) return <ErrorBanner error={prospect.error} retry={() => prospect.refetch()} />;
  const p = prospect.data;
  const writable = can("prospects:write");
  const open = OPEN.includes(p.stage);
  const modules: string[] = session?.modules ?? [];
  return (
    <>
      <PageHeader
        title={p.name}
        subtitle={
          <span className="row center" style={{ gap: 8, flexWrap: "wrap" }}>
            <Badge tone={STAGE[p.stage].tone}>{STAGE[p.stage].label}</Badge>
            {p.company ? <span>{p.company}</span> : null}
            <span>{[p.email, p.phone].filter(Boolean).join(" · ")}</span>
            {p.tags.map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </span>
        }
        actions={
          writable ? (
            <>
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Modifier
              </button>
              {open && modules.includes("coworking") ? (
                <button type="button" className="btn btn-p" disabled={convert.isPending} onClick={() => convert.mutate("member")}>
                  Inscrire au coworking
                </button>
              ) : null}
              {open && modules.includes("training") ? (
                <button type="button" className="btn btn-p" disabled={convert.isPending} onClick={() => convert.mutate("student")}>
                  Inscrire comme élève
                </button>
              ) : null}
              {open ? (
                <button type="button" className="btn btn-g" onClick={() => setLosing(true)}>
                  Marquer perdu
                </button>
              ) : null}
              {p.stage === "lost" ? (
                <button type="button" className="btn" disabled={stage.isPending} onClick={() => stage.mutate("contacted")}>
                  Rouvrir
                </button>
              ) : null}
            </>
          ) : null
        }
      />
      <ErrorBanner error={stage.error ?? convert.error} />
      {p.memberId ? (
        <div className="ban ban-green">
          <span>
            Devenu client coworking : <Link to={`/coworking/membres/${p.memberId}`}>ouvrir sa fiche</Link>.
          </span>
        </div>
      ) : null}
      {p.studentId ? (
        <div className="ban ban-green">
          <span>
            Devenu élève : <Link to={`/eleves/${p.studentId}`}>ouvrir sa fiche</Link>.
          </span>
        </div>
      ) : null}
      {open && writable ? (
        <div className="row center" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="lab">Étape</span>
          <Segmented label="Étape" value={p.stage} onChange={(s) => stage.mutate(s)} options={OPEN.map((s) => ({ value: s, label: STAGE[s].label }))} />
        </div>
      ) : null}
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card title="Suivi">
          <div className="card-b stack">
            <div>
              <div className="lab">Prochaine action</div>
              {p.nextActionOn || p.nextAction ? (
                <div style={p.nextActionOn && p.nextActionOn <= todayIso() && open ? { color: "#c4433b", fontWeight: 600 } : undefined}>
                  {p.nextActionOn ? `${frDate(p.nextActionOn)} : ` : ""}
                  {p.nextAction ?? ""}
                </div>
              ) : (
                <span className="cap">Aucune relance prévue</span>
              )}
            </div>
            <div>
              <div className="lab">Intéressé par</div>
              {p.interests.length ? p.interests.map((i) => INTEREST[i]).join(", ") : <span className="cap">Non précisé</span>}
            </div>
            <div>
              <div className="lab">Origine</div>
              {SOURCE[p.source]}
              {p.siteLeadId ? <span className="cap"> · demande reçue par le site</span> : null}
            </div>
            <div>
              <div className="lab">Suivi par</div>
              {p.ownerName ?? <span className="cap">Personne</span>}
            </div>
            {p.lostReason ? (
              <div>
                <div className="lab">Motif de perte</div>
                {p.lostReason}
              </div>
            ) : null}
            {p.notes ? (
              <div>
                <div className="lab">Notes</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{p.notes}</div>
              </div>
            ) : null}
          </div>
        </Card>
        <Card title="Historique">
          <div className="card-b stack">
            {writable ? (
              <div className="stack" style={{ gap: 6 }}>
                <Segmented
                  label="Type"
                  value={kind}
                  onChange={setKind}
                  options={[
                    { value: "call", label: "Appel" },
                    { value: "email", label: "E-mail" },
                    { value: "visit", label: "Visite" },
                    { value: "note", label: "Note" },
                  ]}
                />
                <textarea
                  className="input"
                  rows={2}
                  value={text}
                  maxLength={2000}
                  placeholder="Ce qui a été dit ou convenu"
                  onChange={(e) => setText(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  style={{ alignSelf: "flex-start" }}
                  disabled={!text.trim() || activity.isPending}
                  onClick={() => activity.mutate()}
                >
                  Ajouter à l'historique
                </button>
                <ErrorBanner error={activity.error} />
              </div>
            ) : null}
            {p.activities.length === 0 ? <span className="cap">Rien pour l'instant.</span> : null}
            <ol className="tl">
              {p.activities.map((a) => (
                <li key={a.id}>
                  <div className="cap">
                    {frDateTime(a.at)} · {ACTIVITY[a.kind]}
                    {a.userName ? ` · ${a.userName}` : ""}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{a.text}</div>
                </li>
              ))}
            </ol>
          </div>
        </Card>
      </div>
      {editing ? <ProspectForm prospect={p} onClose={() => setEditing(false)} /> : null}
      {losing ? (
        <ReasonDialog
          title="Marquer le prospect perdu"
          explanation="Le motif reste sur la fiche ; le prospect peut être rouvert plus tard."
          confirmLabel="Marquer perdu"
          onClose={() => setLosing(false)}
          onConfirm={async (reason) => {
            await api.post(`/prospects/${id}/stage`, { stage: "lost", lostReason: reason });
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

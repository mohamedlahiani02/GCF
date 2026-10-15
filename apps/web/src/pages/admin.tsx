import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Pagination, Tabs } from "../components/ui";
import { frDateTime, weekdayLabel, zonedIso } from "../lib/format";
import { ROLE } from "../lib/labels";

const PASSWORD_MIN_LENGTH = 10;

interface Centre {
  name: string;
  address: string | null;
  taxId: string | null;
  timezone: string;
  countJustifiedAsPresent: boolean;
  countMakeupAsPresent: boolean;
  postponementRequiresApproval: boolean;
  maxPostponements: number;
  overdueGraceDays: number;
  receiptPrefix: string;
  receiptFooter: string | null;
  openFrom: string;
  openTo: string;
  openWeekdays: number[];
  logoVersion: number | null;
}
interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: "admin" | "secretariat" | "accountant";
  active: boolean;
  lastLoginAt: string | null;
}
interface AuditRow {
  id: string;
  at: string;
  userName: string | null;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}

const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("file could not be read"));
    reader.readAsDataURL(file);
  });
}

/** The logo shown in the navigation: uploaded on its own, without the "Enregistrer" button of the settings. */
function LogoSetting({ name, logoVersion, editable }: { name: string; logoVersion: number | null; editable: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["centre-settings"] });
    await client.invalidateQueries({ queryKey: ["centre"] });
  };
  const upload = useMutation({
    mutationFn: async (file: File) => api.put<Centre>("/centre/logo", { image: await readAsDataUrl(file) }),
    onSuccess: async () => {
      await refresh();
      toast("Logo enregistré.");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del<Centre>("/centre/logo"),
    onSuccess: async () => {
      await refresh();
      toast("Logo retiré.");
    },
  });
  const pick = (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return setProblem("Le logo doit être une image PNG, JPEG ou WebP.");
    if (file.size > LOGO_MAX_BYTES) return setProblem("Le logo ne doit pas dépasser 512 Ko.");
    upload.mutate(file);
  };
  return (
    <div className="logo-setting">
      <span className="logo-preview">
        {logoVersion ? <img src={api.fileUrl("/centre/logo", { v: logoVersion })} alt={`Logo de ${name}`} /> : <span className="cap">Aucun logo</span>}
      </span>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Logo</span>
        <span className="cap">Affiché en haut du menu. PNG, JPEG ou WebP, 512 Ko maximum ; un logo carré ou horizontal sur fond clair rend le mieux.</span>
        {editable ? (
          <div className="row" style={{ gap: 8 }}>
            <label className={`btn${upload.isPending ? " disabled" : ""}`}>
              {logoVersion ? "Remplacer le logo" : "Choisir un logo"}
              <input
                type="file"
                accept={LOGO_TYPES.join(",")}
                className="visually-hidden"
                disabled={upload.isPending}
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {logoVersion ? (
              <button type="button" className="btn btn-g" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Retirer
              </button>
            ) : null}
          </div>
        ) : null}
        {problem ? <span className="err-text">{problem}</span> : null}
        <ErrorBanner error={upload.error ?? remove.error} />
      </div>
    </div>
  );
}

function CentreSettings() {
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const centre = useQuery({ queryKey: ["centre-settings"], queryFn: () => api.get<Centre>("/centre") });
  const [v, setV] = useState<Centre | null>(null);
  useEffect(() => {
    if (centre.data) setV(centre.data);
  }, [centre.data]);
  const save = useMutation({
    mutationFn: (body: Centre) =>
      api.patch<Centre>("/centre", {
        name: body.name,
        address: body.address ?? "",
        taxId: body.taxId ?? "",
        countJustifiedAsPresent: body.countJustifiedAsPresent,
        countMakeupAsPresent: body.countMakeupAsPresent,
        postponementRequiresApproval: body.postponementRequiresApproval,
        maxPostponements: body.maxPostponements,
        overdueGraceDays: body.overdueGraceDays,
        receiptPrefix: body.receiptPrefix,
        receiptFooter: body.receiptFooter ?? "",
        openFrom: body.openFrom,
        openTo: body.openTo,
        openWeekdays: body.openWeekdays,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["centre-settings"] });
      await client.invalidateQueries({ queryKey: ["centre"] });
      toast("Paramètres enregistrés.");
    },
  });
  if (centre.isPending || !v) return <Loading />;
  if (centre.error) return <ErrorBanner error={centre.error} />;
  const editable = can("centre:manage");
  const set = <K extends keyof Centre>(k: K, value: Centre[K]) => setV({ ...v, [k]: value });
  const prefixOk = /^[A-Z0-9]{1,10}$/.test(v.receiptPrefix);
  return (
    <Card
      title="Paramètres du centre"
      footer={
        editable ? (
          <>
            <span className="cap">Chaque modification est tracée au journal d'audit</span>
            <button
              type="button"
              className="btn btn-p"
              disabled={!v.name.trim() || !prefixOk || v.openTo <= v.openFrom || !v.openWeekdays.length || save.isPending}
              onClick={() => save.mutate(v)}
            >
              Enregistrer
            </button>
          </>
        ) : null
      }
    >
      <fieldset className="card-b stack" disabled={!editable} style={{ border: 0, margin: 0 }}>
        <h3 className="h2">Identité (figure sur les reçus)</h3>
        <LogoSetting name={v.name} logoVersion={centre.data.logoVersion} editable={editable} />
        <div className="grid3">
          <Field label="Nom du centre">
            <input className="input" value={v.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Adresse">
            <input className="input" value={v.address ?? ""} onChange={(e) => set("address", e.target.value)} />
          </Field>
          <Field label="Matricule fiscal">
            <input className="input" value={v.taxId ?? ""} onChange={(e) => set("taxId", e.target.value)} />
          </Field>
        </div>
        <h3 className="h2">Présences</h3>
        <label className="row center" style={{ gap: 8 }}>
          <input type="checkbox" className="chk" checked={v.countJustifiedAsPresent} onChange={(e) => set("countJustifiedAsPresent", e.target.checked)} />{" "}
          Compter les absences justifiées comme présentes dans le taux
        </label>
        <label className="row center" style={{ gap: 8 }}>
          <input type="checkbox" className="chk" checked={v.countMakeupAsPresent} onChange={(e) => set("countMakeupAsPresent", e.target.checked)} /> Compter les
          rattrapages dans un autre groupe comme présents
        </label>
        <span className="cap">Un groupe peut remplacer ces réglages ; ils comptent dans le taux de présence et donc dans la paie au prorata.</span>
        <h3 className="h2">Échéances</h3>
        <div className="grid3">
          <Field label="Reports maximum par échéance">
            <input
              className="input num"
              type="number"
              min={0}
              max={12}
              value={v.maxPostponements}
              onChange={(e) => set("maxPostponements", Number(e.target.value))}
            />
          </Field>
          <Field label="Délai de grâce avant retard (jours)">
            <input
              className="input num"
              type="number"
              min={0}
              max={60}
              value={v.overdueGraceDays}
              onChange={(e) => set("overdueGraceDays", Number(e.target.value))}
            />
          </Field>
        </div>
        <label className="row center" style={{ gap: 8 }}>
          <input
            type="checkbox"
            className="chk"
            checked={v.postponementRequiresApproval}
            onChange={(e) => set("postponementRequiresApproval", e.target.checked)}
          />{" "}
          Les reports demandés par le secrétariat attendent la validation d'un administrateur
        </label>
        <h3 className="h2">Reçus</h3>
        <div className="grid3">
          <Field
            label="Préfixe de numérotation"
            hint={`Exemple : ${v.receiptPrefix}-2026-000001`}
            error={prefixOk ? null : "1 à 10 lettres majuscules ou chiffres"}
          >
            <input className="input" value={v.receiptPrefix} onChange={(e) => set("receiptPrefix", e.target.value.toUpperCase())} />
          </Field>
        </div>
        <Field label="Mentions en pied de reçu" hint="Vide : mention par défaut sur la numérotation et l'archivage.">
          <textarea className="input" value={v.receiptFooter ?? ""} maxLength={500} onChange={(e) => set("receiptFooter", e.target.value)} />
        </Field>
        <h3 className="h2">Heures d'ouverture (occupation des salles)</h3>
        <div className="grid3">
          <Field label="Ouverture">
            <input className="input" type="time" value={v.openFrom} onChange={(e) => set("openFrom", e.target.value)} />
          </Field>
          <Field label="Fermeture" error={v.openTo <= v.openFrom ? "La fermeture doit suivre l'ouverture." : null}>
            <input className="input" type="time" value={v.openTo} onChange={(e) => set("openTo", e.target.value)} />
          </Field>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <label key={d} className="row center" style={{ gap: 6 }}>
              <input
                type="checkbox"
                className="chk"
                checked={v.openWeekdays.includes(d)}
                onChange={(e) => set("openWeekdays", e.target.checked ? [...v.openWeekdays, d].sort() : v.openWeekdays.filter((x) => x !== d))}
              />
              {weekdayLabel(d)}
            </label>
          ))}
        </div>
        <ErrorBanner error={save.error} />
      </fieldset>
    </Card>
  );
}

function UserModal({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState(user?.email ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [role, setRole] = useState<UserRow["role"]>(user?.role ?? "secretariat");
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      if (user) {
        await api.patch(`/users/${user.id}`, { fullName: fullName.trim(), role, active });
        if (password) await api.post(`/users/${user.id}/password`, { password });
        return;
      }
      await api.post("/users", { email: email.trim(), fullName: fullName.trim(), role, password });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["users"] });
      toast(user ? "Compte mis à jour. Ses sessions ouvertes sont fermées si le rôle, l'état ou le mot de passe change." : "Compte créé.");
      onClose();
    },
  });
  const passwordOk = user ? password === "" || password.length >= PASSWORD_MIN_LENGTH : password.length >= PASSWORD_MIN_LENGTH;
  return (
    <Modal
      title={user ? `Compte de ${user.fullName}` : "Nouveau compte"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Transmettez le mot de passe de vive voix, jamais par e-mail</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!fullName.trim() || (!user && !email.trim()) || !passwordOk || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      {!user ? (
        <Field label="E-mail de connexion *">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Nom complet *">
        <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </Field>
      <Field label="Rôle">
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as UserRow["role"])}>
          {Object.entries(ROLE).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {user ? (
        <label className="row center" style={{ gap: 8 }}>
          <input type="checkbox" className="chk" checked={active} onChange={(e) => setActive(e.target.checked)} /> Compte actif
        </label>
      ) : null}
      <Field
        label={user ? "Nouveau mot de passe (facultatif)" : "Mot de passe initial *"}
        hint={`${PASSWORD_MIN_LENGTH} caractères minimum.`}
        error={password && password.length < PASSWORD_MIN_LENGTH ? "Mot de passe trop court" : null}
      >
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function Users() {
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<UserRow[]>("/users") });
  return (
    <Card
      title="Utilisateurs"
      actions={
        <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
          + Nouveau compte
        </button>
      }
    >
      <ErrorBanner error={users.error} />
      {users.isPending ? (
        <Loading />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Nom</th>
                <th>E-mail</th>
                <th>Rôle</th>
                <th>État</th>
                <th>Dernière connexion</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}>
                  <td>{u.fullName}</td>
                  <td>{u.email}</td>
                  <td>{ROLE[u.role]}</td>
                  <td>{u.active ? <Badge tone="green">Actif</Badge> : <Badge tone="gray">Désactivé</Badge>}</td>
                  <td>{u.lastLoginAt ? frDateTime(u.lastLoginAt) : "Jamais"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn btn-g" onClick={() => setEditing(u)}>
                      Modifier
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <UserModal user={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

const OBJECT_TYPES: Record<string, string> = {
  student: "Élève",
  enrolment: "Inscription",
  payment: "Paiement",
  receipt: "Reçu",
  installment: "Échéance",
  session: "Séance",
  group: "Groupe",
  pay_period: "Période de paie",
  pay_rule: "Règle de paie",
  rental: "Location",
  cash_closing: "Clôture de caisse",
  user: "Utilisateur",
  centre: "Centre",
  report: "Rapport",
};

function AuditLog() {
  const [objectType, setObjectType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AuditRow | null>(null);
  const log = useQuery({
    queryKey: ["audit", objectType, from, to, page],
    queryFn: () =>
      api.get<{ items: AuditRow[]; hasMore: boolean }>("/audit-log", {
        objectType: objectType || undefined,
        from: from ? zonedIso(from, "00:00") : undefined,
        to: to ? zonedIso(to, "23:59") : undefined,
        page,
        pageSize: 50,
      }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      title={
        <div className="row center" style={{ gap: 8 }}>
          <select className="input" aria-label="Type d'objet" value={objectType} onChange={(e) => (setObjectType(e.target.value), setPage(1))}>
            <option value="">Tous les objets</option>
            {Object.entries(OBJECT_TYPES).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <input className="input" type="date" aria-label="Du" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
          <input className="input" type="date" aria-label="Au" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
        </div>
      }
      footer={log.data ? <Pagination page={page} hasMore={log.data.hasMore} onPage={setPage} /> : null}
    >
      <ErrorBanner error={log.error} />
      {log.isPending ? (
        <Loading />
      ) : log.data?.items.length === 0 ? (
        <Empty title="Aucune entrée" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Utilisateur</th>
                <th>Action</th>
                <th>Objet</th>
                <th>Motif</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {log.data?.items.map((a) => (
                <tr key={a.id}>
                  <td>{frDateTime(a.at)}</td>
                  <td>{a.userName ?? "Système"}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td>{OBJECT_TYPES[a.objectType] ?? a.objectType}</td>
                  <td>{a.reason ?? ""}</td>
                  <td style={{ textAlign: "right" }}>
                    {a.before || a.after ? (
                      <button type="button" className="btn btn-g" onClick={() => setOpen(a)}>
                        Détail
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? (
        <Modal wide title={`${open.action} · ${frDateTime(open.at)}`} onClose={() => setOpen(null)}>
          <div className="grid2" style={{ alignItems: "start" }}>
            <div>
              <div className="lab">Avant</div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{open.before ? JSON.stringify(open.before, null, 2) : "-"}</pre>
            </div>
            <div>
              <div className="lab">Après</div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{open.after ? JSON.stringify(open.after, null, 2) : "-"}</pre>
            </div>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

export function AdminPage() {
  usePage(["Administration"]);
  const { can } = useSession();
  const tabs = [
    { value: "settings" as const, label: "Paramètres" },
    ...(can("users:manage") ? [{ value: "users" as const, label: "Utilisateurs" }] : []),
    ...(can("audit:read") ? [{ value: "audit" as const, label: "Journal d'audit" }] : []),
  ];
  const [tab, setTab] = useState<(typeof tabs)[number]["value"]>("settings");
  return (
    <>
      <PageHeader title="Administration" />
      <Tabs value={tab} tabs={tabs} onChange={setTab} />
      {tab === "settings" ? <CentreSettings /> : tab === "users" ? <Users /> : <AuditLog />}
    </>
  );
}

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useMutation({
    mutationFn: () => api.post("/auth/password", { currentPassword, newPassword }),
    onSuccess: () => {
      toast("Mot de passe modifié.");
      onClose();
    },
  });
  return (
    <Modal
      title="Changer mon mot de passe"
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!currentPassword || newPassword.length < PASSWORD_MIN_LENGTH || newPassword !== confirm || change.isPending}
              onClick={() => change.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Mot de passe actuel">
        <input className="input" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="Nouveau mot de passe" hint={`${PASSWORD_MIN_LENGTH} caractères minimum.`}>
        <input className="input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} />
      </Field>
      <Field label="Confirmation" error={confirm && confirm !== newPassword ? "Les deux saisies diffèrent." : null}>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <ErrorBanner error={change.error} />
    </Modal>
  );
}

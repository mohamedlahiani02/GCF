import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Drawer, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Pagination, Segmented, Tabs } from "../components/ui";
import { frDateTime, todayIso, zonedIso } from "../lib/format";
import { ROLE } from "../lib/labels";

type TokenRole = "secretariat" | "accountant" | "editor";
type TokenState = "active" | "expired" | "revoked";
interface ApiToken {
  id: string;
  name: string;
  role: TokenRole;
  readOnly: boolean;
  prefix: string;
  createdAt: string;
  createdByName: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  state: TokenState;
}
interface Endpoint {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  pending: number;
  failed: number;
  lastDeliveredAt: string | null;
}
type DeliveryStatus = "pending" | "delivered" | "failed";
interface Delivery {
  id: string;
  eventType: string;
  auditId: number | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

const TOKEN_ROLES: TokenRole[] = ["secretariat", "accountant", "editor"];
const TOKEN_STATE: Record<TokenState, { label: string; tone: "green" | "gray" | "red" }> = {
  active: { label: "Actif", tone: "green" },
  expired: { label: "Expiré", tone: "gray" },
  revoked: { label: "Révoqué", tone: "red" },
};
const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: "amber" | "green" | "red" }> = {
  pending: { label: "En attente", tone: "amber" },
  delivered: { label: "Envoyé", tone: "green" },
  failed: { label: "Échec", tone: "red" },
};
const EVENT_PATTERN = /^(\*|[a-z][a-z0-9_]*\.\*|[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/;
const DEFAULT_MAX_ATTEMPTS = 10;

/** A secret shown once, with a copy button; the user must confirm they kept it before closing. */
function SecretModal({ title, secret, explanation, onClose }: { title: string; secret: string; explanation: string; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toast("Copié dans le presse-papiers.");
    } catch {
      toast("Copie impossible : sélectionnez le texte et copiez-le.");
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Il ne sera plus affiché.</span>
          <button type="button" className="btn btn-p" onClick={onClose}>
            J'ai conservé la valeur
          </button>
        </>
      }
    >
      <p className="cap">{explanation}</p>
      <div className="row" style={{ gap: 8 }}>
        <input className="input" readOnly value={secret} aria-label={title} onFocus={(e) => e.target.select()} style={{ flex: 1, fontFamily: "monospace" }} />
        <button type="button" className="btn" onClick={() => void copy()}>
          Copier
        </button>
      </div>
    </Modal>
  );
}

function ConfirmModal({
  title,
  text,
  action,
  onConfirm,
  onClose,
  pending,
  error,
}: {
  title: string;
  text: string;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error: unknown;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={pending} onClick={onConfirm}>
              {action}
            </button>
          </div>
        </>
      }
    >
      <p>{text}</p>
      <ErrorBanner error={error} />
    </Modal>
  );
}

function TokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<TokenRole>("secretariat");
  const [readOnly, setReadOnly] = useState(true);
  const [expiresOn, setExpiresOn] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.post<ApiToken & { token: string }>("/integrations/tokens", {
        name: name.trim(),
        role,
        readOnly,
        expiresAt: expiresOn ? zonedIso(expiresOn, "23:59") : null,
      }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ["api-tokens"] });
      onCreated(created.token);
    },
  });
  return (
    <Modal
      title="Nouveau jeton d'accès"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Tracé au journal d'audit</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!name.trim() || (expiresOn !== "" && expiresOn <= todayIso()) || create.isPending}
              onClick={() => create.mutate()}
            >
              Créer le jeton
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *" hint="Pour reconnaître l'outil qui l'utilise, par exemple « n8n relances ».">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Rôle" hint="Le jeton a exactement les droits de ce rôle. Le rôle Admin n'est jamais proposé.">
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as TokenRole)}>
          {TOKEN_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE[r]}
            </option>
          ))}
        </select>
      </Field>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Lecture seule (recommandé tant que l'outil
        n'a pas besoin de modifier)
      </label>
      <Field label="Expire le (facultatif)" hint="Sans date, le jeton reste valable jusqu'à sa révocation.">
        <input className="input" type="date" min={todayIso()} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </Field>
      <ErrorBanner error={create.error} />
    </Modal>
  );
}

function Tokens() {
  const client = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const tokens = useQuery({ queryKey: ["api-tokens"], queryFn: () => api.get<ApiToken[]>("/integrations/tokens") });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post<ApiToken>(`/integrations/tokens/${id}/revoke`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["api-tokens"] });
      setRevoking(null);
      toast("Jeton révoqué.");
    },
  });
  return (
    <Card
      title="Jetons d'accès"
      actions={
        <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
          + Nouveau jeton
        </button>
      }
    >
      <p className="cap card-b">
        Un jeton permet à un outil externe (n8n, un agent) d'appeler l'API avec les droits d'un rôle. Il agit au nom de l'administrateur qui l'a créé et cesse
        de fonctionner si ce dernier perd son rôle d'administrateur.
      </p>
      <ErrorBanner error={tokens.error} />
      {tokens.isPending ? (
        <Loading />
      ) : tokens.data?.length === 0 ? (
        <Empty title="Aucun jeton" text="Créez un jeton pour chaque outil, avec le rôle le plus limité possible." />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Début du jeton</th>
                <th>Rôle</th>
                <th>Accès</th>
                <th>État</th>
                <th>Dernière utilisation</th>
                <th>Créé par</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.data?.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}…</code>
                  </td>
                  <td>{ROLE[t.role]}</td>
                  <td>{t.readOnly ? "Lecture" : "Lecture et écriture"}</td>
                  <td>
                    <Badge tone={TOKEN_STATE[t.state].tone}>{TOKEN_STATE[t.state].label}</Badge>
                    {t.state === "active" && t.expiresAt ? <div className="cap">jusqu'au {frDateTime(t.expiresAt)}</div> : null}
                  </td>
                  <td>{t.lastUsedAt ? frDateTime(t.lastUsedAt) : "Jamais"}</td>
                  <td>
                    {t.createdByName}
                    <div className="cap">{frDateTime(t.createdAt)}</div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {t.state === "active" ? (
                      <button type="button" className="btn btn-g" onClick={() => setRevoking(t)}>
                        Révoquer
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? (
        <TokenModal
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setSecret(token);
          }}
        />
      ) : null}
      {secret ? (
        <SecretModal
          title="Jeton créé"
          secret={secret}
          explanation="Copiez ce jeton maintenant et enregistrez-le dans l'outil, par exemple dans un identifiant n8n de type « Header Auth » : Authorization = Bearer suivi du jeton."
          onClose={() => setSecret(null)}
        />
      ) : null}
      {revoking ? (
        <ConfirmModal
          title={`Révoquer « ${revoking.name} »`}
          text="L'outil qui utilise ce jeton perd immédiatement l'accès. Cette action est définitive."
          action="Révoquer"
          pending={revoke.isPending}
          error={revoke.error}
          onConfirm={() => revoke.mutate(revoking.id)}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </Card>
  );
}

function EndpointModal({ endpoint, onClose, onSecret }: { endpoint: Endpoint | null; onClose: () => void; onSecret: (secret: string) => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(endpoint?.name ?? "");
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [eventsText, setEventsText] = useState(endpoint?.events.join("\n") ?? "");
  const [maxAttempts, setMaxAttempts] = useState(endpoint?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const [active, setActive] = useState(endpoint?.active ?? true);
  const [confirm, setConfirm] = useState<"rotate" | "delete" | null>(null);
  const suggestions = useQuery({ queryKey: ["integration-events"], queryFn: () => api.get<{ actions: string[] }>("/integrations/events") });
  const events = [
    ...new Set(
      eventsText
        .split(/[\n,]/)
        .map((e) => e.trim())
        .filter(Boolean),
    ),
  ];
  const invalid = events.filter((e) => !EVENT_PATTERN.test(e));
  const urlOk = /^https?:\/\/\S+$/.test(url.trim());
  const refresh = () => client.invalidateQueries({ queryKey: ["webhooks"] });
  const save = useMutation({
    mutationFn: async (): Promise<string | null> => {
      const body = { name: name.trim(), url: url.trim(), events, maxAttempts };
      if (endpoint) {
        await api.patch<Endpoint>(`/integrations/webhooks/${endpoint.id}`, { ...body, active });
        return null;
      }
      return (await api.post<Endpoint & { secret: string }>("/integrations/webhooks", body)).secret;
    },
    onSuccess: async (newSecret) => {
      await refresh();
      onClose();
      if (newSecret) onSecret(newSecret);
      else toast("Webhook enregistré.");
    },
  });
  const rotate = useMutation({
    mutationFn: () => api.post<Endpoint & { secret: string }>(`/integrations/webhooks/${endpoint!.id}/rotate-secret`),
    onSuccess: async (saved) => {
      await refresh();
      onClose();
      onSecret(saved.secret);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/integrations/webhooks/${endpoint!.id}`),
    onSuccess: async () => {
      await refresh();
      onClose();
      toast("Webhook supprimé.");
    },
  });
  const addEvent = (event: string) => setEventsText(events.includes(event) ? eventsText : [...events, event].join("\n"));
  const families = [...new Set((suggestions.data?.actions ?? []).map((a) => `${a.split(".")[0]}.*`))];

  if (confirm && endpoint) {
    return confirm === "rotate" ? (
      <ConfirmModal
        title="Régénérer le secret"
        text="L'ancien secret cesse immédiatement de signer les envois. Mettez le nouveau dans n8n juste après, sinon les envois seront rejetés."
        action="Régénérer"
        pending={rotate.isPending}
        error={rotate.error}
        onConfirm={() => rotate.mutate()}
        onClose={() => setConfirm(null)}
      />
    ) : (
      <ConfirmModal
        title={`Supprimer « ${endpoint.name} »`}
        text="Le webhook et son journal d'envoi sont supprimés. Les envois en attente sont perdus."
        action="Supprimer"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirm(null)}
      />
    );
  }

  return (
    <Modal
      wide
      title={endpoint ? `Webhook « ${endpoint.name} »` : "Nouveau webhook"}
      onClose={onClose}
      footer={
        <>
          {endpoint ? (
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-g" onClick={() => setConfirm("rotate")}>
                Régénérer le secret
              </button>
              <button type="button" className="btn btn-g" onClick={() => setConfirm("delete")}>
                Supprimer
              </button>
            </div>
          ) : (
            <span className="cap">Le secret de signature sera affiché une seule fois</span>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!name.trim() || !urlOk || !events.length || invalid.length > 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Nom *">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Nombre maximum d'essais" hint="Après un échec, nouvel essai après 1 min, puis 2, 4, 8… (6 h au plus).">
          <input
            className="input"
            type="number"
            min={1}
            max={20}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
          />
        </Field>
      </div>
      <Field
        label="Adresse de réception *"
        hint="L'URL du nœud Webhook de n8n, par exemple http://n8n:5678/webhook/gcf."
        error={url && !urlOk ? "L'adresse doit commencer par http:// ou https://" : null}
      >
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field
        label="Événements *"
        hint="Un par ligne : une action précise (payment.created), une famille (payment.*) ou tout (*)."
        error={invalid.length ? `Format non reconnu : ${invalid.join(", ")}` : null}
      >
        <textarea className="input" rows={5} value={eventsText} onChange={(e) => setEventsText(e.target.value)} />
      </Field>
      {families.length ? (
        <div className="stack" style={{ gap: 6 }}>
          <span className="lab">Ajouter un événement déjà survenu dans le centre</span>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {families.map((f) => (
              <button key={f} type="button" className="btn btn-g" onClick={() => addEvent(f)}>
                {f}
              </button>
            ))}
          </div>
          <select className="input" aria-label="Action précise" value="" onChange={(e) => e.target.value && addEvent(e.target.value)}>
            <option value="">Choisir une action précise…</option>
            {suggestions.data?.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {endpoint ? (
        <label className="row center" style={{ gap: 8 }}>
          <input type="checkbox" className="chk" checked={active} onChange={(e) => setActive(e.target.checked)} /> Actif (désactivé, les envois en attente sont
          abandonnés)
        </label>
      ) : null}
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function DeliveriesDrawer({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<DeliveryStatus | "all">("all");
  const [page, setPage] = useState(1);
  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", endpoint.id, status, page],
    queryFn: () =>
      api.get<{ items: Delivery[]; hasMore: boolean }>(`/integrations/webhooks/${endpoint.id}/deliveries`, {
        status: status === "all" ? undefined : status,
        page,
        pageSize: 50,
      }),
    placeholderData: keepPreviousData,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/deliveries/${id}/retry`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["webhook-deliveries", endpoint.id] });
      await client.invalidateQueries({ queryKey: ["webhooks"] });
      toast("Envoi remis en file.");
    },
  });
  return (
    <Drawer
      title={`Envois · ${endpoint.name}`}
      onClose={onClose}
      footer={deliveries.data ? <Pagination page={page} hasMore={deliveries.data.hasMore} onPage={setPage} /> : null}
    >
      <Segmented
        label="Filtrer par état"
        value={status}
        onChange={(v) => (setStatus(v), setPage(1))}
        options={[
          { value: "all", label: "Tous" },
          { value: "pending", label: "En attente" },
          { value: "delivered", label: "Envoyés" },
          { value: "failed", label: "Échecs" },
        ]}
      />
      <ErrorBanner error={deliveries.error ?? retry.error} />
      {deliveries.isPending ? (
        <Loading />
      ) : deliveries.data?.items.length === 0 ? (
        <Empty title="Aucun envoi" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Créé</th>
                <th>Événement</th>
                <th>État</th>
                <th>Essais</th>
                <th>Dernier résultat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.data?.items.map((d) => (
                <tr key={d.id}>
                  <td>{frDateTime(d.createdAt)}</td>
                  <td>
                    <code>{d.eventType === "ping" ? "test" : d.eventType}</code>
                  </td>
                  <td>
                    <Badge tone={DELIVERY_STATUS[d.status].tone}>{DELIVERY_STATUS[d.status].label}</Badge>
                    {d.status === "pending" && d.attempts > 0 ? <div className="cap">nouvel essai {frDateTime(d.nextAttemptAt)}</div> : null}
                  </td>
                  <td>{d.attempts}</td>
                  <td>{d.status === "delivered" ? `HTTP ${d.lastStatusCode ?? ""}` : (d.lastError ?? "")}</td>
                  <td style={{ textAlign: "right" }}>
                    {d.status === "failed" && d.auditId !== null ? (
                      <button type="button" className="btn btn-g" disabled={retry.isPending || !endpoint.active} onClick={() => retry.mutate(d.id)}>
                        Renvoyer
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}

function Webhooks() {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Endpoint | "new" | null>(null);
  const [log, setLog] = useState<Endpoint | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const endpoints = useQuery({ queryKey: ["webhooks"], queryFn: () => api.get<Endpoint[]>("/integrations/webhooks") });
  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ status: "delivered" | "failed"; statusCode: number | null; error: string | null }>(`/integrations/webhooks/${id}/test`),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["webhook-deliveries"] });
      toast(result.status === "delivered" ? `Test reçu (HTTP ${result.statusCode}).` : `Test en échec : ${result.error ?? "sans réponse"}.`);
    },
  });
  return (
    <Card
      title="Webhooks"
      actions={
        <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
          + Nouveau webhook
        </button>
      }
    >
      <p className="cap card-b">
        Chaque modification enregistrée au journal d'audit peut être envoyée à un outil externe, signée. L'envoi ne contient que des identifiants : l'outil
        relit le détail avec un jeton d'accès.
      </p>
      <ErrorBanner error={endpoints.error ?? test.error} />
      {endpoints.isPending ? (
        <Loading />
      ) : endpoints.data?.length === 0 ? (
        <Empty title="Aucun webhook" text="Ajoutez l'adresse du nœud Webhook de n8n pour recevoir les événements du centre." />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Adresse</th>
                <th>Événements</th>
                <th>État</th>
                <th>En attente</th>
                <th>Échecs</th>
                <th>Dernier envoi réussi</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {endpoints.data?.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td style={{ wordBreak: "break-all" }}>{e.url}</td>
                  <td>
                    {e.events.map((ev) => (
                      <code key={ev} style={{ marginRight: 4 }}>
                        {ev}
                      </code>
                    ))}
                  </td>
                  <td>{e.active ? <Badge tone="green">Actif</Badge> : <Badge tone="gray">Désactivé</Badge>}</td>
                  <td className="num">{e.pending}</td>
                  <td className="num">{e.failed ? <Badge tone="red">{e.failed}</Badge> : 0}</td>
                  <td>{e.lastDeliveredAt ? frDateTime(e.lastDeliveredAt) : "Jamais"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn-g" disabled={test.isPending} onClick={() => test.mutate(e.id)}>
                      Tester
                    </button>
                    <button type="button" className="btn btn-g" onClick={() => setLog(e)}>
                      Envois
                    </button>
                    <button type="button" className="btn btn-g" onClick={() => setEditing(e)}>
                      Modifier
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <EndpointModal endpoint={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSecret={setSecret} /> : null}
      {log ? <DeliveriesDrawer endpoint={log} onClose={() => setLog(null)} /> : null}
      {secret ? (
        <SecretModal
          title="Secret de signature"
          secret={secret}
          explanation="Enregistrez ce secret dans n8n : il sert à vérifier que chaque envoi vient bien de GCF (en-tête x-gcf-signature)."
          onClose={() => setSecret(null)}
        />
      ) : null}
    </Card>
  );
}

export function IntegrationsPage() {
  usePage(["Paramètres", "Intégrations"]);
  const [tab, setTab] = useState<"tokens" | "webhooks">("tokens");
  return (
    <>
      <PageHeader title="Intégrations" subtitle="Relier GCF à n8n et à d'autres outils : jetons d'accès à l'API et envoi des événements." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "tokens", label: "Jetons d'accès" },
          { value: "webhooks", label: "Webhooks" },
        ]}
      />
      {tab === "tokens" ? <Tokens /> : <Webhooks />}
    </>
  );
}

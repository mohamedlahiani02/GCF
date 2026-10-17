import { isHttpsUrl, SITE_LANGUAGES, type SiteLanguage } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader } from "../../components/ui";
import { frDate } from "../../lib/format";
import { fetchSettings, LANGUAGE_LABEL, siteKeys, type Redirect, type SiteSettings } from "./api";
import { ConfirmDialog } from "./common";

const TEXT_FIELDS = [
  "siteName",
  "tagline",
  "contactEmail",
  "contactPhone",
  "address",
  "mapUrl",
  "facebookUrl",
  "instagramUrl",
  "linkedinUrl",
  "seoDescription",
  "footerText",
] as const;
type TextField = (typeof TEXT_FIELDS)[number];
const URL_FIELDS: readonly TextField[] = ["mapUrl", "facebookUrl", "instagramUrl", "linkedinUrl"];

const urlError = (value: string) => (value.trim() && !isHttpsUrl(value.trim()) ? "Adresse https:// attendue." : null);

function OnlineCard({ settings }: { settings: SiteSettings }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const next = !settings.online;
  return (
    <Card
      title="Mise en ligne"
      actions={
        can("website:publish") ? (
          <button type="button" className={settings.online ? "btn btn-d" : "btn btn-p"} onClick={() => setConfirming(true)}>
            {settings.online ? "Mettre hors ligne" : "Mettre en ligne"}
          </button>
        ) : null
      }
    >
      <div className="card-b row center" style={{ gap: 8 }}>
        {settings.online ? <Badge tone="green">En ligne</Badge> : <Badge tone="gray">Hors ligne</Badge>}
        <span className="cap">
          {settings.online
            ? "Les visiteurs voient les pages publiées."
            : "Les visiteurs ne voient aucune page ; vous pouvez préparer et prévisualiser le site."}
          {can("website:publish") ? "" : " Seuls les éditeurs du site et les administrateurs peuvent changer cet état."}
        </span>
      </div>
      {confirming ? (
        <ConfirmDialog
          title={next ? "Mettre le site en ligne" : "Mettre le site hors ligne"}
          confirmLabel={next ? "Mettre en ligne" : "Mettre hors ligne"}
          danger={!next}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await api.put("/site/settings", { online: next });
            await client.invalidateQueries({ queryKey: siteKeys.settings });
            toast(next ? "Le site est en ligne." : "Le site est hors ligne.");
          }}
        >
          {next
            ? "Les pages publiées deviennent visibles par tous les visiteurs."
            : "Plus aucune page n'est visible du public jusqu'à la remise en ligne. Les pages et leurs versions sont conservées."}
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}

function SettingsForm({ settings }: { settings: SiteSettings }) {
  const client = useQueryClient();
  const toast = useToast();
  const initial = Object.fromEntries(TEXT_FIELDS.map((f) => [f, settings[f] ?? ""])) as Record<TextField, string>;
  const [texts, setTexts] = useState(initial);
  const [languages, setLanguages] = useState<SiteLanguage[]>(settings.languages);
  const [defaultLanguage, setDefaultLanguage] = useState<SiteLanguage>(settings.defaultLanguage);
  const text = (field: TextField) => ({ value: texts[field], onChange: (e: { target: { value: string } }) => setTexts({ ...texts, [field]: e.target.value }) });
  const effectiveDefault = languages.includes(defaultLanguage) ? defaultLanguage : (languages[0] ?? defaultLanguage);
  const save = useMutation({
    mutationFn: () =>
      api.put<SiteSettings>("/site/settings", {
        ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, texts[f].trim()])),
        languages: SITE_LANGUAGES.filter((l) => languages.includes(l)),
        defaultLanguage: effectiveDefault,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: siteKeys.all });
      toast("Paramètres du site enregistrés.");
    },
  });
  const invalid = languages.length === 0 || URL_FIELDS.some((f) => urlError(texts[f]));
  const addedLanguages = languages.filter((l) => !settings.languages.includes(l));
  return (
    <Card
      title="Informations du site"
      footer={
        <>
          <span className="cap">Repris dans l'en-tête, le pied de page, la section contact et les moteurs de recherche.</span>
          <button type="button" className="btn btn-p" disabled={invalid || save.isPending} onClick={() => save.mutate()}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="card-b stack">
        <div className="grid2">
          <fieldset className="site-fieldset">
            <legend className="lab">Langues du site</legend>
            <div className="row" style={{ gap: 16 }}>
              {SITE_LANGUAGES.map((l) => (
                <label key={l} className="row center" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    className="chk"
                    checked={languages.includes(l)}
                    onChange={(e) => setLanguages(e.target.checked ? [...languages, l] : languages.filter((x) => x !== l))}
                  />
                  {LANGUAGE_LABEL[l]}
                </label>
              ))}
            </div>
            {languages.length === 0 ? <span className="err-text">Choisissez au moins une langue.</span> : null}
            {addedLanguages.length ? (
              <span className="cap">Chaque page devra recevoir un titre dans la nouvelle langue avant sa prochaine publication.</span>
            ) : null}
          </fieldset>
          <Field label="Langue par défaut" hint="Servie à la racine du site ; l'autre langue est servie sous son préfixe (/en).">
            <select className="input" value={effectiveDefault} onChange={(e) => setDefaultLanguage(e.target.value as SiteLanguage)}>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABEL[l]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid2">
          <Field label="Nom du site">
            <input className="input" maxLength={120} {...text("siteName")} />
          </Field>
          <Field label="Slogan">
            <input className="input" maxLength={200} {...text("tagline")} />
          </Field>
          <Field label="E-mail de contact">
            <input className="input" type="email" maxLength={254} {...text("contactEmail")} />
          </Field>
          <Field label="Téléphone de contact">
            <input className="input" type="tel" maxLength={40} {...text("contactPhone")} />
          </Field>
        </div>
        <Field label="Adresse" hint="Par défaut, l'adresse du centre.">
          <textarea className="input" maxLength={300} {...text("address")} />
        </Field>
        <Field label="Lien vers la carte" hint="Par exemple un lien Google Maps." error={urlError(texts.mapUrl)}>
          <input className="input" type="url" maxLength={500} {...text("mapUrl")} />
        </Field>
        <div className="grid3">
          <Field label="Page Facebook" error={urlError(texts.facebookUrl)}>
            <input className="input" type="url" maxLength={500} {...text("facebookUrl")} />
          </Field>
          <Field label="Compte Instagram" error={urlError(texts.instagramUrl)}>
            <input className="input" type="url" maxLength={500} {...text("instagramUrl")} />
          </Field>
          <Field label="Page LinkedIn" error={urlError(texts.linkedinUrl)}>
            <input className="input" type="url" maxLength={500} {...text("linkedinUrl")} />
          </Field>
        </div>
        <Field label="Description pour les moteurs de recherche" hint="Utilisée par les pages qui n'ont pas leur propre description.">
          <textarea className="input" maxLength={300} {...text("seoDescription")} />
        </Field>
        <Field label="Texte du pied de page">
          <textarea className="input" maxLength={1000} {...text("footerText")} />
        </Field>
        <ErrorBanner error={save.error} />
      </div>
    </Card>
  );
}

function RedirectModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [fromPath, setFromPath] = useState("/");
  const [toPath, setToPath] = useState("/");
  const pathError = (p: string) => (/^\/[^?#\s]*$/.test(p.trim()) ? null : "Chemin commençant par /, sans espace ni « ? » ni « # ».");
  const create = useMutation({
    mutationFn: () => api.post<Redirect>("/site/redirects", { fromPath: fromPath.trim(), toPath: toPath.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: siteKeys.redirects });
      toast("Redirection ajoutée.");
      onClose();
    },
  });
  return (
    <Modal
      title="Nouvelle redirection"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Redirection permanente (301)</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!!pathError(fromPath) || !!pathError(toPath) || fromPath.trim() === toPath.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Ajouter
            </button>
          </div>
        </>
      }
    >
      <Field label="Ancienne adresse *" hint="Par exemple /ancienne-page" error={pathError(fromPath)}>
        <input className="input" maxLength={300} value={fromPath} onChange={(e) => setFromPath(e.target.value)} />
      </Field>
      <Field label="Nouvelle adresse *" error={pathError(toPath)}>
        <input className="input" maxLength={300} value={toPath} onChange={(e) => setToPath(e.target.value)} />
      </Field>
      <ErrorBanner error={create.error} />
    </Modal>
  );
}

function RedirectsCard() {
  const client = useQueryClient();
  const toast = useToast();
  const redirects = useQuery({ queryKey: siteKeys.redirects, queryFn: () => api.get<Redirect[]>("/site/redirects") });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Redirect | null>(null);
  return (
    <Card
      title="Redirections"
      actions={
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          + Redirection
        </button>
      }
    >
      <ErrorBanner error={redirects.error} retry={() => redirects.refetch()} />
      {redirects.isPending ? (
        <Loading />
      ) : redirects.data?.length === 0 ? (
        <Empty title="Aucune redirection" text="Les pages publiées qui changent d'adresse sont redirigées automatiquement." />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Ancienne adresse</th>
                <th>Nouvelle adresse</th>
                <th>Origine</th>
                <th>Créée le</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {redirects.data?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code className="site-path">{r.fromPath}</code>
                  </td>
                  <td>
                    <code className="site-path">{r.toPath}</code>
                  </td>
                  <td>{r.automatic ? <Badge tone="blue">Automatique</Badge> : <Badge tone="neutral">Manuelle</Badge>}</td>
                  <td>{frDate(r.createdAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn btn-g" aria-label={`Supprimer la redirection ${r.fromPath}`} onClick={() => setDeleting(r)}>
                      Supprimer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding ? <RedirectModal onClose={() => setAdding(false)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title="Supprimer la redirection"
          confirmLabel="Supprimer"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/site/redirects/${deleting.id}`);
            await client.invalidateQueries({ queryKey: siteKeys.redirects });
            toast("Redirection supprimée.");
          }}
        >
          Les visiteurs de {deleting.fromPath} ne seront plus redirigés vers {deleting.toPath}.
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}

export function SiteSettingsPage() {
  usePage(["Site web", "Paramètres du site"]);
  const settings = useQuery({ queryKey: siteKeys.settings, queryFn: fetchSettings });
  return (
    <>
      <PageHeader title="Paramètres du site" subtitle="Mise en ligne, langues, coordonnées et redirections." />
      <ErrorBanner error={settings.error} retry={() => settings.refetch()} />
      {settings.isPending ? (
        <Loading />
      ) : settings.data ? (
        <>
          <OnlineCard settings={settings.data} />
          <SettingsForm key={settings.data.updatedAt} settings={settings.data} />
          <RedirectsCard />
        </>
      ) : null}
    </>
  );
}

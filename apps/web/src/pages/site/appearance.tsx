import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { api, ApiError } from "../../api/client";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Card, ErrorBanner, Field, Loading, PageHeader, Segmented } from "../../components/ui";
import {
  contrastWithWhite,
  fetchPages,
  fetchSettings,
  flattenPages,
  mediaFileUrl,
  MIN_CONTRAST,
  ratioText,
  siteKeys,
  type ColorScheme,
  type SiteFont,
  type SiteRadius,
  type SiteSettings,
  type SiteTheme,
} from "./api";
import { ImageField } from "./media";

const THEMES: { value: SiteTheme; label: string; description: string }[] = [
  {
    value: "corporate",
    label: "Institutionnel",
    description: "Bandeau principal dans la couleur principale, titres de section marqués d'un trait, cartes sobres sans ombre.",
  },
  {
    value: "creative",
    label: "Créatif",
    description: "Bandeau en dégradé de la couleur principale vers la secondaire, titres plus appuyés, cartes ombrées qui se soulèvent au survol.",
  },
  {
    value: "minimal",
    label: "Épuré",
    description: "Bandeau sur le fond de la page, peu d'ornements, cartes réduites à un filet ; la couleur principale reste sur les boutons.",
  },
];

const FONTS: { value: SiteFont; label: string; stack: string }[] = [
  { value: "system", label: "Police du système", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
  { value: "serif", label: "Serif classique (Georgia)", stack: 'Georgia, Cambria, "Times New Roman", serif' },
  { value: "plex", label: "IBM Plex Sans", stack: '"IBM Plex Sans", system-ui, sans-serif' },
  { value: "inter", label: "Inter", stack: "Inter, system-ui, sans-serif" },
  { value: "poppins", label: "Poppins", stack: "Poppins, system-ui, sans-serif" },
];

const RADII: { value: SiteRadius; label: string; css: string }[] = [
  { value: "none", label: "Droits", css: "0" },
  { value: "small", label: "Légèrement arrondis", css: "6px" },
  { value: "large", label: "Très arrondis", css: "16px" },
];

// Neutral colours of the site's light and dark schemes, for the preview only.
const SCHEMES: Record<ColorScheme, { bg: string; surface: string; text: string; muted: string; border: string }> = {
  light: { bg: "#ffffff", surface: "#f4f6f8", text: "#111827", muted: "#4b5563", border: "#d9dee5" },
  dark: { bg: "#0b1120", surface: "#131c2e", text: "#e5e7eb", muted: "#a3acb9", border: "#2a3549" },
};

type Appearance = Pick<SiteSettings, "theme" | "primaryColor" | "secondaryColor" | "font" | "radius" | "colorScheme" | "logoMediaId" | "faviconMediaId">;

const HEX = /^#[0-9a-fA-F]{6}$/;

function ColorField({ label, value, onChange, apiRatio }: { label: string; value: string; onChange: (v: string) => void; apiRatio: number | null }) {
  const [text, setText] = useState(value);
  const valid = HEX.test(text);
  const ratio = HEX.test(value) ? contrastWithWhite(value) : null;
  const low = apiRatio !== null || (ratio !== null && ratio < MIN_CONTRAST);
  const shown = apiRatio ?? ratio;
  return (
    <div className="field">
      <span className="lab">{label}</span>
      <div className="row center" style={{ gap: 8, flexWrap: "nowrap" }}>
        <input
          type="color"
          className="site-color"
          aria-label={`${label} (sélecteur)`}
          value={HEX.test(value) ? value.toLowerCase() : "#000000"}
          onChange={(e) => (setText(e.target.value), onChange(e.target.value))}
        />
        <input
          className={`input${valid ? "" : " err"}`}
          aria-label={`${label} (code hexadécimal)`}
          value={text}
          maxLength={7}
          style={{ maxWidth: 120 }}
          onChange={(e) => {
            setText(e.target.value);
            if (HEX.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
        />
        <span className="site-contrast" style={{ background: HEX.test(value) ? value : undefined }} aria-hidden="true">
          Aa
        </span>
      </div>
      {!valid ? <span className="err-text">Code attendu au format #rrggbb.</span> : null}
      {shown !== null ? (
        low ? (
          <span className="err-text" role="alert">
            Contraste avec le texte blanc : {ratioText(shown)} (minimum {ratioText(MIN_CONTRAST)}). Choisissez une couleur plus foncée.
          </span>
        ) : (
          <span className="cap">Contraste avec le texte blanc : {ratioText(shown)}, lisible.</span>
        )
      ) : null}
    </div>
  );
}

/** A small rendering of a page with the chosen theme, colours, font, corners and scheme. */
function MiniPreview({ value, siteName, logoId }: { value: Appearance; siteName: string; logoId: string | null }) {
  const scheme = SCHEMES[value.colorScheme];
  const dark = value.colorScheme === "dark";
  const radius = RADII.find((r) => r.value === value.radius)?.css ?? "6px";
  const font = FONTS.find((f) => f.value === value.font)?.stack;
  const accent = dark ? scheme.text : value.primaryColor;
  const hero: CSSProperties =
    value.theme === "creative"
      ? { background: `linear-gradient(135deg, ${value.primaryColor}, ${value.secondaryColor})`, color: "#fff" }
      : value.theme === "minimal"
        ? { background: scheme.bg, color: scheme.text, borderBottom: `1px solid ${scheme.border}` }
        : { background: value.primaryColor, color: "#fff" };
  const heroButton: CSSProperties =
    value.theme === "minimal" ? { background: value.primaryColor, color: "#fff" } : { background: "#fff", color: value.primaryColor };
  const card: CSSProperties =
    value.theme === "minimal"
      ? { borderBottom: `1px solid ${scheme.border}`, padding: "10px 0" }
      : {
          border: `1px solid ${scheme.border}`,
          borderRadius: radius,
          padding: 12,
          background: scheme.bg,
          boxShadow: value.theme === "creative" ? "0 6px 18px rgba(0,0,0,.08)" : "none",
        };
  return (
    <div className="site-mini" style={{ background: scheme.bg, color: scheme.text, fontFamily: font, borderColor: scheme.border }} aria-label="Aperçu du thème">
      <div className="site-mini-header" style={{ borderBottomColor: value.theme === "minimal" ? "transparent" : scheme.border }}>
        <strong className="row center" style={{ gap: 8 }}>
          {logoId ? <img src={mediaFileUrl(logoId)} alt="" style={{ maxHeight: 24 }} /> : null}
          {siteName}
        </strong>
        <span style={{ fontSize: 12 }}>Accueil · Espaces · Tarifs · Contact</span>
      </div>
      <div className="site-mini-hero" style={hero}>
        <div style={{ fontWeight: value.theme === "creative" ? 800 : 700, fontSize: 20 }}>Un espace pour travailler et apprendre</div>
        <div style={{ fontSize: 13, opacity: 0.9 }}>Postes, bureaux et salles de réunion au cœur de la ville.</div>
        <span className="site-mini-btn" style={{ ...heroButton, borderRadius: radius }}>
          Réserver
        </span>
      </div>
      <div style={{ padding: 16, display: "grid", gap: 10 }}>
        <div
          style={{
            fontWeight: 700,
            borderLeft: value.theme === "corporate" ? `4px solid ${accent}` : undefined,
            paddingLeft: value.theme === "corporate" ? 8 : 0,
          }}
        >
          Nos espaces
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {["Poste flexible", "Bureau privé"].map((name) => (
            <div key={name} style={card}>
              <div style={{ fontWeight: 600 }}>{name}</div>
              <div style={{ fontSize: 12, color: scheme.muted }}>À partir de 15 TND</div>
              <span style={{ fontSize: 12, color: accent, textDecoration: "underline" }}>En savoir plus</span>
            </div>
          ))}
        </div>
        <div
          style={{
            background: value.theme === "creative" ? value.secondaryColor : value.primaryColor,
            color: "#fff",
            borderRadius: radius,
            padding: 12,
            textAlign: "center",
          }}
        >
          Envie de visiter ? <span className="site-mini-btn" style={{ background: "#fff", color: value.primaryColor, borderRadius: radius }}>Nous contacter</span>
        </div>
      </div>
    </div>
  );
}

function pickAppearance(s: SiteSettings): Appearance {
  return {
    theme: s.theme,
    primaryColor: s.primaryColor,
    secondaryColor: s.secondaryColor,
    font: s.font,
    radius: s.radius,
    colorScheme: s.colorScheme,
    logoMediaId: s.logoMediaId,
    faviconMediaId: s.faviconMediaId,
  };
}

function AppearanceForm({ settings, homeId }: { settings: SiteSettings; homeId: string | null }) {
  const client = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState<Appearance>(() => pickAppearance(settings));
  const save = useMutation({
    mutationFn: () => api.put<SiteSettings>("/site/settings", value),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: siteKeys.settings });
      toast("Apparence enregistrée. Elle s'applique immédiatement au site.");
    },
  });
  const set = <K extends keyof Appearance>(key: K, v: Appearance[K]) => {
    save.reset();
    setValue((current) => ({ ...current, [key]: v }));
  };
  const contrast =
    save.error instanceof ApiError && save.error.code === "low_contrast"
      ? (save.error.details as { field: "primaryColor" | "secondaryColor"; ratio: number } | undefined)
      : undefined;
  const changed = JSON.stringify(value) !== JSON.stringify(pickAppearance(settings));
  const invalid = !HEX.test(value.primaryColor) || !HEX.test(value.secondaryColor);
  return (
    <div className="grid2" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", alignItems: "start" }}>
      <Card
        title="Thème et couleurs"
        footer={
          <>
            <span className="cap">Les couleurs portent du texte blanc : un contraste d'au moins 4,5:1 est exigé.</span>
            <button type="button" className="btn btn-p" disabled={!changed || invalid || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </>
        }
      >
        <div className="card-b stack">
          <fieldset className="site-fieldset">
            <legend className="lab">Thème</legend>
            <div className="stack" style={{ gap: 8 }}>
              {THEMES.map((t) => (
                <label key={t.value} className={`site-choice${value.theme === t.value ? " on" : ""}`}>
                  <input type="radio" name="theme" className="chk" checked={value.theme === t.value} onChange={() => set("theme", t.value)} />
                  <span>
                    <strong>{t.label}</strong>
                    <span className="cap" style={{ display: "block" }}>
                      {t.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid2">
            <ColorField
              label="Couleur principale"
              value={value.primaryColor}
              onChange={(v) => set("primaryColor", v)}
              apiRatio={contrast?.field === "primaryColor" ? contrast.ratio : null}
            />
            <ColorField
              label="Couleur secondaire"
              value={value.secondaryColor}
              onChange={(v) => set("secondaryColor", v)}
              apiRatio={contrast?.field === "secondaryColor" ? contrast.ratio : null}
            />
          </div>
          <div className="grid2">
            <Field label="Police">
              <select className="input" value={value.font} onChange={(e) => set("font", e.target.value as SiteFont)}>
                {FONTS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field">
              <span className="lab">Fond</span>
              <Segmented
                label="Fond du site"
                value={value.colorScheme}
                onChange={(v) => set("colorScheme", v)}
                options={[
                  { value: "light", label: "Clair" },
                  { value: "dark", label: "Sombre" },
                ]}
              />
            </div>
          </div>
          <div className="field">
            <span className="lab">Angles des boutons et cartes</span>
            <Segmented label="Angles" value={value.radius} onChange={(v) => set("radius", v)} options={RADII.map((r) => ({ value: r.value, label: r.label }))} />
          </div>
          <div className="grid2">
            <ImageField label="Logo" value={value.logoMediaId} onChange={(id) => set("logoMediaId", id)} hint="Affiché dans l'en-tête du site." />
            <ImageField
              label="Icône d'onglet (favicon)"
              value={value.faviconMediaId}
              onChange={(id) => set("faviconMediaId", id)}
              hint="Image carrée, au moins 64 × 64 px."
            />
          </div>
          {contrast ? null : <ErrorBanner error={save.error} />}
        </div>
      </Card>
      <Card
        title="Aperçu"
        actions={
          homeId ? (
            <a className="btn" href={api.fileUrl(`/site/pages/${homeId}/preview`)} target="_blank" rel="noreferrer">
              Aperçu de la page d'accueil
              <span className="visually-hidden"> (nouvel onglet)</span>
            </a>
          ) : null
        }
      >
        <div className="card-b stack">
          <MiniPreview value={value} siteName={settings.siteName ?? "Votre site"} logoId={value.logoMediaId} />
          <span className="cap">
            {homeId
              ? "L'aperçu de la page d'accueil utilise l'apparence enregistrée : enregistrez d'abord vos changements."
              : "Choisissez une page d'accueil dans « Pages » pour l'ouvrir en aperçu."}
          </span>
        </div>
      </Card>
    </div>
  );
}


export function AppearancePage() {
  usePage(["Site web", "Apparence"]);
  const settings = useQuery({ queryKey: siteKeys.settings, queryFn: fetchSettings });
  const pages = useQuery({ queryKey: siteKeys.pages, queryFn: fetchPages });
  const home = flattenPages(pages.data ?? []).find((p) => p.page.isHome)?.page;
  return (
    <>
      <PageHeader title="Apparence du site" subtitle="Thème, couleurs, police et logo, communs à toutes les pages." />
      <ErrorBanner error={settings.error ?? pages.error} retry={() => (settings.refetch(), pages.refetch())} />
      {settings.isPending ? <Loading /> : settings.data ? <AppearanceForm settings={settings.data} homeId={home?.id ?? null} /> : null}
    </>
  );
}

import type { SiteFont, SiteTheme } from "../db/types.website.js";

export interface ThemeSettings {
  theme: SiteTheme;
  primary_color: string;
  secondary_color: string;
  font: SiteFont;
  radius: "none" | "small" | "large";
  color_scheme: "light" | "dark";
}

const FONT_STACKS: Record<SiteFont, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  plex: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  inter: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  poppins: 'Poppins, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
};

const GOOGLE_FAMILIES: Partial<Record<SiteFont, string>> = {
  plex: "IBM+Plex+Sans:wght@400;600;700",
  inter: "Inter:wght@400;600;700",
  poppins: "Poppins:wght@400;600;700",
};

/** Stylesheet address of the web font, or null for the local font stacks. */
export function googleFontsHref(font: SiteFont): string | null {
  const family = GOOGLE_FAMILIES[font];
  return family ? `https://fonts.googleapis.com/css2?family=${family}&display=swap` : null;
}

const RADII = { none: "0", small: "6px", large: "16px" } as const;

// Neutral colours of each scheme; body text reaches at least 7:1 and muted text 4.5:1 on the background.
const SCHEMES = {
  light: { bg: "#ffffff", surface: "#f4f6f8", text: "#111827", muted: "#4b5563", border: "#d9dee5" },
  dark: { bg: "#0b1120", surface: "#131c2e", text: "#e5e7eb", muted: "#a3acb9", border: "#2a3549" },
} as const;

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:1.0625rem;line-height:1.6}
img{max-width:100%;height:auto;display:block}
a{color:var(--link);text-underline-offset:.15em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
h1,h2,h3{line-height:1.2;margin:0 0 .6em;font-weight:var(--heading-weight)}
h1{font-size:clamp(2rem,5vw,var(--h1))}
h2{font-size:clamp(1.5rem,3.5vw,2rem)}
h3{font-size:1.2rem}
p{margin:0 0 1em}
.wrap{width:100%;max-width:1120px;margin:0 auto;padding:0 1.25rem}
.skip{position:absolute;left:-9999px;top:0;z-index:100;background:var(--bg);color:var(--text);padding:.75rem 1rem;border:2px solid var(--focus)}
.skip:focus{left:1rem;top:1rem}
.preview-banner{background:#fde68a;color:#111827;text-align:center;padding:.5rem 1rem;font-weight:700}
.site-header{background:var(--header-bg);color:var(--header-text);border-bottom:1px solid var(--border)}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:4.5rem;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.75rem;color:inherit;text-decoration:none;font-weight:700;font-size:1.2rem}
.brand img{max-height:44px;width:auto}
.nav-toggle{display:none;font:inherit;background:transparent;color:inherit;border:1px solid currentColor;border-radius:var(--radius);padding:.4rem .8rem;cursor:pointer}
.site-nav{display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap}
.site-nav ul{list-style:none;margin:0;padding:0}
.menu{display:flex;gap:1.25rem;flex-wrap:wrap}
.menu>li{position:relative}
.menu a{color:inherit;text-decoration:none;padding:.35rem 0;display:inline-block}
.menu a:hover,.menu a[aria-current="page"]{text-decoration:underline}
.submenu{display:none;position:absolute;left:0;top:100%;min-width:12rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:.5rem 1rem;z-index:10}
.menu>li:hover>.submenu,.menu>li:focus-within>.submenu{display:block}
.lang-switch{display:flex;gap:.75rem}
.lang-switch a{color:inherit}
.btn{display:inline-block;font:inherit;font-weight:600;text-decoration:none;border-radius:var(--radius);padding:.7rem 1.3rem;border:2px solid transparent;cursor:pointer;line-height:1.2}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{filter:brightness(.92)}
.btn-ghost{background:transparent;color:inherit;border-color:currentColor}
main{display:block}
main:focus{outline:none}
.sec{padding:var(--section-pad) 0}
.sec-alt{background:var(--surface)}
.sec-head{max-width:46rem;margin-bottom:2rem}
.sec-head p{color:var(--muted)}
.page-head{padding-top:var(--section-pad)}
.page-head .meta{color:var(--muted)}
.hero{background:var(--hero-bg);color:var(--hero-text);padding:calc(var(--section-pad)*1.4) 0}
.hero-inner{display:grid;gap:2rem;align-items:center}
.hero-inner.has-image{grid-template-columns:1fr}
.hero p{font-size:1.2rem;max-width:40rem}
.hero .btn-primary{background:var(--hero-button-bg);color:var(--hero-button-text)}
.hero img{border-radius:var(--radius)}
.prose{max-width:46rem}
.prose ul,.prose ol{padding-left:1.4rem;margin:0 0 1em}
.grid{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))}
.card{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;box-shadow:var(--shadow)}
.card img{border-radius:calc(var(--radius) / 2);margin-bottom:1rem}
.card .muted,.muted{color:var(--muted)}
.icon{color:var(--accent);margin-bottom:.75rem}
.price{font-size:1.4rem;font-weight:700;margin:.25rem 0}
.tbl{width:100%;border-collapse:collapse}
.tbl th,.tbl td{text-align:left;padding:.65rem .5rem;border-bottom:1px solid var(--border);vertical-align:top}
.tbl th[scope="col"]{color:var(--muted);font-weight:600}
.tbl td.num,.tbl th.num{text-align:right;white-space:nowrap}
.table-scroll{overflow-x:auto}
.gallery{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));margin:0;padding:0;list-style:none}
.gallery figure,figure.quote{margin:0}
.gallery figcaption{color:var(--muted);font-size:.95rem;margin-top:.4rem}
blockquote{margin:0}
.quote p{font-size:1.1rem}
.faq details{border-bottom:1px solid var(--border);padding:.9rem 0}
.faq summary{cursor:pointer;font-weight:600}
.faq details>div{margin-top:.6rem}
.contact-grid{display:grid;gap:2rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}
.contact-grid dl{margin:0}
.contact-grid dt{font-weight:600}
.contact-grid dd{margin:0 0 .8rem}
.hours{list-style:none;padding:0;margin:0}
.lead-form{display:grid;gap:1rem;max-width:40rem}
.field{display:grid;gap:.35rem}
.field label{font-weight:600}
.field input,.field textarea{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--muted);border-radius:var(--radius);padding:.6rem .75rem;width:100%}
.field textarea{min-height:8rem}
.hint{color:var(--muted);font-size:.95rem;margin:0}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.notice{border-radius:var(--radius);padding:.9rem 1rem;margin-bottom:1rem;border:2px solid var(--accent)}
fieldset{border:0;margin:0;padding:0;min-width:0}
.cta{background:var(--cta-bg);color:#fff;border-radius:var(--radius);padding:2.5rem;text-align:center}
.cta .btn-primary{background:#fff;color:var(--cta-bg)}
.cta a:not(.btn){color:#fff}
.articles{list-style:none;margin:0;padding:0}
.site-footer{background:var(--surface);border-top:1px solid var(--border);padding:3rem 0 1.5rem;margin-top:var(--section-pad);color:var(--text)}
.footer-grid{display:grid;gap:2rem;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))}
.site-footer h2{font-size:1rem;margin-bottom:.75rem}
.site-footer ul{list-style:none;margin:0;padding:0}
.site-footer li{margin-bottom:.4rem}
.site-footer a{color:var(--text)}
.copyright{color:var(--muted);font-size:.9rem;margin-top:2rem}
@media (min-width:860px){.hero-inner.has-image{grid-template-columns:1.1fr .9fr}}
@media (max-width:859px){
.js .nav-toggle{display:inline-block}
.js .site-nav{display:none;width:100%;flex-direction:column;align-items:flex-start;padding-bottom:1rem}
.js .site-nav.open{display:flex}
.menu{flex-direction:column;gap:.25rem}
.submenu{display:block;position:static;border:0;padding:0 0 0 1rem;background:transparent;color:inherit}
}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;

const THEME_CSS: Record<SiteTheme, string> = {
  corporate: `
:root{--heading-weight:700;--h1:3rem;--section-pad:4rem;--shadow:none;--header-bg:var(--bg);--header-text:var(--text);--hero-bg:var(--primary);--hero-text:#fff;--hero-button-bg:#fff;--hero-button-text:var(--primary);--cta-bg:var(--primary);--card-bg:var(--bg)}
.sec-head h2{border-left:4px solid var(--accent);padding-left:.75rem}
`,
  creative: `
:root{--heading-weight:800;--h1:3.6rem;--section-pad:5rem;--shadow:0 10px 30px rgba(0,0,0,.08);--header-bg:var(--bg);--header-text:var(--text);--hero-bg:linear-gradient(135deg,var(--primary),var(--secondary));--hero-text:#fff;--hero-button-bg:#fff;--hero-button-text:var(--primary);--cta-bg:var(--secondary);--card-bg:var(--bg)}
.sec-head h2::after{content:"";display:block;width:3.5rem;height:4px;margin-top:.6rem;background:var(--accent);border-radius:2px}
.card{transition:transform .2s ease}
.card:hover{transform:translateY(-3px)}
`,
  minimal: `
:root{--heading-weight:600;--h1:2.75rem;--section-pad:4.5rem;--shadow:none;--header-bg:var(--bg);--header-text:var(--text);--hero-bg:var(--bg);--hero-text:var(--text);--hero-button-bg:var(--primary);--hero-button-text:#fff;--cta-bg:var(--primary);--card-bg:transparent}
.site-header{border-bottom-color:transparent}
.hero{border-bottom:1px solid var(--border)}
.card{border-width:0 0 1px;border-radius:0;padding:1.25rem 0}
`,
};

/** The stylesheet of the site: theme rules over the settings expressed as CSS custom properties. */
export function themeCss(settings: ThemeSettings): string {
  const scheme = SCHEMES[settings.color_scheme];
  const dark = settings.color_scheme === "dark";
  const vars = [
    `--primary:${settings.primary_color}`,
    `--secondary:${settings.secondary_color}`,
    `--bg:${scheme.bg}`,
    `--surface:${scheme.surface}`,
    `--text:${scheme.text}`,
    `--muted:${scheme.muted}`,
    `--border:${scheme.border}`,
    // On a dark background the brand colour may be too dark for text: links and accents then use the text colour.
    `--link:${dark ? scheme.text : settings.primary_color}`,
    `--accent:${dark ? scheme.text : settings.primary_color}`,
    `--focus:${dark ? "#fbbf24" : settings.primary_color}`,
    `--radius:${RADII[settings.radius]}`,
    `--font:${FONT_STACKS[settings.font]}`,
    `color-scheme:${settings.color_scheme}`,
  ].join(";");
  return `:root{${vars}}${THEME_CSS[settings.theme]}${BASE_CSS}`.replace(/\n/g, "");
}

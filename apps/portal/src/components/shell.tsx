import { SITE_LANGUAGES } from "@gcf/shared";
import { NavLink, Outlet, useNavigate } from "react-router";
import { usePortal } from "../auth/session";
import { useI18n } from "../i18n/i18n";

function Brand() {
  const { info } = usePortal();
  const { t } = useI18n();
  const name = info?.centre.name ?? t.common.appName;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
  return (
    <NavLink to="/" className="brand portal-brand">
      {info?.logoUrl ? (
        <img className="portal-logo" src={info.logoUrl} alt="" />
      ) : (
        <span className="logo" aria-hidden="true">
          {initials}
        </span>
      )}
      <span>
        <span className="h2">{name}</span>
        <span className="cap portal-brand-sub">{t.common.appName}</span>
      </span>
    </NavLink>
  );
}

export function LanguageSwitch() {
  const { t, language, setLanguage } = useI18n();
  return (
    <div className="seg" role="group" aria-label={t.common.language}>
      {SITE_LANGUAGES.map((l) => (
        <button
          key={l}
          type="button"
          className="btn"
          lang={l}
          aria-label={t.common.languageNames[l]}
          aria-pressed={l === language}
          onClick={() => setLanguage(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** Header, navigation of a signed-in member and the page. */
export function Shell() {
  const { member, signOut } = usePortal();
  const { t } = useI18n();
  const navigate = useNavigate();
  const links: [string, string][] = [
    ["/", t.nav.dashboard],
    ["/reserver", t.nav.book],
    ["/reservations", t.nav.bookings],
    ["/abonnement", t.nav.subscription],
    ["/packs", t.nav.packs],
    ["/courrier", t.nav.mail],
    ["/paiements", t.nav.payments],
    ["/compte", t.nav.account],
    ...(member?.company?.role === "admin" ? ([["/equipe", t.nav.team]] as [string, string][]) : []),
  ];
  return (
    <div className="portal">
      <header className="top portal-top">
        <Brand />
        <div className="row center" style={{ gap: 8 }}>
          <LanguageSwitch />
          {member ? (
            <button
              type="button"
              className="btn btn-g"
              onClick={async () => {
                await signOut();
                navigate("/connexion", { replace: true });
              }}
            >
              {t.common.signOut}
            </button>
          ) : null}
        </div>
      </header>
      {member ? (
        <nav className="portal-nav" aria-label={t.common.mainNav}>
          <ul className="tabs">
            {links.map(([to, label]) => (
              <li key={to}>
                <NavLink to={to} end={to === "/"} className="tab">
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <main className="page portal-page">
        <Outlet />
      </main>
    </div>
  );
}

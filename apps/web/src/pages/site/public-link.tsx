import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../auth/session";
import { fetchSettings, siteKeys } from "./api";

export function PublicSiteLink() {
  const { can } = useSession();
  const allowed = can("website:edit");
  const settings = useQuery({ queryKey: siteKeys.settings, queryFn: fetchSettings, enabled: allowed });
  if (!allowed) return null;
  const origin = settings.data?.publicOrigin;
  if (!origin || !/^https?:\/\//.test(origin)) {
    return (
      <button
        className="btn"
        type="button"
        disabled
        title={
          settings.isPending
            ? "Chargement de l’adresse du site"
            : settings.isError
              ? "Adresse du site momentanément indisponible"
              : "L’adresse publique du site doit être configurée"
        }
      >
        Visiter le site web
      </button>
    );
  }
  return (
    <a className="btn" href={origin} target="_blank" rel="noopener noreferrer">
      Visiter le site web <span aria-hidden="true">↗</span>
    </a>
  );
}

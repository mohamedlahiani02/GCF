import type { RouteObject } from "react-router";
import { RequirePermission } from "../../components/shell";
import { AppearancePage } from "./appearance";
import { PageEditorPage } from "./editor";
import { LeadsPage } from "./leads";
import { MediaPage } from "./media";
import { PagesPage } from "./pages";
import { SiteSettingsPage } from "./settings";

const guard = (permission: string, element: React.ReactNode) => <RequirePermission permission={permission}>{element}</RequirePermission>;

/** Website management: pages and sections, appearance, media, leads and settings. */
export const siteRoutes: RouteObject[] = [
  { path: "/site", element: guard("website:edit", <PagesPage />) },
  { path: "/site/pages/:id", element: guard("website:edit", <PageEditorPage />) },
  { path: "/site/apparence", element: guard("website:edit", <AppearancePage />) },
  { path: "/site/medias", element: guard("website:edit", <MediaPage />) },
  { path: "/site/demandes", element: guard("website:leads", <LeadsPage />) },
  { path: "/site/parametres", element: guard("website:edit", <SiteSettingsPage />) },
];

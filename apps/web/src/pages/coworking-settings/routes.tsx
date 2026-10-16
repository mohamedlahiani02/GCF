import type { RouteObject } from "react-router";
import { RequirePermission } from "../../components/shell";
import { FloorEditorPage } from "./planEditor";
import { CoworkingSettingsPage } from "./page";

/** Coworking configuration: floors and plan editor, resources, formats and prices, rules, plans and packs. */
export const coworkingSettingsRoutes: RouteObject[] = [
  {
    path: "/coworking/parametres",
    element: (
      <RequirePermission permission="coworking:manage">
        <CoworkingSettingsPage />
      </RequirePermission>
    ),
  },
  {
    path: "/coworking/parametres/etages/:id",
    element: (
      <RequirePermission permission="coworking:manage">
        <FloorEditorPage />
      </RequirePermission>
    ),
  },
];

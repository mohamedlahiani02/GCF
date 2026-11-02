import type { CwCategory } from "@gcf/shared";
import { api, ApiError } from "../../api/client";
import type { Resource } from "./api";
import { nextCodes } from "./helpers";

/** What a new place copies from its model (a pasted resource) or receives from a palette tile or a template. */
export interface ResourceSpec {
  typeId: string;
  category: CwCategory;
  capacity: number;
  zoneId: string | null;
  attributeIds: string[];
}

/** Another user may take a code between our read and our write: the codes are read again a few times. */
const CODE_ATTEMPTS = 3;

/**
 * Creates resources on a floor, one by one, each with the next free code of its type. The editor's undo does not
 * delete them: undoing only takes them off the plan, and they stay listed as places to put on the plan.
 * Stops at the first failure and returns what was created until then.
 */
export async function createResources(floorId: string, specs: ResourceSpec[]): Promise<{ created: Resource[]; error: unknown }> {
  const readAll = () => api.get<Resource[]>("/coworking/resources", { status: "all" });
  const created: Resource[] = [];
  let all: Resource[];
  try {
    all = await readAll();
  } catch (error) {
    return { created, error };
  }
  for (const spec of specs) {
    for (let attempt = 1; ; attempt += 1) {
      const codes = all.map((r) => r.code);
      const [code] = nextCodes(
        all.filter((r) => r.typeId === spec.typeId).map((r) => r.code),
        codes,
        spec.category,
        1,
      );
      try {
        const resource = await api.post<Resource>("/coworking/resources", {
          code,
          typeId: spec.typeId,
          floorId,
          zoneId: spec.zoneId,
          capacity: spec.capacity,
          attributeIds: spec.attributeIds,
        });
        created.push(resource);
        all = [...all, resource];
        break;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "code_taken" && attempt < CODE_ATTEMPTS)) return { created, error };
        try {
          all = await readAll();
        } catch (readError) {
          return { created, error: readError };
        }
      }
    }
  }
  return { created, error: null };
}

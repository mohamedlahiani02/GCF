import { z } from "zod";

/**
 * Layout of a coworking floor drawn over its plan image. Coordinates are fractions of the plan (0 = left or top
 * edge, 1 = right or bottom edge), so the same layout renders at any screen size. Without a plan image the
 * drawing area keeps the `aspect` ratio (width / height).
 */
export const PLAN_LIMITS = { items: 2000, labels: 200, areas: 100, areaPoints: 64 } as const;

const fraction = z.number().min(0).max(1);
const extent = z.number().gt(0).max(1);

export const planItemSchema = z
  .object({
    resourceId: z.string().uuid(),
    x: fraction,
    y: fraction,
    w: extent,
    h: extent,
    rotation: z.number().int().min(0).max(359),
    shape: z.enum(["rect", "ellipse"]),
  })
  .strict();

export const planLabelSchema = z
  .object({
    text: z.string().trim().min(1).max(60),
    x: fraction,
    y: fraction,
    size: z.enum(["s", "m", "l"]),
  })
  .strict();

export const planAreaSchema = z
  .object({
    zoneId: z.string().uuid(),
    points: z
      .array(z.tuple([fraction, fraction]))
      .min(3)
      .max(PLAN_LIMITS.areaPoints),
  })
  .strict();

export const floorLayoutSchema = z
  .object({
    aspect: z.number().min(0.25).max(4).default(1.6),
    items: z.array(planItemSchema).max(PLAN_LIMITS.items),
    labels: z.array(planLabelSchema).max(PLAN_LIMITS.labels).default([]),
    areas: z.array(planAreaSchema).max(PLAN_LIMITS.areas).default([]),
  })
  .strict()
  .refine((l) => new Set(l.items.map((i) => i.resourceId)).size === l.items.length, "a resource is placed only once per floor");

export type PlanItem = z.infer<typeof planItemSchema>;
export type PlanLabel = z.infer<typeof planLabelSchema>;
export type PlanArea = z.infer<typeof planAreaSchema>;
export type FloorLayout = z.infer<typeof floorLayoutSchema>;

export const EMPTY_LAYOUT: FloorLayout = { aspect: 1.6, items: [], labels: [], areas: [] };

/** Reads a stored layout, falling back to an empty one for rows written before a field existed. */
export function parseLayout(value: unknown): FloorLayout {
  const parsed = floorLayoutSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_LAYOUT;
}

import { z } from "zod";

/**
 * zod 3 → zod 4 semantics shims (BLO-48931).
 *
 * zod 3: `.optional()` short-circuits on `undefined`, so a `.default()` beneath
 * it never fires — an absent key stays absent. zod 4 delegates to a defaulted
 * inner schema, so the default fires. On a PATCH schema built with `.partial()`
 * that turns `{}` into "reset every defaulted field to its default".
 *
 * These helpers drop the default — dead under zod 3 — before making the field
 * optional, so input and output types are unchanged and absence is preserved.
 */
function stripDefault(schema: z.core.$ZodType): z.core.$ZodType {
  const def = schema._zod.def as { type: string; innerType?: z.core.$ZodType };
  if ((def.type === "default" || def.type === "prefault") && def.innerType) {
    return stripDefault(def.innerType);
  }
  if (def.type === "nullable" && def.innerType) {
    const inner = stripDefault(def.innerType);
    return inner === def.innerType ? schema : z.nullable(inner);
  }
  return schema;
}

/** `schema.optional()` with zod-3 semantics: absent stays absent. */
export function optionalNoDefault<T extends z.ZodType>(schema: T): z.ZodOptional<T> {
  return z.optional(stripDefault(schema)) as unknown as z.ZodOptional<T>;
}

/** `schema.partial()` with zod-3 semantics: absent keys stay absent. */
export function partialNoDefaults<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>,
) {
  const partial = schema.partial();
  const shape: Record<string, z.core.$ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = z.optional(stripDefault(field as z.core.$ZodType));
  }
  return partial.extend(shape) as unknown as typeof partial;
}

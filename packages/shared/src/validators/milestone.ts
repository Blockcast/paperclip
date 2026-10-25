import { z } from "zod";
import { partialNoDefaults } from "../zod-compat.js";

export const createMilestoneSchema = z.object({
  name: z.string().min(1),
  projectId: z.string().guid().optional().nullable(),
  description: z.string().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
});

export type CreateMilestone = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = createMilestoneSchema.apply(partialNoDefaults);

export type UpdateMilestone = z.infer<typeof updateMilestoneSchema>;

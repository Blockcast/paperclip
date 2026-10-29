import { z } from "zod";
import { partialNoDefaults } from "../zod-compat.js";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).prefault("task"),
  status: z.enum(GOAL_STATUSES).prefault("planned"),
  parentId: z.string().guid().optional().nullable(),
  ownerAgentId: z.string().guid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = createGoalSchema.apply(partialNoDefaults);

export type UpdateGoal = z.infer<typeof updateGoalSchema>;

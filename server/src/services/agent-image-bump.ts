import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

export const ELIGIBLE_ADAPTER_TYPES = ["claude_k8s", "opencode_k8s"] as const;

export interface EligibleAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  currentImage: string;
}

export async function selectEligibleAgentsForImageBump(
  db: Db,
  input: { companyId: string; targetImage: string },
): Promise<EligibleAgent[]> {
  const { companyId, targetImage } = input;
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      adapterType: agents.adapterType,
      currentImage: sql<string>`${agents.adapterConfig} ->> 'image'`,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        inArray(agents.adapterType, [...ELIGIBLE_ADAPTER_TYPES]),
        sql`${agents.adapterConfig} ->> 'image' IS NOT NULL`,
        sql`${agents.adapterConfig} ->> 'image' != ${targetImage}`,
      ),
    );
}

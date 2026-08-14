import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, projectWorkspaces, projects } from "@paperclipai/db";
import {
  extractRepoReferences,
  parseRepoIdentity,
  type RepoReference,
} from "@paperclipai/shared/repo-reference";

/**
 * BLO-20341: detect-only guard for issues homed in the wrong repository.
 *
 * A delegated sub-issue inherits `projectId` / `projectWorkspaceId` /
 * `executionWorkspaceId` from its parent — i.e. from where the bug was
 * *discovered*, not from where the code that must change actually *lives*.
 * Whenever those differ the assignee wakes in the wrong repo and cannot find
 * the code. The canonical instance is BLO-17980, a Paperclip control-plane fix
 * delegated from a Tenant+Auth ticket, which inherited a `trafficcontrol`
 * binding and stalled for six days.
 *
 * This guard reports and never re-homes. Inferring the correct project from
 * prose is exactly the guess that produces a confidently wrong binding, and a
 * wrong binding applied automatically is worse than the inherited one because
 * it looks deliberate. So we post an advisory comment naming both sides and
 * leave the decision to a human or the assignee.
 *
 * Scoped to child issues. The defect is inheritance, and a root issue that
 * merely cites another repo's PR for context is a common, legitimate shape
 * that would otherwise generate noise.
 */

export type IssueRepoBindingSource =
  | "execution_workspace"
  | "project_workspace"
  | "project_primary";

/** Where a repo named in the description actually lives, if anywhere. */
export type ReferencedRepoResolution =
  | {
      kind: "other_workspace";
      projectId: string;
      projectName: string;
      workspaceName: string | null;
    }
  | { kind: "no_workspace" };

export type ReferencedRepo = {
  /** Lowercased `owner/repo`. */
  slug: string;
  /** `owner/repo` in its original casing, for display. */
  display: string;
  key: string;
  matchedText: string;
  confidence: RepoReference["confidence"];
  resolution: ReferencedRepoResolution;
};

export type IssueRepoBindingSignal = {
  /**
   * `bound_mismatch` — bound to A, description names only repos other than A.
   * `no_binding` — no workspace resolves for this issue at all, yet it names
   *   a repo. Arguably BLO-18760's defect (born workspace-less) rather than
   *   this guard's, so it is reported separately and not as a mis-homing.
   * `binding_without_repo_url` — a workspace DOES resolve, but its `repoUrl`
   *   is null or unparseable, so there is nothing to compare against.
   *   `project_workspaces.repo_url` is nullable and `source_type` defaults to
   *   `local_path`, so this is an ordinary shape, not an edge case. The fix is
   *   to populate that workspace's `repoUrl` — a different action from
   *   re-homing the issue — so it names the workspace.
   */
  kind: "bound_mismatch" | "no_binding" | "binding_without_repo_url";
  boundRepoSlug: string | null;
  /** Bound `owner/repo` in its original casing, for display. */
  boundRepoDisplay: string | null;
  boundWorkspaceName: string | null;
  boundSource: IssueRepoBindingSource | null;
  references: ReferencedRepo[];
};

export type EvaluateIssueRepoBindingInput = {
  db: Db;
  companyId: string;
  description: string | null | undefined;
  parentId: string | null | undefined;
  projectId: string | null | undefined;
  projectWorkspaceId: string | null | undefined;
  executionWorkspaceId: string | null | undefined;
};

type CompanyWorkspaceRow = {
  workspaceId: string;
  workspaceName: string | null;
  repoUrl: string | null;
  projectId: string;
  projectName: string | null;
  isPrimary: boolean;
};

/**
 * Decide whether this issue's binding contradicts the repo its description
 * names. Returns null when there is nothing worth saying — which is the
 * overwhelmingly common case and must stay cheap.
 */
export async function evaluateIssueRepoBinding(
  input: EvaluateIssueRepoBindingInput,
): Promise<IssueRepoBindingSignal | null> {
  const { db, companyId, description } = input;
  // Inheritance is the defect; a root issue has nothing to inherit from.
  if (!input.parentId) return null;
  if (!description || !description.trim()) return null;

  // Cheap pre-filter: if the prose contains neither a github URL nor a
  // backtick, no tier can possibly match, and we skip the workspace query
  // entirely. Issue creation is hot; this keeps the guard off that path.
  if (!/github\.com/i.test(description) && !description.includes("`")) return null;

  const workspaceRows: CompanyWorkspaceRow[] = await db
    .select({
      workspaceId: projectWorkspaces.id,
      workspaceName: projectWorkspaces.name,
      repoUrl: projectWorkspaces.repoUrl,
      projectId: projectWorkspaces.projectId,
      projectName: projects.name,
      isPrimary: projectWorkspaces.isPrimary,
    })
    .from(projectWorkspaces)
    .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
    .where(eq(projectWorkspaces.companyId, companyId))
    .orderBy(
      desc(projectWorkspaces.isPrimary),
      asc(projectWorkspaces.createdAt),
      asc(projectWorkspaces.id),
    );

  const knownOwners = new Set<string>();
  for (const row of workspaceRows) {
    const identity = parseRepoIdentity(row.repoUrl);
    if (identity) knownOwners.add(identity.owner);
  }

  const references = extractRepoReferences(description, { knownOwners });
  if (references.length === 0) return null;

  const bound = await resolveBoundRepo(input, workspaceRows);
  // The description names the repo we are already bound to — the normal,
  // healthy case, and the one the zero-false-positive AC is about.
  if (bound?.identityKey && references.some((ref) => ref.key === bound.identityKey)) {
    return null;
  }

  // Index every repo this company binds anywhere, so we can tell "this code
  // lives in another project here" from "no workspace we have binds it".
  const workspacesByRepoKey = new Map<string, CompanyWorkspaceRow>();
  for (const row of workspaceRows) {
    const identity = parseRepoIdentity(row.repoUrl);
    if (!identity) continue;
    if (!workspacesByRepoKey.has(identity.key)) workspacesByRepoKey.set(identity.key, row);
  }

  const resolvedReferences: ReferencedRepo[] = references.map((ref) => {
    const match = workspacesByRepoKey.get(ref.key);
    return {
      slug: ref.slug,
      display: `${ref.owner}/${ref.repo}`,
      key: ref.key,
      matchedText: ref.matchedText,
      confidence: ref.confidence,
      resolution: match
        ? {
            kind: "other_workspace" as const,
            projectId: match.projectId,
            projectName: match.projectName ?? "(unnamed project)",
            workspaceName: match.workspaceName,
          }
        : { kind: "no_workspace" as const },
    };
  });

  // Three distinct states, and they take three different fixes. `bound` null
  // means no workspace row resolved; `bound` non-null with a null identityKey
  // means a workspace resolved but carries no parseable repoUrl.
  const kind = bound?.identityKey
    ? ("bound_mismatch" as const)
    : bound
      ? ("binding_without_repo_url" as const)
      : ("no_binding" as const);

  return {
    kind,
    boundRepoSlug: bound?.slug ?? null,
    boundRepoDisplay: bound?.display ?? null,
    boundWorkspaceName: bound?.workspaceName ?? null,
    boundSource: bound?.source ?? null,
    references: resolvedReferences,
  };
}

type BoundRepo = {
  identityKey: string | null;
  slug: string | null;
  display: string | null;
  workspaceName: string | null;
  source: IssueRepoBindingSource;
};

/**
 * Resolve the repo this issue is actually bound to, in the same precedence
 * the run-time workspace resolver uses: pinned execution workspace, then the
 * issue's project workspace, then the project's primary workspace.
 */
async function resolveBoundRepo(
  input: EvaluateIssueRepoBindingInput,
  workspaceRows: CompanyWorkspaceRow[],
): Promise<BoundRepo | null> {
  const { db, companyId } = input;

  if (input.executionWorkspaceId) {
    const row = await db
      .select({ repoUrl: executionWorkspaces.repoUrl, name: executionWorkspaces.name })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.id, input.executionWorkspaceId),
          eq(executionWorkspaces.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (row) {
      // Deliberately returns even when repoUrl is null/unparseable rather than
      // falling through to the project workspace: a pinned execution workspace
      // IS the binding, and comparing against a different workspace's repo
      // would report a mismatch the run would never actually hit. The
      // unparseable case surfaces as `binding_without_repo_url` naming this
      // workspace, which is the actionable signal.
      const identity = parseRepoIdentity(row.repoUrl);
      return {
        identityKey: identity?.key ?? null,
        slug: identity?.slug ?? null,
        display: identity ? `${identity.owner}/${identity.repo}` : null,
        workspaceName: row.name ?? null,
        source: "execution_workspace",
      };
    }
  }

  if (input.projectWorkspaceId) {
    const row = workspaceRows.find((candidate) => candidate.workspaceId === input.projectWorkspaceId);
    if (row) {
      const identity = parseRepoIdentity(row.repoUrl);
      return {
        identityKey: identity?.key ?? null,
        slug: identity?.slug ?? null,
        display: identity ? `${identity.owner}/${identity.repo}` : null,
        workspaceName: row.workspaceName,
        source: "project_workspace",
      };
    }
  }

  if (input.projectId) {
    // workspaceRows is already ordered isPrimary desc, createdAt asc — the
    // same tiebreak the create path and the run-time resolver use.
    const row = workspaceRows.find((candidate) => candidate.projectId === input.projectId);
    if (row) {
      const identity = parseRepoIdentity(row.repoUrl);
      return {
        identityKey: identity?.key ?? null,
        slug: identity?.slug ?? null,
        display: identity ? `${identity.owner}/${identity.repo}` : null,
        workspaceName: row.workspaceName,
        source: "project_primary",
      };
    }
  }

  return null;
}

const BOUND_SOURCE_LABEL: Record<IssueRepoBindingSource, string> = {
  execution_workspace: "pinned execution workspace",
  project_workspace: "project workspace",
  project_primary: "project's primary workspace",
};

/**
 * Render a value inside a Markdown code span. Workspace and project names are
 * user-set, so a backtick in one would otherwise close the span early and
 * garble the rest of the line. Fenced with the shortest run of backticks that
 * does not occur in the value, per CommonMark.
 */
function codeSpan(value: string): string {
  const longestRun = [...value.matchAll(/`+/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const fence = "`".repeat(longestRun + 1);
  // A code span whose content starts or ends with a backtick needs padding.
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Render the advisory comment. Names both sides, recommends nothing automatic. */
export function formatIssueRepoBindingComment(signal: IssueRepoBindingSignal): string {
  const lines: string[] = [];
  lines.push("**Repo binding check — this issue may be homed in the wrong repository.**");
  lines.push("");
  lines.push(
    "Advisory only: nothing has been re-homed and the binding is unchanged. " +
      "A sub-issue inherits its repo from its parent — from where the bug was *found*, " +
      "not necessarily where the code *lives* ([BLO-20341](https://paperclip.blockcast.net/BLO/issues/BLO-20341)).",
  );
  lines.push("");

  const sourceLabel = signal.boundSource ? BOUND_SOURCE_LABEL[signal.boundSource] : "workspace";
  const workspace = signal.boundWorkspaceName ? ` ${codeSpan(signal.boundWorkspaceName)}` : "";

  if (signal.kind === "no_binding") {
    lines.push("- **Bound to:** *no workspace at all* — this issue has no repo binding.");
  } else if (signal.kind === "binding_without_repo_url") {
    // Distinct fix from re-homing: populate the workspace, don't move the issue.
    lines.push(
      `- **Bound to:** ${sourceLabel}${workspace}, which has **no \`repoUrl\` set** — ` +
        "so there is nothing to compare the description against.",
    );
  } else {
    lines.push(
      `- **Bound to:** ${codeSpan(signal.boundRepoDisplay ?? signal.boundRepoSlug ?? "")} ` +
        `(${sourceLabel}${workspace})`,
    );
  }

  for (const ref of signal.references) {
    const where =
      ref.resolution.kind === "other_workspace"
        ? `bound in project **${ref.resolution.projectName}**` +
          (ref.resolution.workspaceName ? ` (workspace ${codeSpan(ref.resolution.workspaceName)})` : "")
        : "**no workspace in this company binds this repo**";
    lines.push(`- **Description names:** ${codeSpan(ref.display)} — ${where}`);
  }

  lines.push("");
  lines.push(
    signal.kind === "binding_without_repo_url"
      ? "If the description is right, set that workspace's `repoUrl` — or move this issue to " +
          "the project whose workspace is that repo. If the binding is right, ignore this comment."
      : "If the description is right, move this issue to the project whose workspace is that repo. " +
          "If the binding is right, ignore this comment.",
  );
  return lines.join("\n");
}

/** Stable per-issue key so a retried create never stacks duplicate comments. */
export function issueRepoBindingCommentIdempotencyKey(issueId: string): string {
  return `repo-binding-guard:${issueId}`;
}

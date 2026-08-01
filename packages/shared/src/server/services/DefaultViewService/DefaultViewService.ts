import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { v4 } from "uuid";
import { prisma } from "../../../db";
import { defaultViews } from "../../../db/schema/index.js";
import { TableViewPresetTableName } from "../../../domain/table-view-presets";
import {
  getSystemTableViewPresetById,
  isSystemTableViewPresetId,
} from "../TableViewService/systemPresets";
import type { DefaultViewAssignments, DefaultViewScope, ResolvedDefault } from "./types";

interface GetResolvedDefaultParams {
  projectId: string;
  viewName: string;
  userId?: string;
}

interface SetAsDefaultParams {
  projectId: string;
  viewId: string;
  viewName: string;
  scope: DefaultViewScope;
  userId?: string;
}

interface ClearDefaultParams {
  projectId: string;
  viewName: string;
  scope: DefaultViewScope;
  userId?: string;
}

const getReadCompatibleViewNames = (viewName: string) =>
  viewName === TableViewPresetTableName.ObservationsEvents
    ? [TableViewPresetTableName.ObservationsEvents, TableViewPresetTableName.Observations]
    : [viewName];

const getCanonicalViewName = (viewName: string) =>
  viewName === TableViewPresetTableName.ObservationsEvents
    ? TableViewPresetTableName.ObservationsEvents
    : viewName;

const pickPreferredDefaultViewId = (
  defaults: {
    viewId: string;
    viewName: string;
    userId: string | null;
  }[],
  preferredViewNames: string[],
  userId: string | null,
) =>
  preferredViewNames
    .map((viewName) =>
      defaults.find((defaultView) => {
        return defaultView.viewName === viewName && defaultView.userId === userId;
      }),
    )
    .find(Boolean)?.viewId ?? null;

export class DefaultViewService {
  public static async getDefaultAssignments({
    projectId,
    viewName,
    userId,
  }: GetResolvedDefaultParams): Promise<DefaultViewAssignments> {
    const compatibleViewNames = getReadCompatibleViewNames(viewName);
    const defaults = await prisma
      .select()
      .from(defaultViews)
      .where(
        and(
          eq(defaultViews.projectId, projectId),
          inArray(defaultViews.viewName, compatibleViewNames),
          userId ? or(eq(defaultViews.userId, userId), isNull(defaultViews.userId)) : isNull(defaultViews.userId),
        ),
      );

    return {
      userDefaultViewId: userId
        ? pickPreferredDefaultViewId(defaults, compatibleViewNames, userId)
        : null,
      projectDefaultViewId: pickPreferredDefaultViewId(defaults, compatibleViewNames, null),
    };
  }

  /**
   * Get the resolved default view for a given context.
   * Priority: user default > project default > null
   */
  public static async getResolvedDefault({
    projectId,
    viewName,
    userId,
  }: GetResolvedDefaultParams): Promise<ResolvedDefault | null> {
    const assignments = await DefaultViewService.getDefaultAssignments({
      projectId,
      viewName,
      userId,
    });

    // A default may point at a system preset (view_id has no FK on purpose),
    // and system presets are code-defined — a catalog iteration can retire an
    // id. Treat a retired system-preset default as absent and FALL THROUGH to
    // the next scope, instead of handing the client an id whose fetch errors
    // on every visit. The row is deliberately left in place: ignoring it is
    // reversible, deleting it is not.
    const isResolvable = (viewId: string) =>
      !isSystemTableViewPresetId(viewId) || getSystemTableViewPresetById(viewId) !== null;

    if (assignments.userDefaultViewId && isResolvable(assignments.userDefaultViewId)) {
      return { viewId: assignments.userDefaultViewId, scope: "user" };
    }

    if (assignments.projectDefaultViewId && isResolvable(assignments.projectDefaultViewId)) {
      return { viewId: assignments.projectDefaultViewId, scope: "project" };
    }

    return null;
  }

  /**
   * Set a view as the default for user or project level.
   * Upserts the default view record using serializable transaction to prevent races.
   */
  public static async setAsDefault({
    projectId,
    viewId,
    viewName,
    scope,
    userId,
  }: SetAsDefaultParams): Promise<void> {
    const userIdToUse = scope === "user" ? userId : null;
    const canonicalViewName = getCanonicalViewName(viewName);

    if (scope === "user" && !userId) {
      throw new Error("userId is required for user-level defaults");
    }

    // Use a transaction to prevent race conditions.
    // Two concurrent requests will be serialized (SQLite writes are serialized),
    // avoiding duplicate inserts.
    await prisma.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(defaultViews)
        .where(
          and(
            eq(defaultViews.projectId, projectId),
            eq(defaultViews.viewName, canonicalViewName),
            userIdToUse ? eq(defaultViews.userId, userIdToUse) : isNull(defaultViews.userId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);

      if (existing) {
        await tx
          .update(defaultViews)
          .set({ viewId, viewName: canonicalViewName })
          .where(eq(defaultViews.id, existing.id));
      } else {
        await tx.insert(defaultViews).values({
          id: v4(),
          projectId,
          userId: userIdToUse,
          viewName: canonicalViewName,
          viewId,
        });
      }
    });
  }

  public static async clearDefault({
    projectId,
    viewName,
    scope,
    userId,
  }: ClearDefaultParams): Promise<void> {
    const userIdToUse = scope === "user" ? userId : null;
    const canonicalViewName = getCanonicalViewName(viewName);

    if (scope === "user" && !userId) {
      throw new Error("userId is required for clearing user-level defaults");
    }

    await prisma
      .delete(defaultViews)
      .where(
        and(
          eq(defaultViews.projectId, projectId),
          eq(defaultViews.viewName, canonicalViewName),
          userIdToUse ? eq(defaultViews.userId, userIdToUse) : isNull(defaultViews.userId),
        ),
      );
  }
}

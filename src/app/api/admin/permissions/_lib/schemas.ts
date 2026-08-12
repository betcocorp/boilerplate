/**
 * B0-409: request-body contracts for `/api/admin/permissions/**`.
 *
 * Shapes are the ones c360's permissions editors already send (`AddPermissionForms`,
 * `PermissionDetailClient`, `GroupAssignmentsEditor`, `GroupPermissionsEditor`,
 * `UserPermissionsEditor`, `EditUserDialog`, `FilterableUserList`), which B0-410 ports over — so the
 * ported components need no body changes, only the base-path change from `/api/proxy/permissions`.
 *
 * Two deliberate differences from the c360 Express controllers:
 *
 * 1. **Id arrays reject blank entries** instead of silently filtering them. c360 filtered, which
 *    turned a client bug into a no-op; here it is a 400 with `issues`. It also makes the
 *    repository's `{ success: false }` unambiguous for `bulk-assign` (see that route).
 * 2. **`putPermissionsUser` needs a name.** The repository composes `user_name` from
 *    first + last and rejects an empty result, so the refine below surfaces that as a 400 with
 *    `issues` rather than a generic failure envelope.
 *
 * Free text is *not* trimmed/blanked here — `repository.optionalText()` already does that, and
 * doing it twice would only make the two disagree later.
 */

import { z } from 'zod';

/** Optional free text; `null` is meaningful (the editors send `description: '' || null`). */
const optionalText = z.string().nullish();

/** A list of ids. Blank/whitespace-only entries are rejected, not filtered. */
const idList = z.array(z.string().trim().min(1, 'id must not be blank'));

export const permissionCreateSchema = z.object({
  selector: z.string().trim().min(1, 'selector required'),
  description: optionalText,
});

export const permissionUpdateSchema = permissionCreateSchema;

export const permissionGroupCreateSchema = z.object({
  selector: z.string().trim().min(1, 'selector required'),
  description: optionalText,
  startAt: optionalText,
  endAt: optionalText,
});

/** Replaces the group's members *and* permissions, so both lists are required. */
export const groupAssignmentsSchema = z.object({
  userIds: idList,
  permissionIds: idList,
});

/** Replaces only the group's permissions. */
export const groupPermissionsSchema = z.object({
  permissionIds: idList,
});

/**
 * The target group id is the route segment; the source is the body. `deleteSource` defaults to true
 * in the repository, matching c360's `req.body?.deleteSource !== false`.
 */
export const groupMergeSchema = z.object({
  sourceGroupId: z.string().trim().min(1, 'sourceGroupId required'),
  deleteSource: z.boolean().optional(),
});

/** c360 does not validate email format here, so neither does this. */
export const permissionsUserCreateSchema = z.object({
  name: z.string().trim().min(1, 'name required'),
  email: z.string().trim().min(1, 'email required'),
});

export const permissionsUserUpdateSchema = z
  .object({
    firstName: optionalText,
    lastName: optionalText,
    email: z.string().trim().min(1, 'email required'),
    phone: optionalText,
    title: optionalText,
    department: optionalText,
    division: optionalText,
    isActive: z.boolean().optional(),
    betcoCompanyId: optionalText,
    isSalesperson: z.boolean().optional(),
    editAll: z.boolean().optional(),
    hasUserSwitcher: z.boolean().optional(),
    /** Anything other than 'VIEW_ALL' is stored as null by the repository. */
    userSecurityRole: optionalText,
  })
  .refine(
    (body) =>
      Boolean((body.firstName ?? '').trim() || (body.lastName ?? '').trim()),
    { message: 'firstName or lastName required', path: ['firstName'] },
  );

export const userAssignmentsSchema = z.object({
  permissionGroupIds: idList,
  permissionIds: idList,
});

export const bulkAssignSchema = z
  .object({
    userIds: idList.min(1, 'userIds required'),
    permissionGroupIds: idList.default([]),
    permissionIds: idList.default([]),
  })
  .refine(
    (body) =>
      body.permissionGroupIds.length > 0 || body.permissionIds.length > 0,
    {
      message: 'at least one of permissionGroupIds or permissionIds required',
      path: ['permissionGroupIds'],
    },
  );

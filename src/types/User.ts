/**
 * Fields that can be entered/edited for a user (e.g. in forms).
 */
export type UserEnterable = {
  NAME: string;
  EMAIL: string;
  PHONE?: string | null;
  TITLE?: string | null;
  DEPARTMENT?: string | null;
  DIVISION?: string | null;
  IS_ACTIVE?: boolean;
  BETCO_COMPANY_ID?: string;
  IS_SALESPERSON?: boolean;
  ROLES?: string[];
  EDIT_ALL?: boolean;
  HAS_USER_SWITCHER?: boolean;
  USER_SECURITY_ROLE?: string | null;
};

/**
 * Full user record (API/display). Includes enterable fields plus USER_ID.
 */
type User = UserEnterable & {
  USER_ID: string;
  GROUPS?: string[];
};

/** Keys of User (used e.g. for reading a specific field from auth/cookie) */
export type AcceptableUserKeys = keyof User;

export default User;

/**
 * Operator authorization roles (FIND-08).
 *
 * The data model carries exactly one meaningful role today: every operator
 * row defaults to 'owner', and no other value is issued anywhere. Until the
 * owner defines a broader role matrix (recorded outstanding owner input),
 * the narrowest safe behavior is:
 *
 * - 'owner' is authorized;
 * - every other role value — and a missing operator — is denied.
 *
 * Both middleware gates (locationAccess for /api/loc/:loc/*, requireOwner
 * for the location-less operator routes) enforce this. When new roles
 * arrive, they plug in here: extend the matrix, keep deny-by-default.
 */
export const OWNER_ROLE = 'owner'

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === OWNER_ROLE
}

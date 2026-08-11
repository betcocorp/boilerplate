'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Separator } from '~/components/ui/separator';
import { Switch } from '~/components/ui/switch';
import type User from '~/types/User';

const DEPARTMENT_NONE_VALUE = '__none__';

const DEPARTMENT_OPTIONS = [
  '2060001 - 2060001 Sales Enablement',
  'Accounting',
  'BD Team',
  'Business Development',
  'Commercial Sales',
  'Customer Service',
  'Finance',
  'IT',
  'Inactive User',
  'International',
  'Marketing',
  'Sales',
] as const;

/** Toggles that widen access and therefore need an explicit confirmation before being turned on. */
type PrivilegedField = 'EDIT_ALL' | 'HAS_USER_SWITCHER' | 'USER_SECURITY_ROLE';

const PRIVILEGED_COPY: Record<
  PrivilegedField,
  { label: string; description: string }
> = {
  EDIT_ALL: {
    label: 'Edit All',
    description:
      'Enabling Edit All grants this user the ability to edit any record, regardless of who owns it. This bypasses row-level security for all write operations across the application.',
  },
  HAS_USER_SWITCHER: {
    label: 'User Switcher',
    description:
      'Enabling User Switcher allows this user to act as any other user. While acting as someone else they will see and act as that user. This is primarily used for debugging and support.',
  },
  USER_SECURITY_ROLE: {
    label: 'View All (Security Role)',
    description:
      "Setting this user's security role to View All allows them to see every record regardless of ownership or territory. This bypasses row-level security and is typically reserved for administrators.",
  },
};

const SWITCH_COPY: Record<
  'IS_ACTIVE' | 'IS_SALESPERSON' | PrivilegedField,
  { label: string; description: string }
> = {
  IS_ACTIVE: {
    label: 'Active',
    description:
      "Indicates whether a user's account is active. Inactive will deny them the ability to sign in.",
  },
  IS_SALESPERSON: {
    label: 'Salesperson',
    description:
      'Marks this user as a salesperson for reporting and data exports.',
  },
  ...PRIVILEGED_COPY,
};

type FormValues = {
  FIRST_NAME: string;
  LAST_NAME: string;
  EMAIL: string;
  PHONE: string;
  TITLE: string;
  DEPARTMENT: string;
  DIVISION: string;
  BETCO_COMPANY_ID: string;
  IS_ACTIVE: boolean;
  IS_SALESPERSON: boolean;
  EDIT_ALL: boolean;
  HAS_USER_SWITCHER: boolean;
  USER_SECURITY_ROLE: string | null;
};

/**
 * `app_user.user_name` is a single column, so first/last are derived for the form and recomposed on
 * save. `Jane_Smith` and `Jane Smith` are both seen in the seed data.
 */
function parseNameToFirstLast(name: string | null | undefined): {
  first: string;
  last: string;
} {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { first: '', last: '' };
  if (trimmed.includes('_')) {
    const index = trimmed.indexOf('_');
    return {
      first: trimmed.slice(0, index),
      last: trimmed.slice(index + 1),
    };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

function toFormValues(user: User | null): FormValues {
  const { first, last } = parseNameToFirstLast(user?.NAME);
  return {
    FIRST_NAME: first,
    LAST_NAME: last,
    EMAIL: user?.EMAIL ?? '',
    PHONE: user?.PHONE ?? '',
    TITLE: user?.TITLE ?? '',
    DEPARTMENT: user?.DEPARTMENT ?? '',
    DIVISION: user?.DIVISION ?? '',
    BETCO_COMPANY_ID: user?.BETCO_COMPANY_ID ?? '',
    IS_ACTIVE: user?.IS_ACTIVE ?? true,
    IS_SALESPERSON: user?.IS_SALESPERSON ?? false,
    EDIT_ALL: user?.EDIT_ALL ?? false,
    HAS_USER_SWITCHER: user?.HAS_USER_SWITCHER ?? false,
    USER_SECURITY_ROLE: user?.USER_SECURITY_ROLE ?? null,
  };
}

/** Optional free text: send `undefined` rather than `''` so the API stores null. */
function optional(value: string): string | undefined {
  return value.trim() || undefined;
}

function SwitchRow({
  checked,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} />
      <Label className="cursor-pointer text-sm font-medium" htmlFor={id}>
        {label}
      </Label>
    </div>
  );
}

/**
 * Profile editor for one `app_user` row. Port of c360's `components/custom/EditUserDialog`, pointed
 * at `PUT /api/admin/permissions/users/:userId`.
 *
 * That handler's schema requires a first **or** last name (B0-409), so the client-side guard below
 * is what keeps a blank-name save from coming back as a 400 with Zod `issues`.
 */
export function EditUserDialog({
  onOpenChange,
  open,
  user,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  user: User | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<FormValues>(toFormValues(user));
  const [pendingConfirm, setPendingConfirm] = useState<PrivilegedField | null>(
    null,
  );

  useEffect(() => {
    setValues(toFormValues(user));
  }, [user]);

  const update = <TKey extends keyof FormValues>(
    key: TKey,
    value: FormValues[TKey],
  ) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handlePrivilegedToggle = (
    field: PrivilegedField,
    currentlyOn: boolean,
  ) => {
    if (currentlyOn) {
      // Turning a privileged flag off needs no confirmation.
      if (field === 'USER_SECURITY_ROLE') update(field, null);
      else update(field, false);
      return;
    }
    setPendingConfirm(field);
  };

  const handleConfirm = () => {
    if (!pendingConfirm) return;
    if (pendingConfirm === 'USER_SECURITY_ROLE') {
      update('USER_SECURITY_ROLE', 'VIEW_ALL');
    } else {
      update(pendingConfirm, true);
    }
    setPendingConfirm(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user?.USER_ID) return;

    const firstName = values.FIRST_NAME.trim();
    const lastName = values.LAST_NAME.trim();
    const email = values.EMAIL.trim();
    if (!firstName && !lastName) {
      toast.error('A first or last name is required');
      return;
    }
    if (!email) {
      toast.error('Email is required');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(
        `${PERMISSIONS_API_BASE}/users/${encodeURIComponent(user.USER_ID)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            firstName,
            lastName,
            email,
            phone: optional(values.PHONE),
            title: optional(values.TITLE),
            department: optional(values.DEPARTMENT),
            division: optional(values.DIVISION),
            isActive: values.IS_ACTIVE,
            betcoCompanyId: optional(values.BETCO_COMPANY_ID),
            isSalesperson: values.IS_SALESPERSON,
            editAll: values.EDIT_ALL,
            hasUserSwitcher: values.HAS_USER_SWITCHER,
            userSecurityRole:
              values.USER_SECURITY_ROLE === 'VIEW_ALL' ? 'VIEW_ALL' : null,
          }),
        },
      );
      const data = await readJsonEnvelope(res);
      if (!res.ok) {
        toast.error(envelopeErrorMessage(data, 'Failed to update user'));
        return;
      }
      toast.success('User updated');
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error('Failed to update user');
    } finally {
      setSaving(false);
    }
  };

  const confirmCopy = pendingConfirm ? PRIVILEGED_COPY[pendingConfirm] : null;

  return (
    <>
      <Dialog
        onOpenChange={(next) => {
          if (!next) setPendingConfirm(null);
        }}
        open={Boolean(pendingConfirm)}
      >
        <DialogContent className="rounded-3xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Are you sure you want to do this?</DialogTitle>
            <DialogDescription className="pt-1">
              {confirmCopy?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button onClick={() => setPendingConfirm(null)} variant="outline">
              Cancel
            </Button>
            <Button onClick={handleConfirm}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-3xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>
              Update this user&apos;s profile. Group and permission assignments
              are edited on their detail page.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-user-first-name">First name</Label>
                <Input
                  id="edit-user-first-name"
                  onChange={(event) =>
                    update('FIRST_NAME', event.target.value)
                  }
                  placeholder="First name"
                  value={values.FIRST_NAME}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-user-last-name">Last name</Label>
                <Input
                  id="edit-user-last-name"
                  onChange={(event) => update('LAST_NAME', event.target.value)}
                  placeholder="Last name"
                  value={values.LAST_NAME}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-user-email">Email</Label>
                <Input
                  id="edit-user-email"
                  onChange={(event) => update('EMAIL', event.target.value)}
                  placeholder="email@example.com"
                  required
                  type="email"
                  value={values.EMAIL}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-user-phone">Phone</Label>
                <Input
                  id="edit-user-phone"
                  onChange={(event) => update('PHONE', event.target.value)}
                  placeholder="Phone (optional)"
                  value={values.PHONE}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-user-title">Title</Label>
                <Input
                  id="edit-user-title"
                  onChange={(event) => update('TITLE', event.target.value)}
                  placeholder="Job title (optional)"
                  value={values.TITLE}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-user-department">Department</Label>
                <Select
                  onValueChange={(value) =>
                    update(
                      'DEPARTMENT',
                      value === DEPARTMENT_NONE_VALUE ? '' : value,
                    )
                  }
                  value={values.DEPARTMENT || DEPARTMENT_NONE_VALUE}
                >
                  <SelectTrigger className="w-full" id="edit-user-department">
                    <SelectValue placeholder="Department (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEPARTMENT_NONE_VALUE}>None</SelectItem>
                    {DEPARTMENT_OPTIONS.map((department) => (
                      <SelectItem key={department} value={department}>
                        {department}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-user-division">Division</Label>
              <Input
                id="edit-user-division"
                onChange={(event) => update('DIVISION', event.target.value)}
                placeholder="Division (optional)"
                value={values.DIVISION}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-user-betco-company-id">
                BETCO Company ID
              </Label>
              <Input
                id="edit-user-betco-company-id"
                onChange={(event) =>
                  update('BETCO_COMPANY_ID', event.target.value)
                }
                placeholder="BETCO company ID (optional)"
                value={values.BETCO_COMPANY_ID}
              />
            </div>

            <Separator />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SwitchRow
                checked={values.IS_ACTIVE}
                id="edit-user-is-active"
                label={SWITCH_COPY.IS_ACTIVE.label}
                onCheckedChange={(checked) => update('IS_ACTIVE', checked)}
              />
              <SwitchRow
                checked={values.IS_SALESPERSON}
                id="edit-user-is-salesperson"
                label={SWITCH_COPY.IS_SALESPERSON.label}
                onCheckedChange={(checked) => update('IS_SALESPERSON', checked)}
              />
              <SwitchRow
                checked={values.EDIT_ALL}
                id="edit-user-edit-all"
                label={SWITCH_COPY.EDIT_ALL.label}
                onCheckedChange={() =>
                  handlePrivilegedToggle('EDIT_ALL', values.EDIT_ALL)
                }
              />
              <SwitchRow
                checked={values.HAS_USER_SWITCHER}
                id="edit-user-has-user-switcher"
                label={SWITCH_COPY.HAS_USER_SWITCHER.label}
                onCheckedChange={() =>
                  handlePrivilegedToggle(
                    'HAS_USER_SWITCHER',
                    values.HAS_USER_SWITCHER,
                  )
                }
              />
              <SwitchRow
                checked={values.USER_SECURITY_ROLE === 'VIEW_ALL'}
                id="edit-user-security-role"
                label={SWITCH_COPY.USER_SECURITY_ROLE.label}
                onCheckedChange={() =>
                  handlePrivilegedToggle(
                    'USER_SECURITY_ROLE',
                    values.USER_SECURITY_ROLE === 'VIEW_ALL',
                  )
                }
              />
            </div>

            <DialogFooter>
              <Button
                disabled={saving}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button className="rounded-2xl" disabled={saving} type="submit">
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  'Save changes'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import FormLogin from "~/components/auth/FormLogin";
import { Skeleton } from "~/components/ui/skeleton";
import { authOptions } from "~/lib/auth";

export const metadata = {
  title: "Sign In",
  description: "Sign in to access the admin workspace.",
};

type HomeProps = {
  searchParams: Promise<{
    next?: string;
    callbackUrl?: string;
    error?: string;
  }>;
};

/**
 * Sign-in rejections raised by the `signIn` callback in `~/lib/auth` (B0-406), plus NextAuth's own
 * `AccessDenied`. Only reachable when `PERMISSIONS_ENFORCED=true` — in shadow mode the callback
 * lets everyone through.
 */
const SIGN_IN_ERROR_MESSAGES: Record<string, string> = {
  UserNotFound:
    "That account isn't set up yet. Ask an administrator to add you, then try again.",
  AccountInactive:
    "Your account is inactive. Ask an administrator to reactivate it, then try again.",
  NoIdentity:
    "Your identity provider didn't return an email address, so we can't match you to a account.",
  AccessDenied: "We couldn't verify your account. Please try again.",
};

function signInErrorMessage(error: string | undefined): string | undefined {
  if (!error) return undefined;
  return SIGN_IN_ERROR_MESSAGES[error] ?? SIGN_IN_ERROR_MESSAGES.AccessDenied;
}

export default async function Home({ searchParams }: HomeProps) {
  const session = await getServerSession(authOptions);
  const params = await searchParams;

  if (session) {
    const redirectUrl = params.next || params.callbackUrl || "/admin";
    redirect(redirectUrl);
  }

  return (
    <Suspense fallback={<LoginFormSkeleton />}>
      <FormLogin errorMessage={signInErrorMessage(params.error)} />
    </Suspense>
  );
}

/** Mirrors the FormLogin card: heading, blurb, full-width sign-in button. */
function LoginFormSkeleton() {
  return (
    <div
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-muted/20 px-6"
      role="status"
    >
      <span className="sr-only">Loading sign-in…</span>
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
        <Skeleton className="h-8 w-40 rounded-md" />
        <Skeleton className="mt-3 h-4 w-full rounded-md" />
        <Skeleton className="mt-6 h-9 w-full rounded-md" />
      </div>
    </div>
  );
}

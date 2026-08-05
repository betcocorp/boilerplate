import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import FormLogin from "~/components/auth/FormLogin";
import { Skeleton } from "~/components/ui/skeleton";
import { authOptions } from "~/lib/auth";

export const metadata = {
  title: "Sign In | Betco BEX",
  description: "Sign in to access the Betco BEX admin workspace.",
};

type HomeProps = {
  searchParams: Promise<{
    next?: string;
    callbackUrl?: string;
  }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const session = await getServerSession(authOptions);
  const params = await searchParams;

  if (session) {
    const redirectUrl = params.next || params.callbackUrl || "/admin";
    redirect(redirectUrl);
  }

  return (
    <Suspense fallback={<LoginFormSkeleton />}>
      <FormLogin />
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

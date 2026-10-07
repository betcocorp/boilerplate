"use client";

import { AlertTriangle, Fingerprint } from "lucide-react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

/** `errorMessage` is resolved server-side from `?error=` in `src/app/page.tsx`. */
export default function FormLogin({
  errorMessage,
}: {
  errorMessage?: string;
}) {
  const searchParams = useSearchParams();
  const callbackUrl =
    searchParams.get("next") || searchParams.get("callbackUrl") || "/admin";

  const handleSignIn = () => {
    signIn("azure-ad", { callbackUrl });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 px-6">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-foreground">Betco App</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in to continue to the admin workspace.
        </p>
        {errorMessage ? (
          <Alert className="mt-6" variant="destructive">
            <AlertTriangle />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        <Button className="mt-6 w-full gap-2" onClick={handleSignIn}>
          <Fingerprint className="size-4" />
          Continue with Duo
        </Button>
      </div>
    </div>
  );
}

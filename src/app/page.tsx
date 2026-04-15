import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import FormLogin from "~/components/auth/FormLogin";
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
    <Suspense fallback={<div>Loading...</div>}>
      <FormLogin />
    </Suspense>
  );
}

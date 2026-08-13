"use client"

import * as React from "react"

type ClientOnlyProps = {
  children: React.ReactNode
  fallback?: React.ReactNode
}

/**
 * Renders `children` only after mount.
 *
 * Use it for subtrees whose server and client markup cannot agree — Radix primitives that mint
 * `useId` values, anything reading `window`/`localStorage` — where the mismatch shows up as a
 * hydration error rather than a visual bug. `fallback` is what the server renders instead.
 */
function ClientOnly({ children, fallback = null }: ClientOnlyProps) {
  const [hasMounted, setHasMounted] = React.useState(false)

  React.useEffect(() => {
    setHasMounted(true)
  }, [])

  return <>{hasMounted ? children : fallback}</>
}

export { ClientOnly }

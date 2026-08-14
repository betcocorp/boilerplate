import type { Metadata } from 'next';
import { readFileSync } from 'fs';
import { join } from 'path';
import ReactMarkdown from 'react-markdown';

export const metadata: Metadata = {
  title: 'Changelog | Betco BEX Admin',
  description: 'View the changelog and version history.',
};

function loadChangelog(): string {
  try {
    const changelogPath = join(process.cwd(), 'CHANGELOG.md');
    return readFileSync(changelogPath, 'utf-8');
  } catch {
    return '# Changelog\n\nUnable to load changelog. Please check the file exists at the root of the project.';
  }
}

export default function ChangelogPage() {
  const changelogContent = loadChangelog();

  return (
    <main className="min-w-0 space-y-4 p-4 sm:p-6">
      <div className="rounded-2xl border border-border/60 bg-background shadow-sm">
        <div className="border-b border-border/60 px-6 py-5 sm:px-8">
          <p className="text-sm text-muted-foreground">Changelog</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Version History
          </h1>
        </div>

        <div className="overflow-y-auto">
          <div className="prose prose-sm max-w-none px-6 py-6 sm:px-8 dark:prose-invert">
            <ReactMarkdown
              components={{
                h1: ({ children }) => (
                  <h1 className="mt-8 mb-4 text-2xl font-bold text-foreground first:mt-0">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2 className="mt-6 mb-3 text-xl font-semibold text-foreground">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="mt-4 mb-2 text-lg font-semibold text-foreground">
                    {children}
                  </h3>
                ),
                p: ({ children }) => (
                  <p className="mb-3 text-sm text-foreground/90 leading-relaxed">
                    {children}
                  </p>
                ),
                ul: ({ children }) => (
                  <ul className="mb-3 ml-4 space-y-1 text-sm text-foreground/90">
                    {children}
                  </ul>
                ),
                li: ({ children }) => (
                  <li className="list-disc list-inside">{children}</li>
                ),
                ol: ({ children }) => (
                  <ol className="mb-3 ml-4 space-y-1 text-sm text-foreground/90">
                    {children}
                  </ol>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/90">
                    {children}
                  </code>
                ),
                pre: ({ children }) => (
                  <pre className="mb-3 rounded-lg bg-muted p-3 overflow-x-auto">
                    {children}
                  </pre>
                ),
                a: ({ href, children }) => (
                  <a
                    href={href}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {changelogContent}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </main>
  );
}

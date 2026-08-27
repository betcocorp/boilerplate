'use client';

import { ChevronDown, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import type { EndpointDefinition } from '~/lib/endpoints/definitions';

interface EndpointDocumentationProps {
  endpoint: EndpointDefinition;
}

const METHOD_COLORS = {
  GET: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  POST: 'bg-green-500/10 text-green-600 dark:text-green-400',
  PUT: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  DELETE: 'bg-red-500/10 text-red-600 dark:text-red-400',
  PATCH: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
};

const AUTH_COLORS = {
  Session: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  'Bearer Token': 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  Public: 'bg-gray-500/10 text-gray-600 dark:text-gray-400',
};

export function EndpointDocumentation({ endpoint }: EndpointDocumentationProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showExample, setShowExample] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bearerToken, setBearerToken] = useState('');
  const [formData, setFormData] = useState<Record<string, string>>(
    endpoint.parameters.reduce(
      (acc, param) => {
        acc[param.name] = '';
        return acc;
      },
      {} as Record<string, string>,
    ),
  );

  const handleFormChange = (key: string, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    setIsLoading(true);
    setError(null);
    setResponse(null);

    try {
      const payload = Object.entries(formData).reduce(
        (acc, [key, value]) => {
          if (!value) return acc;
          try {
            acc[key] = value === 'true' ? true : value === 'false' ? false : value;
            // Try parsing as JSON for complex types
            if (value.startsWith('{') || value.startsWith('[')) {
              acc[key] = JSON.parse(value);
            } else if (!isNaN(Number(value)) && value !== '') {
              acc[key] = Number(value);
            }
          } catch {
            acc[key] = value;
          }
          return acc;
        },
        {} as Record<string, unknown>,
      );

      const res = await fetch(`/api/admin/tools/execute-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: endpoint.path,
          method: endpoint.method,
          parameters: payload,
          authType: endpoint.auth,
          ...(endpoint.auth === 'Bearer Token' && { bearerToken }),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Request failed');
      } else {
        setResponse(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="cursor-pointer pb-3" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <Badge className={METHOD_COLORS[endpoint.method]} variant="secondary">
                {endpoint.method}
              </Badge>
              <code className="font-mono text-sm text-muted-foreground">{endpoint.path}</code>
            </div>
            <CardTitle className="text-base">{endpoint.name}</CardTitle>
            <CardDescription className="mt-1.5">{endpoint.description}</CardDescription>
          </div>
          <ChevronDown
            className="size-5 shrink-0 transition-transform"
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="space-y-4 border-t border-border/40 pt-4">
          <div className="flex flex-wrap gap-2">
            <div>
              <span className="text-xs font-semibold text-muted-foreground mr-2">Category:</span>
              <Badge variant="outline">{endpoint.category}</Badge>
            </div>
            {endpoint.auth && (
              <div>
                <span className="text-xs font-semibold text-muted-foreground mr-2">Auth:</span>
                <Badge className={AUTH_COLORS[endpoint.auth]} variant="secondary">
                  {endpoint.auth}
                </Badge>
              </div>
            )}
          </div>

          {endpoint.parameters.length > 0 ? (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-foreground">Parameters</h4>
              <div className="space-y-2">
                {endpoint.parameters.map((param) => (
                  <div key={param.name} className="rounded-lg bg-muted/50 p-3 text-sm">
                    <div className="flex items-baseline gap-2">
                      <code className="font-mono font-semibold text-primary">
                        {param.name}
                      </code>
                      <span className="text-xs text-muted-foreground">
                        {param.type}
                        {param.required && <span className="ml-1 font-semibold text-red-500">*</span>}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{param.description}</p>
                    {param.enum && param.enum.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Allowed values: {param.enum.join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No parameters</p>
          )}

          {endpoint.response && (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-foreground">Response</h4>
              <div className="rounded-lg bg-muted/30 p-3 text-sm">
                <p className="text-xs text-muted-foreground">{endpoint.response.description}</p>
                {endpoint.response.example && (
                  <pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono">
                    {JSON.stringify(endpoint.response.example, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowExample(!showExample)}
            className="mb-2"
          >
            {showExample ? 'Hide' : 'Show'} Example Call
          </Button>

          {showExample && (
            <div className="space-y-3 rounded-lg border border-border/40 bg-muted/20 p-4">
              <h4 className="text-sm font-semibold text-foreground">Example Request</h4>
              {endpoint.auth === 'Bearer Token' && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Bearer Token
                  </label>
                  <input
                    type="password"
                    value={bearerToken}
                    onChange={(e) => setBearerToken(e.target.value)}
                    placeholder="Enter Bearer token (required for Bearer Token auth)"
                    className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                  />
                </div>
              )}
              <div className="space-y-2">
                {endpoint.parameters.map((param) => (
                  <div key={param.name}>
                    <label className="text-xs font-medium text-muted-foreground">
                      {param.name}
                      {param.required && <span className="ml-1 font-semibold text-red-500">*</span>}
                    </label>
                    <input
                      type="text"
                      value={formData[param.name] || ''}
                      onChange={(e) => handleFormChange(param.name, e.target.value)}
                      placeholder={`Enter ${param.name}`}
                      className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">{param.description}</p>
                  </div>
                ))}
              </div>

              <Button
                onClick={handleSubmit}
                disabled={isLoading}
                size="sm"
                className="w-full"
              >
                {isLoading && <Loader2 className="mr-2 size-3 animate-spin" />}
                {isLoading ? 'Executing...' : 'Execute'}
              </Button>

              {error && (
                <div className="rounded bg-red-500/10 p-2 text-xs text-red-600">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {response && (
                <div className="rounded bg-muted/50 p-2">
                  <h5 className="mb-2 text-xs font-semibold text-foreground">Response:</h5>
                  <pre className="overflow-x-auto text-xs text-muted-foreground whitespace-pre-wrap break-words">
                    {typeof response === 'string' ? response : JSON.stringify(response, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-border/40 bg-background/50 p-3 text-xs">
            <p className="font-mono text-muted-foreground break-all">
              <strong>{endpoint.method}</strong> {endpoint.path}
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

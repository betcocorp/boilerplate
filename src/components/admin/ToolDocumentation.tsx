'use client';

import { ChevronDown, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { Tool } from 'openai/resources/responses/responses';

import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { getToolExample } from '~/lib/tools/examples';

interface ToolDocumentationProps {
  tool: Tool;
}

export function ToolDocumentation({ tool }: ToolDocumentationProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showExample, setShowExample] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>(
    tool.type === 'function'
      ? Object.entries(getToolExample(tool.name) || {}).reduce(
          (acc, [key, value]) => {
            acc[key] = typeof value === 'string' ? value : JSON.stringify(value);
            return acc;
          },
          {} as Record<string, string>,
        )
      : {},
  );

  if (tool.type !== 'function') {
    return null;
  }

  const parameters = tool.parameters as Record<string, unknown> | undefined;
  const properties = (parameters?.properties as Record<string, unknown>) || {};
  const requiredFields = (parameters?.required as string[]) || [];

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

      const res = await fetch(`/api/admin/tools/execute/${tool.name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
            <CardTitle className="font-mono text-base">{tool.name}</CardTitle>
            <CardDescription className="mt-1.5">{tool.description}</CardDescription>
          </div>
          <ChevronDown
            className="size-5 shrink-0 transition-transform"
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="space-y-4 border-t border-border/40 pt-4">
          {Object.keys(properties).length > 0 ? (
            <div>
              <h4 className="mb-3 text-sm font-semibold text-foreground">Parameters</h4>
              <div className="space-y-2">
                {Object.entries(properties).map(([paramName, paramDef]) => {
                  const param = paramDef as Record<string, unknown>;
                  const isRequired = requiredFields.includes(paramName);
                  const paramType = param.type as string;
                  const paramDescription = typeof param.description === 'string' ? param.description : null;
                  const paramEnum = Array.isArray(param.enum) && param.enum.length > 0 ? param.enum : null;

                  return (
                    <div
                      key={paramName}
                      className="rounded-lg bg-muted/50 p-3 text-sm"
                    >
                      <div className="flex items-baseline gap-2">
                        <code className="font-mono font-semibold text-primary">
                          {paramName}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          {paramType}
                          {isRequired && <span className="ml-1 font-semibold text-red-500">*</span>}
                        </span>
                      </div>
                      {paramDescription && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {paramDescription}
                        </p>
                      )}
                      {paramEnum && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Allowed values:{' '}
                          {(paramEnum as unknown[]).map(String).join(', ')}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No parameters</p>
          )}

          {requiredFields.length > 0 && (
            <div className="rounded-lg border border-border/40 bg-background/50 p-3 text-xs">
              <span className="font-semibold text-muted-foreground">Required fields: </span>
              <code className="font-mono">{requiredFields.join(', ')}</code>
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
              <div className="space-y-2">
                {Object.entries(properties).map(([paramName]) => (
                  <div key={paramName}>
                    <label className="text-xs font-medium text-muted-foreground">
                      {paramName}
                    </label>
                    <input
                      type="text"
                      value={formData[paramName] || ''}
                      onChange={(e) => handleFormChange(paramName, e.target.value)}
                      placeholder={`Enter ${paramName}`}
                      className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                    />
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

          <div className="rounded-lg bg-muted/30 p-3 overflow-x-auto">
            <h4 className="mb-2 text-sm font-semibold text-foreground">Full Schema</h4>
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words">
              {JSON.stringify(tool, null, 2)}
            </pre>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

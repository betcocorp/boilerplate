'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { Tool } from 'openai/resources/responses/responses';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';

interface ToolDocumentationProps {
  tool: Tool;
}

export function ToolDocumentation({ tool }: ToolDocumentationProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (tool.type !== 'function') {
    return null;
  }

  const parameters = tool.parameters as Record<string, unknown> | undefined;
  const properties = (parameters?.properties as Record<string, unknown>) || {};
  const requiredFields = (parameters?.required as string[]) || [];

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

          <div className="rounded-lg bg-muted/30 p-3 overflow-x-auto">
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words">
              {JSON.stringify(tool, null, 2)}
            </pre>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

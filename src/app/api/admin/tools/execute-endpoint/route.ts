import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ExecuteEndpointPayload {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  parameters: Record<string, unknown>;
  authType?: 'Session' | 'Bearer Token' | 'Public';
  bearerToken?: string;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    const payload: ExecuteEndpointPayload = await request.json();
    const { path, method, parameters, authType, bearerToken } = payload;

    if (!path || !method) {
      return NextResponse.json(
        { error: 'Missing required fields: path, method' },
        { status: 400 },
      );
    }

    // Check authentication based on authType
    if (authType === 'Session' && !session) {
      return NextResponse.json(
        { error: 'Session authentication required' },
        { status: 401 },
      );
    }

    // Build the URL with path parameters
    let resolvedPath = path;
    if (parameters) {
      // Replace path parameters like :paramName
      Object.entries(parameters).forEach(([key, value]) => {
        if (resolvedPath.includes(`:${key}`)) {
          resolvedPath = resolvedPath.replace(`:${key}`, String(value));
        }
      });
    }

    const url = new URL(resolvedPath, request.nextUrl.origin);

    // Add query parameters for GET requests
    if (method === 'GET' && parameters) {
      Object.entries(parameters).forEach(([key, value]) => {
        if (!path.includes(`:${key}`)) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    // Prepare request headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authType === 'Bearer Token' && bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`;
    }

    // Prepare request body for non-GET requests
    let body: string | undefined;
    if (method !== 'GET' && parameters) {
      const bodyParams: Record<string, unknown> = {};
      Object.entries(parameters).forEach(([key, value]) => {
        if (!path.includes(`:${key}`) && value !== '' && value !== null) {
          bodyParams[key] = value;
        }
      });
      if (Object.keys(bodyParams).length > 0) {
        body = JSON.stringify(bodyParams);
      }
    }

    // Make the request
    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      credentials: authType === 'Session' ? 'include' : 'omit',
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data.error || `Request failed with status ${response.status}`, details: data },
        { status: response.status },
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

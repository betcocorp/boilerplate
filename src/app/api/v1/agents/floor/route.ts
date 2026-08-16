import { createSmeAgentPostHandler } from '~/lib/agents/sme/agent-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = createSmeAgentPostHandler('floor');

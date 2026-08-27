export interface EndpointParameter {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  enum?: string[];
}

export interface EndpointDefinition {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  name: string;
  description: string;
  category: 'Bex' | 'Admin Tools' | 'RAG' | 'Agents' | 'Orchestrator' | 'Auth' | 'Observability';
  parameters: EndpointParameter[];
  response?: {
    description: string;
    example?: Record<string, unknown>;
  };
  auth?: 'Session' | 'Bearer Token' | 'Public';
}

export const webEndpoints: EndpointDefinition[] = [
  {
    path: '/api/bex/chat/stream',
    method: 'POST',
    name: 'Stream Bex Chat',
    description: 'Stream AI-generated responses for Bex chat with tool integration and real-time token streaming.',
    category: 'Bex',
    parameters: [
      {
        name: 'message',
        type: 'string',
        required: true,
        description: 'The user message to process',
      },
      {
        name: 'conversationId',
        type: 'string',
        required: false,
        description: 'Existing conversation ID for context, or a new one is created',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/bex/conversations',
    method: 'GET',
    name: 'List Conversations',
    description: 'Retrieve the current user\'s Bex chat conversation history.',
    category: 'Bex',
    parameters: [],
    auth: 'Session',
  },
  {
    path: '/api/bex/conversations',
    method: 'POST',
    name: 'Create Conversation',
    description: 'Start a new Bex chat conversation.',
    category: 'Bex',
    parameters: [
      {
        name: 'title',
        type: 'string',
        required: false,
        description: 'Optional conversation title',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/v1/orchestrator',
    method: 'POST',
    name: 'Run Orchestrator',
    description: 'Execute a product-support workflow with SME agent routing and tool execution.',
    category: 'Orchestrator',
    parameters: [
      {
        name: 'message',
        type: 'string',
        required: true,
        description: 'The customer query to process',
      },
      {
        name: 'context',
        type: 'object',
        required: false,
        description: 'Optional context for the orchestration',
      },
    ],
    auth: 'Bearer Token',
  },
  {
    path: '/api/v1/agents',
    method: 'GET',
    name: 'List Agents',
    description: 'Get the registry of available SME agents (product, dilution, bathroom, floor, cross_reference, recommendations).',
    category: 'Agents',
    parameters: [],
    auth: 'Bearer Token',
  },
  {
    path: '/api/v1/agents/:agentId',
    method: 'POST',
    name: 'Invoke SME Agent',
    description: 'Call a specific SME agent for targeted expertise (product, dilution, bathroom, floor, cross_reference, recommendations).',
    category: 'Agents',
    parameters: [
      {
        name: 'agentId',
        type: 'string',
        required: true,
        description: 'Agent ID: product, dilution, bathroom, floor, cross_reference, or recommendations',
        enum: ['product', 'dilution', 'bathroom', 'floor', 'cross_reference', 'recommendations'],
      },
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'The query to send to the agent',
      },
    ],
    auth: 'Bearer Token',
  },
  {
    path: '/api/v1/tools',
    method: 'GET',
    name: 'List Tools',
    description: 'Get the registry of all product-support tools callable by agents.',
    category: 'Admin Tools',
    parameters: [],
    auth: 'Bearer Token',
  },
  {
    path: '/api/v1/tools/web-search',
    method: 'POST',
    name: 'Web Search Tool',
    description: 'Execute a web search with trust scoring, cost guardrails, and provider failover.',
    category: 'Admin Tools',
    parameters: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum results (default: 5)',
      },
    ],
    auth: 'Bearer Token',
  },
  {
    path: '/api/v1/tools/efficacy',
    method: 'POST',
    name: 'Efficacy Tool',
    description: 'Search product efficacy claims and kill logs for bacteria/viruses.',
    category: 'Admin Tools',
    parameters: [
      {
        name: 'productId',
        type: 'string',
        required: true,
        description: 'Product name or code',
      },
      {
        name: 'organism',
        type: 'string',
        required: true,
        description: 'Bacteria, virus, or organism name',
      },
    ],
    auth: 'Bearer Token',
  },
  {
    path: '/api/rag/search',
    method: 'POST',
    name: 'RAG Semantic Search',
    description: 'Search product documentation using vector embeddings with reranking.',
    category: 'RAG',
    parameters: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum results (default: 5)',
      },
      {
        name: 'productId',
        type: 'string',
        required: false,
        description: 'Filter to specific product',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/admin/tools/execute/:toolName',
    method: 'POST',
    name: 'Execute Tool (Admin)',
    description: 'Execute a product-support tool with parameters and return results (admin only).',
    category: 'Admin Tools',
    parameters: [
      {
        name: 'toolName',
        type: 'string',
        required: true,
        description: 'Name of the tool to execute (e.g. search_product_docs, lookup_cross_reference)',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/admin/tools/cross-reference-recommend',
    method: 'POST',
    name: 'Cross-Reference Recommend (Admin)',
    description: 'Test the cross-reference pipeline and recommendation generation.',
    category: 'Admin Tools',
    parameters: [
      {
        name: 'competitorProduct',
        type: 'string',
        required: true,
        description: 'Competitor product name to look up',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/admin/web-search',
    method: 'POST',
    name: 'Web Search (Admin)',
    description: 'Execute web searches for admin testing.',
    category: 'Admin Tools',
    parameters: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/admin/tests/runs',
    method: 'GET',
    name: 'List Test Runs',
    description: 'Retrieve evaluation test run history.',
    category: 'Observability',
    parameters: [
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum results',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/admin/tests/runs/:runId/report/data',
    method: 'GET',
    name: 'Get Test Report Data',
    description: 'Fetch structured data for an evaluation test run report.',
    category: 'Observability',
    parameters: [
      {
        name: 'runId',
        type: 'string',
        required: true,
        description: 'Test run ID',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/admin/observability/runs/:runId/insights',
    method: 'GET',
    name: 'Get Run Insights',
    description: 'Get performance metrics and insights for a workflow run.',
    category: 'Observability',
    parameters: [
      {
        name: 'runId',
        type: 'string',
        required: true,
        description: 'Workflow run ID',
      },
    ],
    auth: 'Session',
  },
  {
    path: '/api/admin/permissions',
    method: 'GET',
    name: 'List Permissions',
    description: 'Retrieve all permission definitions and assignments.',
    category: 'Auth',
    parameters: [],
    auth: 'Session',
  },
  {
    path: '/api/me',
    method: 'GET',
    name: 'Get Current User',
    description: 'Retrieve authenticated user profile and permissions.',
    category: 'Auth',
    parameters: [],
    auth: 'Session',
  },
  {
    path: '/api/auth/:provider/callback',
    method: 'GET',
    name: 'OAuth Callback',
    description: 'Handle OAuth provider callback (Azure AD).',
    category: 'Auth',
    parameters: [
      {
        name: 'code',
        type: 'string',
        required: true,
        description: 'Authorization code from provider',
      },
    ],
    auth: 'Public',
  },
];

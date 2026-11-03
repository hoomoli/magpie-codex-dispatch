#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { workerRequest } from './hook-client.js';
import { pluginVersion } from './version.js';

const session = { sessionId: { type: 'string', description: 'Claude session UUID from the completion reminder.' } };
const tools = [
  { name: 'codex_review_complete', description: 'Record a review after checking the exact Codex turn and its changes. This does not dispatch or approve work.', inputSchema: { type: 'object', properties: { ...session, eventId: { type: 'string' }, verdict: { type: 'string', enum: ['passed', 'changes_requested', 'unable_to_review'] }, summary: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['sessionId', 'eventId', 'verdict', 'summary'], additionalProperties: false } },
  { name: 'codex_notification_status', description: 'Inspect saved notification and review state for diagnosis. Do not poll this tool.', inputSchema: { type: 'object', properties: session, required: ['sessionId'], additionalProperties: false } },
];
const server = new Server({ name: 'codex-notifications', version: pluginVersion }, { capabilities: { tools: {} }, instructions: 'Magpie dispatch completion is bound by native Claude hooks. Finish your response after task acceptance; the completion reminder wakes this session. Review the exact result before acknowledging. Do not poll.' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const { sessionId, ...args } = req.params.arguments ?? {};
    if (!tools.some(t => t.name === req.params.name)) throw new Error('Unknown tool.');
    const method = req.params.name === 'codex_review_complete' ? 'review' : 'status';
    const result = await workerRequest(sessionId, method, args);
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, pluginVersion }) }] };
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'Notification operation failed. Verify the session/event identity and saved review; do not resubmit work.' }] };
  }
});
await server.connect(new StdioServerTransport());

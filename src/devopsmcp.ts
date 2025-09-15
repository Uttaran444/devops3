import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { URL } from 'url';

// Helper function to safely send notifications (used by makeApiCall)
async function safeNotify(sendNotification: (notification: any) => void | Promise<void>, notification: any): Promise<void> {
  try {
    await sendNotification(notification);
  } catch (error) {
    // Silently ignore notification errors
  }
}

// Helper to extract a short excerpt from a larger text around the first occurrence of a query
function extractExcerpt(text: string, query: string, radius = 120): string {
  if (!text) return '';
  const hay = text.toLowerCase();
  const q = (query || '').toLowerCase();
  const idx = q ? hay.indexOf(q) : -1;
  if (idx === -1) {
    // return the first chunk
    return text.slice(0, radius) + (text.length > radius ? '...' : '');
  }
  const start = Math.max(0, idx - Math.floor(radius / 2));
  const end = Math.min(text.length, idx + q.length + Math.floor(radius / 2));
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = '...' + excerpt;
  if (end < text.length) excerpt = excerpt + '...';
  return excerpt.replace(/\s+/g, ' ').trim();
}

// Remove HTML tags and normalize whitespace
function stripHtmlAndNormalize(s: string): string {
  if (!s) return '';
  // remove tags
  const noHtml = s.replace(/<[^>]*>/g, ' ');
  return noHtml.replace(/\s+/g, ' ').trim();
}

export async function makeApiCall(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body: Record<string, unknown> | null,
  sendNotification: (notification: any) => void | Promise<void>
): Promise<CallToolResult> {
  try {
    await safeNotify(sendNotification, {
      method: 'notifications/message',
      params: { level: 'info', data: `Calling ${method} ${url}` }
    });

  // Use PAT from environment for auth
  const token = process.env.AZDO_PAT || 'ERxpNndJTL9NbeFn5FoiS7hPYk9O97ChhGOfwpjj5cQ8Jchk8Xf1JQQJ99BIACAAAAAMF3UqAAASAZDOgJBl';
  const authHeader = 'Basic ' + Buffer.from(':' + token).toString('base64');

    const response = await fetch(url, {
      method: method,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/xml',
        'Prefer': 'odata.maxpagesize=100'
      },
      ...(body && { body: JSON.stringify(body) }),
    });

    if (response.status === 204) {
      return { content: [{ type: 'text', text: 'Operation successful (No Content).' }] };
    }

    const responseText = await response.text();

    if (!response.ok) {
      await safeNotify(sendNotification, {
        method: 'notifications/message',
        params: { level: 'error', data: `API call failed with status ${response.status}: ${responseText}` }
      });
      try {
        const errorJson = JSON.parse(responseText);
        const prettyError = JSON.stringify(errorJson, null, 2);
        return { isError: true, content: [{ type: 'text', text: `API Error: ${response.status}\n${prettyError}` }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `API Error: ${response.status}\n${responseText}` }] };
      }
    }

    const contentType = response.headers.get('Content-Type');
    if (contentType?.includes('text/plain') || contentType?.includes('application/xml')) {
      return { content: [{ type: 'text', text: responseText }] };
    }

    try {

  const jsonResponse = JSON.parse(responseText);
  const nextLink = jsonResponse['@odata.nextLink'];
  let resultText = JSON.stringify(jsonResponse, null, 2);

      if (nextLink) {
        const nextUrl = new URL(nextLink);
        const skipParam = nextUrl.searchParams.get('$skip');
        const paginationHint = `\n\n---\n[INFO] More data is available. To get the next page, call the 'odataQuery' tool again with the parameter: "skip": ${skipParam}.`;
        resultText += paginationHint;

        await safeNotify(sendNotification, {
          method: 'notifications/message',
          params: { level: 'info', data: `More data available. Next skip token is ${skipParam}.` }
        });
      }

  return { content: [{ type: 'text', text: resultText }], json: jsonResponse } as unknown as CallToolResult;
    } catch {
      return { content: [{ type: 'text', text: responseText }] };
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error in makeApiCall: ${errorMessage}`);
    await safeNotify(sendNotification, {
      method: 'notifications/message',
      params: { level: 'error', data: `An unexpected error occurred: ${errorMessage}` }
    });
    return { isError: true, content: [{ type: 'text', text: `An unexpected error occurred: ${errorMessage}` }] };
  }
}
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import 'dotenv/config';

// Define the schema using z.object and .shape
const getWorkItemListByTypeSchema = z.object({
  workItemType: z.string().describe('Work item type like Bug, Task, User Story'),
});

export const getServer = (): McpServer => {
  const server = new McpServer({
    name: 'azure-devops-mcp-server',
    version: '1.0.0',
  });

  // Helper to safely forward notifications to MCP context
  async function safeNotification(context: RequestHandlerExtra<any, any>, notification: any) {
    try {
      await context.sendNotification(notification);
    } catch (e) {
      // ignore
    }
  }

  server.tool(
    'getWorkItemListByType',
    'Fetches a list of work items by type from Azure DevOps (via REST).',
    getWorkItemListByTypeSchema.shape,
    async (args, context: RequestHandlerExtra<any, any>) => {
      const { workItemType } = args as { workItemType: string };
      try {
        const org = process.env.AZDO_ORG_NAME || process.env.AZDO_ORG_URL || 'ustest123';
        const project = process.env.AZDO_PROJECT || 'USDevOpsProject';
        const apiVersion = '7.1';

        // Build WIQL POST URL and body
        const wiqlUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=${apiVersion}`;
        const wiqlBody = { query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = '${workItemType}' AND [System.TeamProject] = '${project}' ORDER BY [System.ChangedDate] DESC` };

        const wiqlResult = await makeApiCall('POST', wiqlUrl, wiqlBody, async (notification: any) => { await safeNotification(context, notification); });
        if (wiqlResult.isError) return wiqlResult;

        // Prefer parsed JSON if available
        let wiqlJson: any = (wiqlResult as any).json ?? null;
        if (!wiqlJson) {
          const wiqlText = String(wiqlResult.content?.[0]?.text || '');
          try {
            wiqlJson = JSON.parse(wiqlText);
          } catch {
            return { isError: true, content: [{ type: 'text', text: 'Failed to parse WIQL response.' }] };
          }
        }

        const ids = wiqlJson.workItems ? wiqlJson.workItems.map((w: any) => w.id).filter((id: any) => id !== undefined) : [];
        if (!ids.length) {
          return { content: [{ type: 'text', text: `No ${workItemType} work items found.` }] };
        }

        const idsParam = ids.join(',');
        const workItemsUrl = `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${idsParam}&api-version=${apiVersion}`;
        const workItemsResult = await makeApiCall('GET', workItemsUrl, null, async (notification: any) => { await safeNotification(context, notification); });
        if (workItemsResult.isError) return workItemsResult;

        // Prefer parsed JSON or fall back to text
        const workItemsJson = (workItemsResult as any).json ?? null;
        let workItems: any[] = [];
        if (workItemsJson && workItemsJson.value) workItems = workItemsJson.value;
        else {
          // Try to parse textual response
          const text = String(workItemsResult.content?.[0]?.text || '');
          try {
            const parsed = JSON.parse(text);
            workItems = parsed.value || parsed;
          } catch {
            return { isError: true, content: [{ type: 'text', text: 'Failed to parse work items response.' }] };
          }
        }

        let workItemsLog = '';
        workItems.forEach((item: any) => {
          const title = item.fields?.['System.Title'] || 'NO TITLE';
          const state = item.fields?.['System.State'] || 'NO STATE';
          workItemsLog += `ID: ${item.id}, Title: ${title}, State: ${state}\n`;
        });

        return { content: [{ type: 'text', text: workItemsLog }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Error fetching work items: ${msg}` }] };
      }
    }
  );

  // Schema for the new tool: search discussions for a query and return matching work items plus related items
  const getWorkItemsDeatilsSchema = z.object({
    query: z.string().describe('Search phrase to match inside work item discussions'),
    ids: z.array(z.number()).optional().describe('Optional list of work item IDs to restrict the search')
  });

  server.tool(
    'getWorkItemsDeatils',
    'Searches work item discussions for a query and returns matching work items with related items.',
    getWorkItemsDeatilsSchema.shape,
    async (args, context: RequestHandlerExtra<any, any>) => {
      const { query, ids } = args as { query: string; ids?: number[] };
      try {
        const org = process.env.AZDO_ORG_NAME || process.env.AZDO_ORG_URL || 'ustest123';
        const project = process.env.AZDO_PROJECT || 'USDevOpsProject';
        const apiVersion = '7.1';

        // If IDs not provided, fetch recent work item ids for the project (limit to 100)
        let workItemIds: number[] = ids && ids.length ? ids : [];
        if (!workItemIds.length) {
          const wiqlUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=${apiVersion}`;
          const wiqlBody = { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' ORDER BY [System.ChangedDate] DESC` };
          const wiqlResult = await makeApiCall('POST', wiqlUrl, wiqlBody, async (n:any) => { await safeNotification(context, n); });
          if (wiqlResult.isError) return wiqlResult;
          const wiqlJson = (wiqlResult as any).json ?? JSON.parse(String(wiqlResult.content?.[0]?.text || '{}'));
          workItemIds = (wiqlJson.workItems || []).map((w: any) => w.id).filter((id: any) => typeof id === 'number').slice(0, 100);
        }

        if (!workItemIds.length) {
          return { content: [{ type: 'text', text: 'No work items found to search.' }] };
        }

        // Limit the number of work items we expand/fetch comments for to avoid too many calls
        const limitedIds = workItemIds.slice(0, 50);

        // Fetch work item details (fields + relations)
        const idsParam = limitedIds.join(',');
        const workItemsUrl = `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${idsParam}&api-version=${apiVersion}&$expand=all`;
        const workItemsResult = await makeApiCall('GET', workItemsUrl, null, async (n:any) => { await safeNotification(context, n); });
        if (workItemsResult.isError) return workItemsResult;
        const workItemsJson = (workItemsResult as any).json ?? JSON.parse(String(workItemsResult.content?.[0]?.text || '{}'));
        const workItems: any[] = workItemsJson.value || workItemsJson;

        // Fetch comments for each work item (in parallel, but limited)
        const commentsById: Record<number, string> = {};
        await Promise.all(limitedIds.map(async (id) => {
          try {
            const commentsUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workItems/${id}/comments?api-version=${apiVersion}`;
            const commentsResult = await makeApiCall('GET', commentsUrl, null, async (n:any) => { await safeNotification(context, n); });
            if (commentsResult.isError) return;
            const commentsJson = (commentsResult as any).json ?? JSON.parse(String(commentsResult.content?.[0]?.text || '{}'));
            const commentsArr = commentsJson.comments || [];
            const combined = commentsArr.map((c: any) => c.text || '').join('\n---\n');
            commentsById[id] = combined;
          } catch (e) {
            // ignore individual comment fetch errors
            commentsById[id] = '';
          }
        }));

        const qRaw = query.trim();
        const q = stripHtmlAndNormalize(qRaw).toLowerCase();
        const queryTokens = q.split(/[^a-z0-9]+/).filter(t => t.length >= 3);

        const matches: any[] = [];
        const related: any[] = [];

        // Find matches based on discussion/comments and also gather related items
        for (const wi of workItems) {
          const id = wi.id;
          const title = wi.fields?.['System.Title'] || '';
          const state = wi.fields?.['System.State'] || '';
          const discussionRaw = (commentsById[id] || '') + '\n' + (wi.fields?.['System.Description'] || '');
          const discussion = stripHtmlAndNormalize(discussionRaw);
          const discLower = discussion.toLowerCase();

          if (q && discLower.includes(q)) {
            // exact substring match
            matches.push({ id, title, state, excerpt: extractExcerpt(discussion, qRaw) });
            continue;
          }

          // token overlap heuristic for related detection
          let matchedTokens = 0;
          for (const tok of queryTokens) {
            if (discLower.includes(tok)) matchedTokens++;
          }
          const overlap = queryTokens.length ? matchedTokens / queryTokens.length : 0;

          // If overlap >= 50%, treat as a direct match; if >= 25% treat as related
          if (overlap >= 0.5) {
            matches.push({ id, title, state, excerpt: extractExcerpt(discussion, qRaw) });
          } else if (overlap >= 0.25) {
            related.push({ id, title, state, excerpt: extractExcerpt(discussion, qRaw) });
          }
        }

        // Format output
        if (!matches.length) {
          return { content: [{ type: 'text', text: `No work items found matching: "${query}"` }] };
        }

        let out = '';
        for (const m of matches) {
          out += `MATCH -> ID: ${m.id}, Title: ${m.title}, State: ${m.state}\nDiscussion excerpt:\n${m.excerpt}\n\n`;
          if (related.length) {
            out += 'Related items:\n';
            for (const r of related) {
              out += `  ID: ${r.id}, Title: ${r.title}, State: ${r.state}\n    Excerpt: ${r.excerpt}\n`;
            }
            out += '\n';
          }
        }

        return { content: [{ type: 'text', text: out }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Error searching work item discussions: ${msg}` }] };
      }
    }
  );

  return server;
};


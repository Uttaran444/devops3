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
  const token = process.env.AZDO_PAT || 'fm5prWn2B76K6L1g1lC5EA3UYgcVPA4IyDSjl3kMcFU1v46aABi0JQQJ99BIACAAAAAMF3UqAAASAZDO3ht3';
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

  return server;
};


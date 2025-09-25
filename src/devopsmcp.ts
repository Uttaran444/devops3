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

// Tokenize a string into normalized tokens (alphanumeric, length >= minLen)
function tokenize(s: string, minLen = 2): string[] {
  if (!s) return [];
  return stripHtmlAndNormalize(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= minLen);
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
  const token = process.env.AZDO_PAT || '35TWJV668ReQIouJ4oyVyQvAeKH3ukzgrf8DWi45d40RRErHqBR1JQQJ99BIACAAAAAMF3UqAAASAZDO34VZ';
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
        const apiVersion = '7.1-preview';

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

        // Fetch work item details one-by-one (fields + relations) to avoid long comma-separated id lists
        const workItems: any[] = [];
        for (const wid of limitedIds) {
          try {
            const singleUrl = `https://dev.azure.com/${org}/_apis/wit/workitems/${wid}?api-version=${apiVersion}&$expand=all`;
            const singleResult = await makeApiCall('GET', singleUrl, null, async (n:any) => { await safeNotification(context, n); });
            if (singleResult.isError) {
              // skip this id but notify
              await safeNotification(context, { method: 'notifications/message', params: { level: 'warning', data: `Skipping work item ${wid} due to fetch error.` } });
              continue;
            }
            const singleJson = (singleResult as any).json ?? JSON.parse(String(singleResult.content?.[0]?.text || '{}'));
            // If the API returned an object directly, push it; otherwise if wrapped, handle accordingly
            if (singleJson) {
              // Azure returns the work item object directly
              workItems.push(singleJson);
            }
          } catch (e) {
            await safeNotification(context, { method: 'notifications/message', params: { level: 'warning', data: `Error fetching work item ${wid}: ${String(e)}` } });
          }
        }

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
        const queryTokens = tokenize(qRaw, 2);

        // Compute weighted score per work item based on title and discussion token overlap
        const scored: Array<{ id: number; title: string; state: string; score: number; excerpt: string }> = [];
        for (const wi of workItems) {
          const id = wi.id;
          const title = wi.fields?.['System.Title'] || '';
          const state = wi.fields?.['System.State'] || '';
          const discussionRaw = (commentsById[id] || '') + '\n' + (wi.fields?.['System.Description'] || '');

          const titleTokens = tokenize(title, 2);
          const discTokens = tokenize(discussionRaw, 2);

          if (!queryTokens.length) continue;

          const matchCountTitle = queryTokens.filter(t => titleTokens.includes(t)).length;
          const matchCountDisc = queryTokens.filter(t => discTokens.includes(t)).length;

          const titleOverlap = matchCountTitle / queryTokens.length;
          const discOverlap = matchCountDisc / queryTokens.length;

          // Weighted score: title counts more (0.6) than discussion (0.4)
          const score = (0.6 * titleOverlap) + (0.4 * discOverlap);

          const excerpt = extractExcerpt(stripHtmlAndNormalize(discussionRaw), qRaw);
          scored.push({ id, title, state, score, excerpt });
        }

        if (!scored.length) {
          return { content: [{ type: 'text', text: `No work items found matching: "${query}"` }] };
        }

        // Filter and return all items meeting the threshold (30%), sorted by score desc
        const threshold = 0.3; // 30%
        const matches = scored.filter(s => s.score >= threshold).sort((a, b) => b.score - a.score);
        if (!matches.length) {
          return { content: [{ type: 'text', text: `No work items found matching: "${query}"` }] };
        }

        // Build a human-readable text output and also include a structured JSON payload for downstream use
        let out = '';
        for (const m of matches) {
          out += `MATCH -> ID: ${m.id}, Title: ${m.title}, State: ${m.state}, Score: ${(m.score * 100).toFixed(0)}%\nDiscussion excerpt:\n${m.excerpt}\n\n`;
        }

        return { content: [{ type: 'text', text: out }], json: { query, threshold, matches } } as unknown as CallToolResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Error searching work item discussions: ${msg}` }] };
      }
    }
  );

  // Tool: filter work items by date and/or status (overdue, last month, completed in month, open, etc.)
  const getWorkItemsByDateStatusSchema = z.object({
    query: z.string().optional().describe('Natural language filter like "overdue", "last month", "completed in June", "open"'),
    start: z.string().optional().describe('Optional ISO date start override (yyyy-mm-dd)'),
    end: z.string().optional().describe('Optional ISO date end override (yyyy-mm-dd)'),
    status: z.string().optional().describe('Optional status filter, e.g., "Done", "Closed", "Active"'),
    ids: z.array(z.number()).optional().describe('Optional list of work item IDs to restrict the search')
  });

  server.tool(
    'getWorkItemsByDateStatus',
    'Filter work items by date and status (overdue, in a month, completed in month, open, etc.)',
    getWorkItemsByDateStatusSchema.shape,
    async (args, context: RequestHandlerExtra<any, any>) => {
      const { query, start, end, status, ids } = args as { query?: string; start?: string; end?: string; status?: string; ids?: number[] };
      try {
        const org = process.env.AZDO_ORG_NAME || process.env.AZDO_ORG_URL || 'ustest123';
        const project = process.env.AZDO_PROJECT || 'USDevOpsProject';
        const apiVersion = '7.1-preview';

        // Helper: recursively search a value for an ISO-like date string
        function parseDateFromValue(val: any, depth = 0): Date | null {
          if (val == null) return null;
          if (typeof val === 'string' || typeof val === 'number') {
            const s = String(val).trim();
            // quick ISO-like check (YYYY- or YYYY/ or timestamp)
            if (/\d{4}-\d{2}-\d{2}T|\d{4}-\d{2}-\d{2}$|\d{4}\/\d{2}\/\d{2}/.test(s)) {
              const d = new Date(s);
              if (!isNaN(d.valueOf())) return d;
            }
            // try lax parse
            const d2 = new Date(s);
            if (!isNaN(d2.valueOf())) return d2;
            return null;
          }
          if (depth > 3) return null;
          if (Array.isArray(val)) {
            for (const it of val) {
              const r = parseDateFromValue(it, depth + 1);
              if (r) return r;
            }
            return null;
          }
          if (typeof val === 'object') {
            // check common date-like props first
            for (const p of ['date', 'value', 'dueDate', 'completedDate', 'createdDate', 'closedDate']) {
              if (val[p]) {
                const r = parseDateFromValue(val[p], depth + 1);
                if (r) return r;
              }
            }
            // otherwise scan all string props
            for (const k of Object.keys(val)) {
              const r = parseDateFromValue(val[k], depth + 1);
              if (r) return r;
            }
          }
          return null;
        }

        // Helper: try to extract a date value from work item fields (common field names)
        function getDateFromFields(fields: Record<string, any>): Date | null {
          if (!fields) return null;
          // Prefer explicit system dates first
          const sysKeys = ['System.ChangedDate', 'System.CreatedDate', 'System.ClosedDate', 'Microsoft.VSTS.Common.ClosedDate'];
          for (const k of sysKeys) {
            if (fields[k]) {
              const d = parseDateFromValue(fields[k]);
              if (d) return d;
            }
          }

          // Look for keys that contain 'target', 'due', 'date', 'completed', or 'closed'
          const candidates = Object.keys(fields).filter(k => /due|target|date|completed|closed/i.test(k));
          for (const k of candidates) {
            const d = parseDateFromValue(fields[k]);
            if (d) return d;
          }

          // As a last resort, scan all fields recursively for any date-like value
          for (const k of Object.keys(fields)) {
            const d = parseDateFromValue(fields[k]);
            if (d) return d;
          }

          return null;
        }

        function isDoneState(s: string | undefined) {
          if (!s) return false;
          const st = s.toLowerCase();
          return ['done', 'closed', 'completed', 'resolved', 'removed'].includes(st);
        }

        // Allow customizing which fields count as the "target/due" date via env var
        const targetDateFieldCandidates: string[] = (process.env.AZDO_TARGET_DATE_FIELDS || 'Target Date,dueDate,Due Date,TargetDate,Microsoft.VSTS.Scheduling.DueDate,Custom.TargetDate').split(',').map(s => s.trim()).filter(Boolean);

        function getTargetDateFromFields(fields: Record<string, any>): Date | null {
          if (!fields) return null;
          // Check configured candidate field names first
          for (const candidate of targetDateFieldCandidates) {
            const direct = fields[candidate] ?? fields[candidate.replace(/\s+/g, '')];
            if (direct) {
              const d = parseDateFromValue(direct);
              if (d) return d;
            }
            const foundKey = Object.keys(fields).find(k => k.toLowerCase() === candidate.toLowerCase());
            if (foundKey) {
              const vv = fields[foundKey];
              const d = parseDateFromValue(vv);
              if (d) return d;
            }
          }

          // If not found, try keys that look like target/due/date
          const candidates = Object.keys(fields).filter(k => /due|target|date/i.test(k));
          for (const k of candidates) {
            const d = parseDateFromValue(fields[k]);
            if (d) return d;
          }

          // Nothing found
          return null;
        }

        // Parse natural language query for some common intents
    const q = (query || '').toLowerCase();
        const now = new Date();
  let rangeStart: Date | null = null;
  let rangeEnd: Date | null = null;
  let wantOpenOnly = false;
  let wantDoneOnly = false;
  let wantCompletedInMonth: { month: number; year: number } | null = null;
  let preferTargetDateOnly = false;

        if (start) rangeStart = new Date(start);
        if (end) rangeEnd = new Date(end);

        if (!start && /overdue|already passed|past due|target date already passed/.test(q)) {
          // overdue: date < today
          rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          rangeStart = null; // any before
        }
        if (/last month/.test(q)) {
          const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
          const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 1);
          rangeStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
          rangeEnd = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), lastMonthEnd.getDate(), 23, 59, 59, 999);
        }
        // completed in <month>
        const monthMatch = q.match(/completed.*\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
        if (monthMatch) {
          const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
          const m = monthNames.indexOf(monthMatch[1]);
          const y = now.getFullYear();
          wantCompletedInMonth = { month: m, year: y };
          rangeStart = new Date(y, m, 1);
          rangeEnd = new Date(y, m + 1, 0, 23, 59, 59, 999);
        }
        if (/open\b|open work items|open items/.test(q)) {
          wantOpenOnly = true;
        }

        // If user asked for completed/done work items, filter to done-like states
        if (/(^|\W)(completed|completed workitems|completed work items|completed items|done|finished|closed)(\W|$)/.test(q)) {
          wantDoneOnly = true;
        }

        // If the user explicitly mentions target/due date, prefer that field only
        if (/(target date|due date|targetdate|duedate|target)/.test(q)) {
          preferTargetDateOnly = true;
        }

        // If explicit status argument provided, use it
        const explicitStatus = status ? status.toLowerCase() : undefined;

        // Get work item ids (reuse pattern from other tools)
        let workItemIds: number[] = ids && ids.length ? ids : [];
        if (!workItemIds.length) {
          const wiqlUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=${apiVersion}`;
          const wiqlBody = { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' ORDER BY [System.ChangedDate] DESC` };
          const wiqlResult = await makeApiCall('POST', wiqlUrl, wiqlBody, async (n:any) => { await safeNotification(context, n); });
          if (wiqlResult.isError) return wiqlResult;
          const wiqlJson = (wiqlResult as any).json ?? JSON.parse(String(wiqlResult.content?.[0]?.text || '{}'));
          workItemIds = (wiqlJson.workItems || []).map((w: any) => w.id).filter((id: any) => typeof id === 'number').slice(0, 200);
        }

        if (!workItemIds.length) return { content: [{ type: 'text', text: 'No work items found to search.' }] };

        const limitedIds = workItemIds.slice(0, 200);

        const workItems: any[] = [];
        for (const wid of limitedIds) {
          try {
            const singleUrl = `https://dev.azure.com/${org}/_apis/wit/workitems/${wid}?api-version=${apiVersion}&$expand=all`;
            const singleResult = await makeApiCall('GET', singleUrl, null, async (n:any) => { await safeNotification(context, n); });
            if (singleResult.isError) continue;
            const singleJson = (singleResult as any).json ?? JSON.parse(String(singleResult.content?.[0]?.text || '{}'));
            if (singleJson) workItems.push(singleJson);
          } catch (e) {
            // ignore
          }
        }

        // Filter based on parsed criteria
        const matches: Array<{ id: number; title: string; state: string; date: string | null }> = [];
        for (const wi of workItems) {
          const id = wi.id;
          const title = wi.fields?.['System.Title'] || '';
          const state = wi.fields?.['System.State'] || '';
          // determine which date to use: if user asked specifically for target/due date, only use that
          let dateObj: Date | null = null;
          if (preferTargetDateOnly) {
            dateObj = getTargetDateFromFields(wi.fields || {});
          } else {
            // prefer target date if present, otherwise fall back to heuristics
            dateObj = getTargetDateFromFields(wi.fields || {}) || getDateFromFields(wi.fields || {});
          }

          // status filters
          if (explicitStatus) {
            if ((state || '').toLowerCase() !== explicitStatus) continue;
          }
          if (wantOpenOnly && isDoneState(state)) continue;
          // If user explicitly asked for completed/done items, filter to done-like states
          if (wantDoneOnly && !isDoneState(state)) continue;
          if (wantCompletedInMonth) {
            if (!isDoneState(state)) continue;
            if (!dateObj) continue;
            const m = dateObj.getMonth();
            const y = dateObj.getFullYear();
            if (m !== wantCompletedInMonth.month || y !== wantCompletedInMonth.year) continue;
          }

          // date range checks
          if (rangeStart || rangeEnd) {
            if (!dateObj) continue;
            if (rangeStart && dateObj < rangeStart) continue;
            if (rangeEnd && dateObj > rangeEnd) continue;
          }

          // overdue check when rangeEnd is today and no start
          if (/overdue|past due/.test(q) && !rangeStart && rangeEnd) {
            if (!dateObj) continue;
            if (!(dateObj < rangeEnd)) continue;
          }

          matches.push({ id, title, state, date: dateObj ? dateObj.toISOString() : null });
        }

        if (!matches.length) return { content: [{ type: 'text', text: 'No matching work items found for the given date/status filter.' }] };

        let out = '';
        for (const m of matches) out += `ID: ${m.id}, Title: ${m.title}, State: ${m.state}, Date: ${m.date}\n`;

        return { content: [{ type: 'text', text: out }], json: { query, start, end, status, matches } } as unknown as CallToolResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Error filtering work items: ${msg}` }] };
      }
    }
  );

  // Tool: fetch a single work item by numeric ID (fields, relations, and comments)
  const getWorkItemByIdSchema = z.object({
    id: z.number().describe('Numeric work item ID to fetch')
  });

  server.tool(
    'getWorkItemById',
    'Fetch a single work item by ID, including fields, relations, and comments.',
    getWorkItemByIdSchema.shape,
    async (args, context: RequestHandlerExtra<any, any>) => {
      const { id } = args as { id: number };
      try {
        if (!id || typeof id !== 'number') return { isError: true, content: [{ type: 'text', text: 'Invalid or missing work item id.' }] };

        const org = process.env.AZDO_ORG_NAME || process.env.AZDO_ORG_URL || 'ustest123';
        const project = process.env.AZDO_PROJECT || 'USDevOpsProject';
        const apiVersion = '7.1-preview';

        // Fetch work item full details (fields + relations)
        const singleUrl = `https://dev.azure.com/${org}/_apis/wit/workitems/${id}?api-version=${apiVersion}&$expand=all`;
        const singleResult = await makeApiCall('GET', singleUrl, null, async (n:any) => { await safeNotification(context, n); });
        if (singleResult.isError) return singleResult;
        const singleJson = (singleResult as any).json ?? JSON.parse(String(singleResult.content?.[0]?.text || '{}'));
        if (!singleJson) return { isError: true, content: [{ type: 'text', text: `Work item ${id} not found.` }] };

        // Fetch comments for the work item
        let commentsCombined = '';
        try {
          const commentsUrl = `https://dev.azure.com/${org}/${project}/_apis/wit/workItems/${id}/comments?api-version=${apiVersion}`;
          const commentsResult = await makeApiCall('GET', commentsUrl, null, async (n:any) => { await safeNotification(context, n); });
          if (!commentsResult.isError) {
            const commentsJson = (commentsResult as any).json ?? JSON.parse(String(commentsResult.content?.[0]?.text || '{}'));
            const commentsArr = commentsJson.comments || [];
            commentsCombined = commentsArr.map((c: any) => c.text || '').join('\n---\n');
          }
        } catch (e) {
          // ignore comment fetch errors
        }

        // Build a concise readable summary
        const title = singleJson.fields?.['System.Title'] || 'NO TITLE';
        const state = singleJson.fields?.['System.State'] || 'NO STATE';
        const assignedTo = singleJson.fields?.['System.AssignedTo']?.displayName || singleJson.fields?.['System.AssignedTo'] || '';
        const created = singleJson.fields?.['System.CreatedDate'] || '';
        const changed = singleJson.fields?.['System.ChangedDate'] || '';

        let summary = `ID: ${id}, Title: ${title}, State: ${state}\nAssignedTo: ${assignedTo}\nCreated: ${created}\nChanged: ${changed}\n`;
        if (singleJson.fields?.['System.Description']) {
          summary += `\nDescription:\n${stripHtmlAndNormalize(singleJson.fields['System.Description'])}\n`;
        }
        if (commentsCombined) summary += `\nComments:\n${extractExcerpt(commentsCombined, '', 1000)}\n`;

        // Return structured JSON plus readable summary text
        return { content: [{ type: 'text', text: summary }], json: { workItem: singleJson, commentsText: commentsCombined } } as unknown as CallToolResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Error fetching work item ${id}: ${msg}` }] };
      }
    }
  );

  return server;
};

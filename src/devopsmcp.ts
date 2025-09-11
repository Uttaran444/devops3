import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as azdev from 'azure-devops-node-api';
import { IWorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
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

  server.tool(
    'getWorkItemListByType',
    'Fetches a list of work items by type from Azure DevOps.',
    getWorkItemListByTypeSchema.shape,
    async (args, context: RequestHandlerExtra<any, any>) => {
      const { workItemType } = args;
      try {
        const orgUrl = process.env.AZDO_ORG_URL || 'https://dev.azure.com/ustest123';
        const token = process.env.AZDO_PAT || 'AbE71tjONPUvmKHWvJjl9pNDiW7PjpDMd5hmCck3NkwvXUOfcSdUJQQJ99BIACAAAAAMF3UqAAASAZDOMdch';
        const project = process.env.AZDO_PROJECT || 'USDevOpsProject';

        const authHandler = azdev.getPersonalAccessTokenHandler(token);
        const connection = new azdev.WebApi(orgUrl, authHandler);
        const witApi: IWorkItemTrackingApi = await connection.getWorkItemTrackingApi();

        const wiqlQuery = {
          query: `
            SELECT [System.Id], [System.Title], [System.State]
            FROM WorkItems
            WHERE [System.WorkItemType] = '${workItemType}'
            AND [System.TeamProject] = '${project}'
            ORDER BY [System.ChangedDate] DESC
          `
        };

        const result = await witApi.queryByWiql(wiqlQuery);
        const ids = result.workItems ? result.workItems.map(item => item.id).filter((id): id is number => id !== undefined) : [];

        let workItemsLog = '';
        if (ids.length === 0) {
          workItemsLog = `No ${workItemType} work items found.`;
        } else {
          const workItems = await witApi.getWorkItems(ids);
          workItems.forEach(item => {
            let logMsg = '';
            if (item.fields) {
              logMsg = `ID: ${item.id}, Title: ${item.fields['System.Title']}, State: ${item.fields['System.State']}`;
            } else {
              logMsg = `ID: ${item.id}, fields are undefined.`;
            }
            workItemsLog += logMsg + '\n';
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: workItemsLog,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching data ...`,
            },
          ],
        };
      }
    }
  );

  return server;
};
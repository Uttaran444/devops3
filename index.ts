import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as azdev from 'azure-devops-node-api';
import * as WorkItemTrackingApi from 'azure-devops-node-api/WorkItemTrackingApi';

import 'dotenv/config'


  const server = new McpServer({
    name: "Azure Devops MCP Server",
    version: "1.0.0",
  });
/**/
server.tool(
  "getWorkItemListByType",
  {
    workItemType: z.string().describe("work item type like Bug, Task, User Story"),
  },
  async ({ workItemType }, _extra) => {
    try { 
      const orgUrl = 'https://dev.azure.com/ustest123';
      const token = 'AbE71tjONPUvmKHWvJjl9pNDiW7PjpDMd5hmCck3NkwvXUOfcSdUJQQJ99BIACAAAAAMF3UqAAASAZDOMdch';
      const project = 'USDevOpsProject';

      const authHandler = azdev.getPersonalAccessTokenHandler(token);
      const connection = new azdev.WebApi(orgUrl, authHandler);
      const witApi: WorkItemTrackingApi.IWorkItemTrackingApi = await connection.getWorkItemTrackingApi();

      const wiqlQuery1 = {
        query: `
          SELECT [System.Id], [System.Title], [System.State]
          FROM WorkItems
          WHERE [System.WorkItemType] = '${workItemType}'
          AND [System.TeamProject] = '${project}'
          ORDER BY [System.ChangedDate] DESC
        `
      };

      const result = await witApi.queryByWiql(wiqlQuery1);
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
            type: "text",
            text: `${workItemsLog}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching data ...`,
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();

await server.connect(transport);

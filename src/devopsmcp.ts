import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';


const DEFAULT_PAGE_SIZE = 5;

// Helper function to safely send notifications
async function safeNotification(context: RequestHandlerExtra<ServerRequest, ServerNotification>, notification: any): Promise<void> {
    try {
        await context.sendNotification(notification);
    } catch (error) {
        console.log('Notification failed (this is normal in test environments):', error);
    }
}



const createCustomerSchema = z.object({
    customerData: z.record(z.unknown()).describe("A JSON object for the new customer. Must include dataAreaId, CustomerAccount, etc."),
});




const getProductionOrderDefaultValuesSchema = z.object({
    ProductionOrderDefaultData: z.record(z.unknown()).describe("A JSON object to get default values for production order. Must include _itemId, _inventSiteId, _inventLocationId, _qtySched"),
});


export const getServer = (): McpServer => {
    const server = new McpServer({
        name: 'd365-fno-mcp-server',
        version: '1.0.0',
    });

    // --- Tool Definitions ---

    
      server.tool(
        'productionOrderDefaultValues',
        'Get default values to create production order.',
        getProductionOrderDefaultValuesSchema.shape,
        async ({ ProductionOrderDefaultData }: z.infer<typeof getProductionOrderDefaultValuesSchema>, context: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
            const url = `${process.env.DYNAMICS_RESOURCE_URL}/api/services/IGDProdOrderServiceGroup/IGDProdOrderService/getdefaultproductionordervalues`;
            return makeApiCall('POST', url, ProductionOrderDefaultData as Record<string, unknown>, async (notification) => {
                await safeNotification(context, notification);
            });
        }
    );

    return server;
};













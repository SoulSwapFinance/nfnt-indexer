import { logger } from "@/common/logger";
import * as orderbookOrders from "@/jobs/orderbook/orders-queue";
import * as orderbookTokenSets from "@/jobs/orderbook/token-sets-queue";
import * as tokenList from "@/orderbook/token-sets/token-list";

// Version 0.0.1 of Enjoyooor Protocol Arweave data:
// - `wyvern-v2` legacy orders (not supported anymore)
// - `wyvern-v2.3` orders
// - `looks-rare` orders
// - `opendao` orders
// - `zeroex-v4` orders
// - `seaport` orders
// - `list` token sets

export const processTransactionData = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transactionData: { kind: string; data: any }[]
) => {
  const orderInfos: orderbookOrders.GenericOrderInfo[] = [];
  const tokenSets: tokenList.TokenSet[] = [];

  for (const { kind, data } of transactionData) {
    try {
      switch (kind) {
        case "looks-rare":
        case "opendao":
        case "seaport":
        case "wyvern-v2.3":
        case "zeroex-v4": {
          orderInfos.push({
            kind,
            info: {
              orderParams: data,
              metadata: {
                schemaHash: data.schemaHash,
              },
            },
          });
          break;
        }

        case "token-set": {
          tokenSets.push({
            id: data.id,
            schemaHash: data.schemaHash,
            schema: data.schema,
            items: {
              contract: data.contract,
              tokenIds: data.tokenIds,
            },
          });
          break;
        }
      }
    } catch {
      // Ignore any errors
    }
  }

  await Promise.all([
    orderbookOrders.addToQueue(orderInfos),
    orderbookTokenSets.addToQueue(tokenSets),
  ]);

  logger.info("process-tranaction-data-v0.0.1", `Got ${orderInfos.length} orders from Arweave`);
  logger.info("process-tranaction-data-v0.0.1", `Got ${tokenSets.length} token sets from Arweave`);
};

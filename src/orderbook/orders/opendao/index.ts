import { AddressZero } from "@ethersproject/constants";
import * as Sdk from "@reservoir0x/sdk";
import pLimit from "p-limit";

import { idb, pgp } from "@/common/db";
import { logger } from "@/common/logger";
import { bn, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import * as arweaveRelay from "@/jobs/arweave-relay";
import * as ordersUpdateById from "@/jobs/order-updates/by-id-queue";
import * as commonHelpers from "@/orderbook/orders/common/helpers";
import { DbOrder, OrderMetadata, generateSchemaHash } from "@/orderbook/orders/utils";
import { offChainCheck } from "@/orderbook/orders/opendao/check";
import * as tokenSet from "@/orderbook/token-sets";

export type OrderInfo = {
  orderParams: Sdk.OpenDao.Types.BaseOrder;
  metadata: OrderMetadata;
};

type SaveResult = {
  id: string;
  status: string;
};

export const save = async (
  orderInfos: OrderInfo[],
  relayToArweave?: boolean
): Promise<SaveResult[]> => {
  const results: SaveResult[] = [];
  const orderValues: DbOrder[] = [];

  const arweaveData: {
    order: Sdk.OpenDao.Order;
    schemaHash?: string;
    source?: string;
  }[] = [];

  const handleOrder = async ({ orderParams, metadata }: OrderInfo) => {
    try {
      const order = new Sdk.OpenDao.Order(config.chainId, orderParams);
      const id = order.hash();

      // Check: order doesn't already exist
      const orderExists = await idb.oneOrNone(`SELECT 1 FROM orders WHERE orders.id = $/id/`, {
        id,
      });
      if (orderExists) {
        return results.push({
          id,
          status: "already-exists",
        });
      }

      // Handle: get order kind
      const kind = await commonHelpers.getContractKind(order.params.nft);
      if (!kind) {
        return results.push({
          id,
          status: "unknown-order-kind",
        });
      }

      // Check: order has unique nonce
      if (kind === "erc1155") {
        // For erc1155, enforce uniqueness of maker/nonce.
        const nonceExists = await idb.oneOrNone(
          `
            SELECT 1 FROM orders
            WHERE order_kind = 'opendao-erc1155'
              AND orders.maker = $/maker/
              AND orders.nonce = $/nonce/
          `,
          {
            maker: toBuffer(order.params.maker),
            nonce: order.params.nonce,
          }
        );
        if (nonceExists) {
          return results.push({
            id,
            status: "duplicated-nonce",
          });
        }
      } else {
        // For erc721, enforce uniqueness of maker/nonce/contract/price.
        const nonceExists = await idb.oneOrNone(
          `
            SELECT 1 FROM orders
            WHERE order_kind = 'opendao-erc721'
              AND orders.maker = $/maker/
              AND orders.nonce = $/nonce/
              AND orders.contract = $/contract/
              AND orders.price = $/price/
          `,
          {
            maker: toBuffer(order.params.maker),
            nonce: order.params.nonce,
            contract: toBuffer(order.params.nft),
            price: order.params.erc20TokenAmount,
          }
        );
        if (nonceExists) {
          return results.push({
            id,
            status: "duplicated-nonce",
          });
        }
      }

      const currentTime = Math.floor(Date.now() / 1000);

      // Check: order is not expired
      const expirationTime = order.params.expiry;
      if (currentTime >= expirationTime) {
        return results.push({
          id,
          status: "expired",
        });
      }

      // Check: buy order has Weth as payment token
      if (
        order.params.direction === Sdk.OpenDao.Types.TradeDirection.BUY &&
        order.params.erc20Token !== Sdk.Common.Addresses.Weth[config.chainId]
      ) {
        return results.push({
          id,
          status: "unsupported-payment-token",
        });
      }

      // Check: sell order has Eth as payment token
      if (
        order.params.direction === Sdk.OpenDao.Types.TradeDirection.BUY &&
        order.params.erc20Token !== Sdk.OpenDao.Addresses.Eth[config.chainId]
      ) {
        return results.push({
          id,
          status: "unsupported-payment-token",
        });
      }

      // Check: order is not private
      if (order.params.taker !== AddressZero) {
        return results.push({
          id,
          status: "unsupported-taker",
        });
      }

      // Check: order is valid
      try {
        order.checkValidity();
      } catch {
        return results.push({
          id,
          status: "invalid",
        });
      }

      // Check: order has a valid signature
      try {
        order.checkSignature();
      } catch {
        return results.push({
          id,
          status: "invalid-signature",
        });
      }

      // Check: order fillability
      let fillabilityStatus = "fillable";
      let approvalStatus = "approved";
      try {
        await offChainCheck(order);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        // Keep any orders that can potentially get valid in the future
        if (error.message === "no-balance-no-approval") {
          fillabilityStatus = "no-balance";
          approvalStatus = "no-approval";
        } else if (error.message === "no-approval") {
          approvalStatus = "no-approval";
        } else if (error.message === "no-balance") {
          fillabilityStatus = "no-balance";
        } else {
          logger.info("debug", `error: ${error}`);
          return results.push({
            id,
            status: "not-fillable",
          });
        }
      }

      // Check and save: associated token set
      let tokenSetId: string | undefined;
      const schemaHash = metadata.schemaHash ?? generateSchemaHash(metadata.schema);

      switch (order.params.kind) {
        // TODO: Add support for contract/range orders
        // case "contract-wide": {
        //   [{ id: tokenSetId }] = await tokenSet.contractWide.save([
        //     {
        //       id: `contract:${order.params.collection}`,
        //       schemaHash,
        //       contract: order.params.collection,
        //     },
        //   ]);

        //   break;
        // }

        case "erc721-single-token":
        case "erc1155-single-token": {
          [{ id: tokenSetId }] = await tokenSet.singleToken.save([
            {
              id: `token:${order.params.nft}:${order.params.nftId}`,
              schemaHash,
              contract: order.params.nft,
              tokenId: order.params.nftId,
            },
          ]);

          break;
        }
      }

      if (!tokenSetId) {
        return results.push({
          id,
          status: "invalid-token-set",
        });
      }

      // Handle: fees
      const feeAmount = order.getFeeAmount();

      const side = order.params.direction === Sdk.OpenDao.Types.TradeDirection.BUY ? "buy" : "sell";

      // Handle: price and value
      let price = bn(order.params.erc20TokenAmount).add(feeAmount);
      let value = price;
      if (side === "buy") {
        // For buy orders, we set the value as `price - fee` since it
        // is best for UX to show the user exactly what they're going
        // to receive on offer acceptance.
        value = bn(price).sub(feeAmount);
      }

      // The price and value are for a single item
      if (order.params.kind?.startsWith("erc1155")) {
        price = price.div(order.params.nftAmount!);
        value = value.div(order.params.nftAmount!);
      }

      const feeBps = feeAmount.mul(10000).div(price);
      if (feeBps.gt(10000)) {
        return results.push({
          id,
          status: "fees-too-high",
        });
      }

      // Handle: source and fees breakdown
      const source = metadata.source ?? Sdk.OpenDao.Addresses.Exchange[config.chainId];
      const feeBreakdown = order.params.fees.map(({ recipient, amount }) => ({
        kind: "royalty",
        recipient,
        bps: bn(amount).mul(10000).div(price).toNumber(),
      }));

      const validFrom = `date_trunc('seconds', to_timestamp(0))`;
      const validTo = `date_trunc('seconds', to_timestamp(${order.params.expiry}))`;
      orderValues.push({
        id,
        kind: `opendao-${kind}`,
        side,
        fillability_status: fillabilityStatus,
        approval_status: approvalStatus,
        token_set_id: tokenSetId,
        token_set_schema_hash: toBuffer(schemaHash),
        maker: toBuffer(order.params.maker),
        taker: toBuffer(AddressZero),
        price: price.toString(),
        value: value.toString(),
        quantity_remaining: order.params.nftAmount,
        valid_between: `tstzrange(${validFrom}, ${validTo}, '[]')`,
        nonce: order.params.nonce,
        source_id: source ? toBuffer(source) : null,
        contract: toBuffer(order.params.nft),
        fee_bps: feeBps.toNumber(),
        fee_breakdown: feeBreakdown || null,
        dynamic: null,
        raw_data: order.params,
        expiration: validTo,
      });

      results.push({
        id,
        status: "success",
      });

      if (relayToArweave) {
        arweaveData.push({ order, schemaHash, source });
      }
    } catch (error) {
      logger.error(
        "orders-opendao-save",
        `Failed to handle order with params ${JSON.stringify(orderParams)}: ${error}`
      );
    }
  };

  // Process all orders concurrently
  const limit = pLimit(20);
  await Promise.all(orderInfos.map((orderInfo) => limit(() => handleOrder(orderInfo))));

  if (orderValues.length) {
    const columns = new pgp.helpers.ColumnSet(
      [
        "id",
        "kind",
        "side",
        "fillability_status",
        "approval_status",
        "token_set_id",
        "token_set_schema_hash",
        "maker",
        "taker",
        "price",
        "value",
        "quantity_remaining",
        { name: "valid_between", mod: ":raw" },
        "nonce",
        "source_id",
        "contract",
        "fee_bps",
        { name: "fee_breakdown", mod: ":json" },
        "dynamic",
        "raw_data",
        { name: "expiration", mod: ":raw" },
      ],
      {
        table: "orders",
      }
    );
    await idb.none(pgp.helpers.insert(orderValues, columns) + " ON CONFLICT DO NOTHING");

    await ordersUpdateById.addToQueue(
      results
        .filter((r) => r.status === "success")
        .map(
          ({ id }) =>
            ({
              context: `new-order-${id}`,
              id,
              trigger: {
                kind: "new-order",
              },
            } as ordersUpdateById.OrderInfo)
        )
    );

    if (relayToArweave) {
      await arweaveRelay.addPendingOrdersOpenDao(arweaveData);
    }
  }

  return results;
};
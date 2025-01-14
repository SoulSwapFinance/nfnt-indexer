import { idb, redb } from "@/common/db";
import { fromBuffer, toBuffer } from "@/common/utils";

export type Block = {
  hash: string;
  number: number;
};

export const saveBlock = async (block: Block): Promise<Block> => {
  await idb.none(
    `
      INSERT INTO blocks (
        hash,
        number
      ) VALUES (
        $/hash/,
        $/number/
      )
      ON CONFLICT DO NOTHING
    `,
    {
      hash: toBuffer(block.hash),
      number: block.number,
    }
  );

  return block;
};

export const deleteBlock = async (number: number, hash: string) =>
  idb.none(
    `
      DELETE FROM blocks
      WHERE blocks.hash = $/hash/
        AND blocks.number = $/number/
    `,
    {
      hash: toBuffer(hash),
      number,
    }
  );

export const getBlocks = async (number: number): Promise<Block[]> =>
  redb
    .manyOrNone(
      `
        SELECT
          blocks.hash
        FROM blocks
        WHERE blocks.number = $/number/
      `,
      { number }
    )
    .then((result) =>
      result.map(({ hash }) => ({
        hash: fromBuffer(hash),
        number,
      }))
    );

import { MongoClient, type Collection, type Db } from "mongodb";
import type { AdminUserDocument } from "../auth/types.js";
import type { CardDocument, PackDocument } from "../protocol/types.js";

export interface CardCollections {
  db: Db;
  cards: Collection<CardDocument>;
  packs: Collection<PackDocument>;
  adminUsers: Collection<AdminUserDocument>;
  loadActiveCards: () => Promise<CardDocument[]>;
  loadActivePacks: () => Promise<PackDocument[]>;
  close: () => Promise<void>;
}

export async function connectCardRepository(uri: string, database: string): Promise<CardCollections> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(database);
  const cards = db.collection<CardDocument>("cards");
  const packs = db.collection<PackDocument>("packs");
  const adminUsers = db.collection<AdminUserDocument>("adminUsers");
  await Promise.all([
    cards.createIndex({ active: 1, games: 1, pack: 1 }),
    cards.createIndex({ enNorm: 1 }, { unique: true, partialFilterExpression: { enNorm: { $type: "string" } } }),
    cards.createIndex({ arNorm: 1 }, { unique: true, partialFilterExpression: { arNorm: { $type: "string" } } }),
    adminUsers.createIndex({ username: 1 }, { unique: true }),
  ]);
  return {
    db,
    cards,
    packs,
    adminUsers,
    loadActiveCards: () => cards.find({ active: true }).toArray(),
    loadActivePacks: () => packs.find({ active: true }).toArray(),
    close: () => client.close(),
  };
}

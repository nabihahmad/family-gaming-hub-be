import { config } from "../config.js";
import { connectCardRepository } from "../cards/repo.js";
import { hashPassword } from "./password.js";

async function seedAdmin(): Promise<void> {
  const repository = await connectCardRepository(config.mongoUri, config.mongoDb);
  try {
    const username = config.adminUsername;
    const { salt, hash } = await hashPassword(config.adminPassword);
    const now = new Date();
    await repository.adminUsers.updateOne(
      { _id: "admin" },
      {
        $set: { username, passwordSalt: salt, passwordHash: hash, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    console.log(`Seeded admin user "${username}".`);
  } finally {
    await repository.close();
  }
}

seedAdmin().catch(() => {
  console.error("Admin seeding failed.");
  process.exitCode = 1;
});

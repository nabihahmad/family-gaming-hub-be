import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/AuthService.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import type { AdminUserDocument } from "../src/auth/types.js";

async function createAuth() {
  const credentials = await hashPassword("test-admin-password-123");
  const user: AdminUserDocument = {
    _id: "admin",
    username: "admin",
    passwordSalt: credentials.salt,
    passwordHash: credentials.hash,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return new AuthService(async (username) => (username === user.username ? user : null));
}

describe("admin authentication", () => {
  it("hashes passwords and verifies them without storing plaintext", async () => {
    const stored = await hashPassword("family-game-secret");
    expect(stored.hash).not.toBe("family-game-secret");
    await expect(verifyPassword("family-game-secret", stored.salt, stored.hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-secret", stored.salt, stored.hash)).resolves.toBe(false);
  });

  it("invalidates guest sessions and connected sockets when the admin logs out", async () => {
    const auth = await createAuth();
    const admin = await auth.login("ADMIN", "test-admin-password-123");
    expect(admin.accessCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const guest = auth.redeemAccessCode(admin.accessCode);
    const adminSession = auth.authenticate(admin.accessToken);
    const guestSession = auth.authenticate(guest.accessToken);
    const close = vi.fn();
    const socket = { close } as unknown as WebSocket;
    auth.registerSocket(guestSession, socket);

    auth.logout(adminSession);

    expect(close).toHaveBeenCalledWith(4003, "Access revoked");
    expect(() => auth.authenticate(admin.accessToken)).toThrow();
    expect(() => auth.authenticate(guest.accessToken)).toThrow();
    expect(() => auth.redeemAccessCode(admin.accessCode)).toThrow();
  });

  it("rejects incorrect admin credentials", async () => {
    const auth = await createAuth();
    await expect(auth.login("admin", "incorrect-password")).rejects.toThrow();
  });
});

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type WebSocket from "ws";
import type { AdminUserDocument, AccessRole, AccessSession, PublicSession } from "./types.js";
import { verifyPassword } from "./password.js";
import { HttpError } from "../util/errors.js";

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const accessCodeLength = 8;
const dummySalt = "family-games-auth-dummy-salt";
const dummyHash = Buffer.alloc(64).toString("base64url");

interface AccessGrant {
  id: string;
  userId: string;
  code: string;
  codeHash: Buffer;
  sessions: Set<string>;
}

export class AuthService {
  private readonly sessions = new Map<string, AccessSession>();
  private grant: AccessGrant | null = null;

  constructor(private readonly findAdminByUsername: (username: string) => Promise<AdminUserDocument | null>) {}

  async login(username: string, password: string): Promise<{ accessToken: string; accessCode: string }> {
    const normalizedUsername = username.trim().toLocaleLowerCase();
    const user = await this.findAdminByUsername(normalizedUsername);
    const valid = await verifyPassword(password, user?.passwordSalt ?? dummySalt, user?.passwordHash ?? dummyHash);
    if (!user || !valid) throw new HttpError(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");

    this.revokeGrant();
    const code = Array.from({ length: accessCodeLength }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join("");
    const grant: AccessGrant = {
      id: randomUUID(),
      userId: user._id,
      code,
      codeHash: hash(code),
      sessions: new Set(),
    };
    this.grant = grant;
    const accessToken = this.createSession("admin", user._id, grant.id);
    return { accessToken, accessCode: code };
  }

  redeemAccessCode(code: string): { accessToken: string } {
    const grant = this.grant;
    const supplied = hash(code.trim().toUpperCase());
    if (!grant || supplied.length !== grant.codeHash.length || !timingSafeEqual(supplied, grant.codeHash)) {
      throw new HttpError(401, "INVALID_ACCESS_CODE", "The access code is invalid or has expired.");
    }
    return { accessToken: this.createSession("guest", randomUUID(), grant.id) };
  }

  authenticate(token: string | undefined): AccessSession {
    if (!token) throw new HttpError(401, "UNAUTHORIZED", "A valid access session is required.");
    const session = this.sessions.get(hash(token).toString("hex"));
    if (!session || !this.grant || session.grantId !== this.grant.id) {
      throw new HttpError(401, "SESSION_EXPIRED", "Your access session has expired.");
    }
    return session;
  }

  isActive(session: AccessSession): boolean {
    return this.sessions.get(session.tokenHash) === session && this.grant?.id === session.grantId;
  }

  publicSession(session: AccessSession): PublicSession {
    const accessCode = this.grant?.code;
    return session.role === "admin" && accessCode ? { role: "admin", accessCode } : { role: session.role };
  }

  registerSocket(session: AccessSession, socket: WebSocket): void {
    session.sockets.add(socket);
  }

  unregisterSocket(session: AccessSession, socket: WebSocket): void {
    session.sockets.delete(socket);
  }

  logout(session: AccessSession): void {
    if (session.role === "admin") {
      this.revokeGrant();
      return;
    }
    this.revokeSession(session.tokenHash);
  }

  private createSession(role: AccessRole, userId: string, grantId: string): string {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hash(token).toString("hex");
    const session: AccessSession = { role, userId, grantId, tokenHash, sockets: new Set() };
    this.sessions.set(tokenHash, session);
    this.grant?.sessions.add(tokenHash);
    return token;
  }

  private revokeGrant(): void {
    if (!this.grant) return;
    for (const tokenHash of this.grant.sessions) this.revokeSession(tokenHash);
    this.grant = null;
  }

  private revokeSession(tokenHash: string): void {
    const session = this.sessions.get(tokenHash);
    if (!session) return;
    this.sessions.delete(tokenHash);
    this.grant?.sessions.delete(tokenHash);
    for (const socket of session.sockets) socket.close(4003, "Access revoked");
    session.sockets.clear();
  }
}

export function getBearerToken(header: string | undefined): string | undefined {
  return /^Bearer ([A-Za-z0-9_-]{20,})$/i.exec(header ?? "")?.[1];
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

import type WebSocket from "ws";

export type AccessRole = "admin" | "guest";

export interface AdminUserDocument {
  _id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccessPrincipal {
  role: AccessRole;
  userId: string;
  grantId: string;
}

export interface AccessSession extends AccessPrincipal {
  tokenHash: string;
  sockets: Set<WebSocket>;
}

export interface PublicSession {
  role: AccessRole;
  accessCode?: string;
}

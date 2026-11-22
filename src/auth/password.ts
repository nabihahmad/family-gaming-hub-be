import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const saltBytes = 16;
const keyBytes = 64;

export interface PasswordHash {
  salt: string;
  hash: string;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(saltBytes).toString("base64url");
  const key = await deriveKey(password, salt);
  return { salt, hash: key.toString("base64url") };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await deriveKey(password, salt);
  const expected = Buffer.from(expectedHash, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyBytes, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

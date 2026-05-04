export const EXPIRES_IN_DAYS = 7;

const TOKEN_BYTES = 32; // 32 bytes → 43 base64url chars

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export function generateToken(): IssuedToken {
  const buf = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(buf);
  const token = base64url(buf);
  const expiresAt = new Date(Date.now() + EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

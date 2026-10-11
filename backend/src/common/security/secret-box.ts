import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM envelope for secrets stored in the database (for example TOTP seeds). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    this.key = createHash("sha256").update(`safry:secret-box:v1:${keyMaterial}`).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !body) throw new Error("Unsupported secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}

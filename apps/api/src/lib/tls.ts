import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generate } from "selfsigned";

export interface TlsMaterial {
  key: string;
  cert: string;
}

export interface TlsOptions {
  /** Eigene Zertifikatsdateien, z. B. von mkcert; haben Vorrang */
  certFile?: string;
  keyFile?: string;
  /** Ablage für das selbst signierte Zertifikat */
  selfSignedDir: string;
  log?: (message: string) => void;
}

/**
 * Liefert Schlüssel und Zertifikat für lokales HTTPS. Ohne eigene Dateien wird
 * einmalig ein selbst signiertes Zertifikat für localhost erzeugt und erneuert,
 * sobald es weniger als 30 Tage gültig ist.
 */
export async function loadTls({ certFile, keyFile, selfSignedDir, log = console.log }: TlsOptions): Promise<TlsMaterial> {
  if (certFile || keyFile) {
    if (!certFile || !keyFile) throw new Error("TLS_CERT_FILE und TLS_KEY_FILE müssen gemeinsam gesetzt werden");
    return { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") };
  }

  const certPath = join(selfSignedDir, "localhost-cert.pem");
  const keyPath = join(selfSignedDir, "localhost-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = await readFile(certPath, "utf8");
    const validTo = Date.parse(new X509Certificate(cert).validTo);
    if (validTo - Date.now() > 30 * 86_400_000) return { cert, key: await readFile(keyPath, "utf8") };
  }

  const pems = await generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: new Date(Date.now() + 365 * 86_400_000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });
  await mkdir(dirname(certPath), { recursive: true });
  await writeFile(certPath, pems.cert, "utf8");
  await writeFile(keyPath, pems.private, { encoding: "utf8", mode: 0o600 });
  log(`Selbst signiertes Zertifikat erzeugt: ${certPath}`);
  return { cert: pems.cert, key: pems.private };
}

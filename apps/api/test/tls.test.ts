import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTls } from "../src/lib/tls.js";

describe("loadTls", () => {
  it("erzeugt ein Zertifikat für localhost und verwendet es wieder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hef-tls-"));
    const first = await loadTls({ selfSignedDir: dir, log: () => {} });
    const cert = new X509Certificate(first.cert);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(cert.checkPrivateKey(createPrivateKey(first.key))).toBe(true);

    const second = await loadTls({ selfSignedDir: dir, log: () => {} });
    expect(second.cert).toBe(first.cert);
  }, 30_000);

  it("verlangt Zertifikat und Schlüssel gemeinsam", async () => {
    await expect(loadTls({ certFile: "cert.pem", selfSignedDir: "." })).rejects.toThrow("gemeinsam");
  });
});

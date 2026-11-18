// A small local stand-in for OCI Object Storage, for tests. The real OCI SDK talks to it (requests
// are signed as usual; the signature is not checked here). It implements the calls Teemly uses:
// get namespace, get bucket, put / head / get / delete object, with OCI's Content-MD5 and
// If-None-Match behaviour, and can inject failures (status codes, corrupted transfers).

import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export async function startFakeOci({ namespace = "teemlytest", bucket = "teemly-audio-test", publicAccess = "NoPublicAccess" } = {}) {
  const objects = new Map(); // object name -> { body, md5, meta, contentType, etag }
  const failures = []; // { op, status, times, corrupt? }
  const calls = [];
  const md5 = (b) => createHash("md5").update(b).digest("base64");
  const err = (res, status, code, message) => {
    res.writeHead(status, { "content-type": "application/json", "opc-request-id": "fake" });
    res.end(JSON.stringify({ code, message }));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const parts = url.pathname.split("/").map(decodeURIComponent); // ["", "n", ns, "b", bucket, "o", name...]
      const op = req.method === "PUT" ? "put" : req.method === "HEAD" ? "head" : req.method === "DELETE" ? "delete" : parts.length >= 7 ? "get" : "meta";
      calls.push({ op, path: url.pathname });
      const f = failures.find((x) => x.op === op && x.times > 0 && !x.corrupt);
      if (f) {
        f.times -= 1;
        return err(res, f.status, f.code ?? "ServiceUnavailable", "injected failure");
      }
      if (parts[1] !== "n") return err(res, 404, "NotFound", "unknown path");
      if (parts.length === 2 || (parts.length === 3 && !parts[2])) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(namespace));
      }
      if (parts[2] !== namespace || parts[3] !== "b" || parts[4] !== bucket) return err(res, 404, "BucketNotFound", "Either the bucket does not exist or you are not authorized");
      if (parts.length === 5) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ name: bucket, namespace, publicAccessType: publicAccess }));
      }
      const name = parts.slice(6).join("/");
      const obj = objects.get(name);
      if (req.method === "PUT") {
        let body = Buffer.concat(chunks);
        const corrupt = failures.find((x) => x.op === "put" && x.corrupt && x.times > 0);
        if (corrupt) {
          corrupt.times -= 1;
          body = Buffer.from(body);
          body[0] ^= 0xff; // bytes damaged in transit
        }
        if (req.headers["if-none-match"] === "*" && obj) return err(res, 412, "IfNoneMatchFailed", "object exists");
        if (req.headers["content-md5"] && req.headers["content-md5"] !== md5(body)) return err(res, 400, "InvalidDigest", "Content-MD5 mismatch");
        const meta = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("opc-meta-")).map(([k, v]) => [k.slice(9), v]));
        const etag = createHash("sha1").update(body).digest("hex");
        objects.set(name, { body, md5: md5(body), meta, contentType: req.headers["content-type"], etag });
        res.writeHead(200, { etag, "opc-content-md5": md5(body), "last-modified": new Date().toUTCString() });
        return res.end();
      }
      if (!obj) return err(res, 404, "ObjectNotFound", "object not found");
      const headers = {
        "content-length": obj.body.length,
        "content-md5": obj.md5,
        etag: obj.etag,
        "content-type": obj.contentType ?? "application/octet-stream",
        "last-modified": new Date().toUTCString(),
        ...Object.fromEntries(Object.entries(obj.meta).map(([k, v]) => [`opc-meta-${k}`, v])),
      };
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        return res.end();
      }
      if (req.method === "DELETE") {
        objects.delete(name);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(200, headers);
      return res.end(obj.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // A throwaway signing key (the SDK signs every request; the fake does not verify signatures).
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = path.join(os.tmpdir(), `teemly-fake-oci-${process.pid}.pem`);
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    namespace,
    bucket,
    keyPath,
    objects,
    calls,
    /** Fail the next `times` calls of `op` (put/get/head/delete/meta) with `status`. */
    fail(op, status, times = 1, code) {
      failures.push({ op, status, times, code });
    },
    /** Damage the bytes of the next `times` uploads in transit. */
    corruptNextUpload(times = 1) {
      failures.push({ op: "put", corrupt: true, times });
    },
    clearFailures() {
      failures.length = 0;
    },
    env() {
      return {
        STORAGE_PROVIDER: "oci",
        OCI_AUTH: "api_key",
        OCI_TENANCY_OCID: "ocid1.tenancy.oc1..faketenancy",
        OCI_USER_OCID: "ocid1.user.oc1..fakeuser",
        OCI_FINGERPRINT: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
        OCI_PRIVATE_KEY_PATH: keyPath,
        OCI_REGION: "ap-mumbai-1",
        OCI_NAMESPACE: namespace,
        OCI_BUCKET: bucket,
        OCI_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        OCI_RETRY_DELAY_MS: "10",
      };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

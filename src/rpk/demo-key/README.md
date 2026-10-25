# Public demo signing key — INTENTIONALLY PUBLIC, NOT A SECRET

`private.pem` (PKCS#8 RSA-2048) and `certificate.pem` (self-signed, CN "MiBand Hack PUBLIC demo key (insecure)",
valid until 2056) are committed on purpose. The web app bundles them so it can re-sign the Notes quick app in the
browser after swapping `common/notes.json` (`src/rpk/notes.ts`). `public/apps/notes.rpk` is signed with the same key,
so the toolkit-built package and every browser-rebuilt one carry the same certificate.

Anyone can sign anything with this key. It proves nothing about who built a package. Do not use it for any app
that needs a real signing identity (the Calculator uses its own private key in `demo-apps/calculator/sign/`, which is gitignored).

Regenerate only if you accept that already-installed Notes apps may refuse an update signed by the new certificate:

```bash
openssl req -newkey rsa:2048 -nodes -keyout private.pem -x509 -days 10950 \
  -out certificate.pem -subj "/CN=MiBand Hack PUBLIC demo key (insecure)"
```

Then rebuild `public/apps/notes.rpk` (`cd demo-apps/notes && npm run publish-demo`).
